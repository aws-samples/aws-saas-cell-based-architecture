import { Aspects, App } from 'aws-cdk-lib';
import { CellStack } from '../lib/CellStack';
import { CellTenantStack } from '../lib/CellTenantStack';
import { AwsSolutionsChecks } from 'cdk-nag'

const app = new App();

// Add the cdk-nag AwsSolutions Pack with extra verbose logging enabled.
Aspects.of(app).add(new AwsSolutionsChecks({verbose: true}));

// Read environment variables
const awsAccountId = process.env.AWS_ACCOUNT_ID;
const awsRegion = process.env.AWS_REGION;

const env = { account: awsAccountId, region: awsRegion };

const cellId = app.node.tryGetContext('cellId');
const cellSize = app.node.tryGetContext('cellSize');

// Create a new cell
new CellStack(app, `Cell-${cellId}`, { cellId, cellSize });

// Read tenantId, email and priorityBase from context
const tenantId = app.node.tryGetContext('tenantId');
const tenantEmail = app.node.tryGetContext('tenantEmail');
const priorityBase = app.node.tryGetContext('tenantListenerPriorityBase');
const productImageVersion = app.node.tryGetContext('productImageVersion');

// Check if tenantId is provided in context and instantiate TenantStack if it is
if (tenantId) {
  const stackName = `Cell-${cellId}-Tenant-${tenantId}`;
    new CellTenantStack(app, stackName, { cellId, tenantId, tenantEmail, priorityBase, productImageVersion, env });
}



