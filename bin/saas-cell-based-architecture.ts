#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';
import { CellManagementSystem } from '../lib/saas-management/cell-management-system/cell-management-system-stack';
import { CommonCellRouter } from '../lib/application-plane/common-components/cell-router/common-cell-router-stack';
import { CellProvisioningSystem } from '../lib/saas-management/cell-provisioning-system/cell-provisioning-system-stack';
import { CommonObservability } from '../lib/application-plane/common-components/observability/observability-stack';
import { Bridge } from '../lib/saas-management/bridge/bridge-stack';

const app = new App();

/*
 * Add the cdk-nag AwsSolutions Pack with extra verbose logging enabled.
 *
 * Comment out this line to unblock deployment
 */
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

/**
 * Common observability components
 */
let commonObservabilityStack = new CommonObservability(app, 'CommonObservability',{
    description: "Contains common observability resources for the solution"
});

/*
 * Create the components that bridge the SAAS control plane and
 * application plane. This includes the EventBridge EventBus, 
 * S3 bucket for application plane source archives and SSM Params
 */
let bridgeStack = new Bridge(app, 'Bridge', {
    description: "Contains integration components used for communication between the Cell Management System and the Cell Provisioning System.",
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn
});

/**
 * Create the Common Cell Router components
 */
let cellRouterStack = new CommonCellRouter(app, 'CellRouter', {
    description: "Thinnest possible routing later, used for deterministic routing of api requests into individual cells.",
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn
});

/**
 * Create the Cell Management system used for managing Cells and Tenants
 */
let cellManagementSystemStack = new CellManagementSystem(app, 'CellManagementSystem',{
    description: "Cell management system, used for creation and management of cells and tenants.",
    s3ConfigBucketName: cellRouterStack.s3ConfigBucketName,
    eventBusArn: bridgeStack.orchestrationEventBus.eventBusArn,
    versionSsmParameter: bridgeStack.imageVersionParam
});

/**
 * Create the Cell Provisioning System used for deploying cells and tenants
 */
let cellProvisioningSystemStack = new CellProvisioningSystem(app, 'CellProvisioningSystem', {
    description: "Cell provisioning system, used for deployment of cells and tenants.",
    orchestrationBus: bridgeStack.orchestrationEventBus,
    cellManagementTable: cellManagementSystemStack.cellManagementTable,
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn,
    s3CellSourceBucketArn: bridgeStack.cellSourceBucketArn,
    aggregateHttp5xxAlarmName: commonObservabilityStack.aggregateHttp5xxAlarmName
});



