#!/usr/bin/env node
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects, App, Environment } from 'aws-cdk-lib';
import { CellManagementSystem } from '../lib/saas-management/cell-management-system/cell-management-system-stack';
import { CommonCellRouter } from '../lib/application-plane/common-components/cell-router/common-cell-router-stack';
import { CellProvisioningSystem } from '../lib/saas-management/cell-provisioning-system/cell-provisioning-system-stack';
import { CommonObservability } from '../lib/application-plane/common-components/observability/observability-stack';
import { Bridge } from '../lib/saas-management/bridge/bridge-stack';

//app = cdk.App(context={ "@aws-cdk/core:bootstrapQualifier": helper_functions.get_qualifier()} )
const app = new App();

/*
 * Add the cdk-nag AwsSolutions Pack with extra verbose logging enabled.
 *
 * Comment out this line to unblock deployment
 */
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))


/*
 * Create the components that bridge the SAAS control plane and
 * application plane. This includes the EventBridge EventBus, 
 * S3 bucket for application plane source archives and SSM Params
 */
let bridgeStack = new Bridge(app, 'Bridge', {
    description: "Contains integration components used for communication between the Cell Management System and the Cell Provisioning System.",
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
});

/**
 * Create the Common Cell Router components
 */
let cellRouterStack = new CommonCellRouter(app, 'CellRouter', {
    description: "Thinnest possible routing later, used for deterministic routing of api requests into individual cells.",
    env: { 
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: 'us-east-1' 
    },
});

/**
 * Common observability components
 */
let commonObservabilityStack = new CommonObservability(app, 'CommonObservability',{
    description: "Contains common observability resources for the solution",
    distributionId: cellRouterStack.distributionId,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
    crossRegionReferences: true
});

/**
 * Create the Cell Management system used for managing Cells and Tenants
 */
let cellManagementSystemStack = new CellManagementSystem(app, 'CellManagementSystem',{
    description: "Cell management system, used for creation and management of cells and tenants.",
    cellToTenantKvsArn: cellRouterStack.cellToTenantKvsArn,
    eventBusArn: bridgeStack.orchestrationEventBus.eventBusArn,
    versionSsmParameter: bridgeStack.imageVersionParam,
    crossRegionReferences: true,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
});

/**
 * Create the Cell Provisioning System used for deploying cells and tenants
 */
let cellProvisioningSystemStack = new CellProvisioningSystem(app, 'CellProvisioningSystem', {
    description: "Cell provisioning system, used for deployment of cells and tenants.",
    orchestrationBus: bridgeStack.orchestrationEventBus,
    cellManagementTable: cellManagementSystemStack.cellManagementTable,
    s3LoggingBucketArn: bridgeStack.s3LogBucketArn,
    s3CellSourceBucketArn: bridgeStack.cellSourceBucketArn,
    aggregateHttp5xxAlarmName: commonObservabilityStack.aggregateHttp5xxAlarmName,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
});