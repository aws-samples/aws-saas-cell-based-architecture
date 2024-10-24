#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';
import { ControlPlaneStack } from '../lib/saas-management/control-plane/control-plane-stack';
import { CommonCellRouterStack } from '../lib/application-plane/common-components/cell-router/common-cell-router-stack';
import { AppPlaneOrchestratorStack } from '../lib/saas-management/app-plane-orchestrator/app-plane-orchestrator-stack';
import { CommonObservabilityStack } from '../lib/application-plane/common-components/observability/observability-stack';
import { BridgeStack } from '../lib/saas-management/bridge/bridge-stack';

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
let commonObservabilityStack = new CommonObservabilityStack(app, 'CommonObservabilityStack');

/*
 * Create the components that bridge the SAAS control plane and
 * application plane. This includes the EventBridge EventBus, 
 * S3 bucket for application plane source archives and SSM Params
 */
let bridgeStack = new BridgeStack(app, 'BridgeStack', {
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn
});

/**
 * Create the Common Cell Router components
 */
let cellRouter = new CommonCellRouterStack(app, 'CellRouterStack', {
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn
});

/**
 * Create the Control Plane used for managing Cells and Tenants
 */
let controlPlaneStack = new ControlPlaneStack(app, 'ControlPlaneStack',{
    s3ConfigBucketName: cellRouter.s3ConfigBucketName,
    eventBusArn: bridgeStack.orchestrationEventBus.eventBusArn,
    versionSsmParameter: bridgeStack.imageVersionParam
});

/**
 * Create the Application Plane Deployment Orchestrator
 */
let appPlaneOrchestrator = new AppPlaneOrchestratorStack(app, 'AppPlaneOrchestratorStack', {
    orchestrationBus: bridgeStack.orchestrationEventBus,
    cellManagementTable: controlPlaneStack.cellManagementTable,
    s3LoggingBucketArn: commonObservabilityStack.s3LogBucketArn,
    s3CellSourceBucketArn: bridgeStack.cellSourceBucketArn
});

