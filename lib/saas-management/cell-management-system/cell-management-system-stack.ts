import { Stack, StackProps, RemovalPolicy, Tags, Duration, CfnOutput } from 'aws-cdk-lib';
import {
  AuthorizationType,
  IdentitySource,
  RestApi,
  TokenAuthorizer,
  LambdaIntegration,
  EndpointType,
  JsonSchemaVersion,
  JsonSchemaType,  
  MethodLoggingLevel,
  LogGroupLogDestination
} from 'aws-cdk-lib/aws-apigateway';
import { Table, AttributeType, BillingMode, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, EventBus } from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { LogGroup, RetentionDays} from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { IdentityProvider } from './identity-provider-construct';
import { LambdaFunction  } from '../src/lambda-function-construct';
import { KeyValueStore } from 'aws-cdk-lib/aws-cloudfront';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'

export interface CellManagementSystemStackProps extends StackProps
{
  readonly cellToTenantKvsArn: string;
  readonly eventBusArn: string;
  readonly versionSsmParameter: StringParameter;
}

export class CellManagementSystem extends Stack {
  readonly cellManagementTable: Table;

  constructor(scope: Construct, id: string, props: CellManagementSystemStackProps) {
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    Tags.of(this).add('SaaSApplicationService', 'CellManagementSystem');

    const identityProvider = new IdentityProvider(this, 'IdentityProvider');
    const idpDetails = identityProvider.identityDetails;

    const cellManagementBus = EventBus.fromEventBusArn(this, 'eventBus', props.eventBusArn);
    const cellToTenantKvs = KeyValueStore.fromKeyValueStoreArn(this, 'CellToTenantKvs', props.cellToTenantKvsArn);
    
    // Lambda function that processes requests from API Gateway to create a new Cell
    const authorizerLambda = new LambdaFunction(this, 'AuthorizerLambda', {
      friendlyFunctionName: 'AuthorizerFunction',
      index: 'controlPlaneAuthorizer.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/Authorizer', 
      handler: 'handler',         
      environmentVariables: {'IDP_DETAILS': JSON.stringify(idpDetails)}
    });

    const tokenAuthorizer = new TokenAuthorizer(this, 'ControlPlaneAuthorizer', {
      handler: authorizerLambda.lambdaFunction,
      identitySource: IdentitySource.header('Authorization'),
      resultsCacheTtl: Duration.seconds(30),
    });

    // Create DynamoDB Table for Cell Management
    const cellManagementTable = new Table(this, 'cellManagementTable', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Add Global Secondary Index
    cellManagementTable.addGlobalSecondaryIndex({
      indexName: 'TenantIDIndex',
      partitionKey: { name: 'tenant_id', type: AttributeType.STRING },
      // You can optionally add a sort key if needed
      // sortKey: { name: 'someOtherAttribute', type: dynamodb.AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ['cell_id', 'tenant_name', 'tenant_email', 'tenant_tier'],
    });

    cellManagementTable.addGlobalSecondaryIndex({
      indexName: 'TenantsByCellIdIndex',
      partitionKey: { name: 'cell_id', type: AttributeType.STRING },
      sortKey: { name: 'tenant_id', type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ['tenant_name', 'current_status'],
    });

    const restAPIAccessLogGroup = new LogGroup(this, 'APIGatewayAccessLogs', {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK,
    });

    /**
     * The API Gateway API for the control plane operations
     */
    const api = new RestApi(this, 'CellManagementApi', {
      deployOptions: {
        stageName: 'prod',
        loggingLevel: MethodLoggingLevel.ERROR,
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new LogGroupLogDestination(restAPIAccessLogGroup),
      },
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },      
      defaultMethodOptions: {      
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      },
      cloudWatchRole: true
    });

    /**
     * Start of createCell method and associated resources
     */
    const createCellRequestModel = api.addModel('CreateCellRequestModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Create Cell Request Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          CellName: {
            type: JsonSchemaType.STRING,
          },
          CellSize: {
            type: JsonSchemaType.STRING,
            enum: ['S', 'M', 'L']
          },
          WaveNumber: {
            type: JsonSchemaType.INTEGER,
            minimum: 1
          }
        },
        required: ['CellName','CellSize','WaveNumber'],
      },
    });
    
    // Lambda function that processes requests from API Gateway to create a new Cell
    const createCellLambda = new LambdaFunction(this, 'CreateCellFunction', {
      friendlyFunctionName: 'CreateCellFunction',
      index: 'createCell.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/CreateCell', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn,
                             'CELL_MANAGEMENT_BUS': cellManagementBus.eventBusName}
    })
    cellManagementTable.grantReadWriteData(createCellLambda.lambdaFunction);
    cellManagementBus.grantPutEventsTo(createCellLambda.lambdaFunction);

    const createCellResource = api.root.addResource("CreateCell");
    
    createCellResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    })

    // Create a method and associate the request model
    const createCellMethod = createCellResource.addMethod('POST',      
      new LambdaIntegration(createCellLambda.lambdaFunction),
      {
        requestModels: {
          'application/json': createCellRequestModel,
        },
        requestValidatorOptions: {
          validateRequestBody: true,
          validateRequestParameters: false,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      },
    );
    

    // Lambda function that processes requests from API Gateway to List existing Cells
    const listCellsLambda = new LambdaFunction(this, 'ListCellsFunction', {
      friendlyFunctionName: 'ListCellsFunction',
      index: 'listCells.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/ListCells', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}  
    });
    cellManagementTable.grantReadData(listCellsLambda.lambdaFunction);
    
    const listCellsResource = api.root.addResource("ListCells");

    listCellsResource.addCorsPreflight({
      allowOrigins: ['*'],
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'X-Amz-Date',
        'Authorization',
        'X-Api-Key',
        'X-Amz-Security-Token',
        'X-Amz-User-Agent',
      ],
    })

    // Create a method and associate the request model
    const listCellsMethod = listCellsResource.addMethod(
      'GET',
      new LambdaIntegration(listCellsLambda.lambdaFunction),
      {
        requestValidatorOptions: {
          validateRequestBody: false,
          validateRequestParameters: false,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );

    /**
     * Start of describeCell method and associated resources
     */
    
    // Lambda function that processes requests from API Gateway to Describe an existing Cell
    const describeCellLambda = new LambdaFunction(this, 'DescribeCellFunction', {
      friendlyFunctionName: 'DescribeCellFunction',
      index: 'describeCell.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/DescribeCell', 
      handler: 'handler',      
      environmentVariables: {
        'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn
      }
    })
    cellManagementTable.grantReadData(describeCellLambda.lambdaFunction); 

    const describeCellResource = api.root.addResource("DescribeCell");

    describeCellResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    })

    // Create a method and associate the request model for describe cell
    const describeCellMethod = describeCellResource.addMethod(
      'GET',
      new LambdaIntegration(describeCellLambda.lambdaFunction),
      {
        requestParameters: {
          'method.request.querystring.CellId': true,
        },
        requestValidatorOptions: {
          validateRequestBody: false,
          validateRequestParameters: true,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );

    // TODO: Complete the below code to deploy the updateCell stack..
    
    /**
     * Start of assignTenantToCell method and associated resources
     */
    const assignTenantToCellRequestModel = api.addModel('AssignTenantToCellRequestModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Assign Tenant To Cell Request Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          TenantName: {
            type: JsonSchemaType.STRING,
          },
          CellId: {
            type: JsonSchemaType.STRING,
          },
          TenantTier: {
            type: JsonSchemaType.STRING,
          },
          TenantEmail: {
            type: JsonSchemaType.STRING,
          },
        },
        required: ['TenantName','CellId', 'TenantTier', 'TenantEmail'],
      },
    });

    // Lambda function that processes requests from API Gateway to create a new Tenant
    const assignTenantToCellLambda = new LambdaFunction(this, 'AssignTenantToCellFunction', {
      friendlyFunctionName: 'AssignTenantToCell',
      index: 'assignTenantToCell.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/AssignTenantToCell', 
      handler: 'handler', 
      environmentVariables: {
        CELL_MANAGEMENT_TABLE: cellManagementTable.tableArn,
        CELL_MANAGEMENT_BUS: cellManagementBus.eventBusName,
        IMAGE_VER_SSM_PARAM_NAME: props.versionSsmParameter.parameterName
      },        
    });

    cellManagementTable.grantReadWriteData(assignTenantToCellLambda.lambdaFunction);
    cellManagementBus.grantPutEventsTo(assignTenantToCellLambda.lambdaFunction);

    const policyStatement = new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [props.versionSsmParameter.parameterArn],
    });
     assignTenantToCellLambda.lambdaFunction.addToRolePolicy(policyStatement);

    // Create a resource
    const assignTenantToCellResource = api.root.addResource('AssignTenantToCell');
    assignTenantToCellResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    })

    // Create a method and associate the request model
    const assignTenantToCellMethod = assignTenantToCellResource.addMethod(
      'POST',
      new LambdaIntegration(assignTenantToCellLambda.lambdaFunction),
      {
        requestModels: {
          'application/json': assignTenantToCellRequestModel,
        },
        requestValidatorOptions: {
          validateRequestBody: true,
          validateRequestParameters: false,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );

    /**
     * Start of describeTenant method and associated resources
     */    
    // Lambda function that processes requests from API Gateway to Describe an existing Cell
    const describeTenantLambda = new LambdaFunction(this, 'DescribeTenantFunction', {
      friendlyFunctionName: 'DescribeTenantFunction',
      index: 'describeTenant.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/DescribeTenant', 
      handler: 'handler',      
      environmentVariables: {
        'TENANT_MANAGEMENT_TABLE': cellManagementTable.tableArn
      }
    })
    cellManagementTable.grantReadData(describeTenantLambda.lambdaFunction); 

    const describeTenantResource = api.root.addResource("DescribeTenant");

    describeTenantResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    })

    // Create a method and associate the request model for describe tenant
    const describeTenantMethod = describeTenantResource.addMethod(
      'GET',
      new LambdaIntegration(describeTenantLambda.lambdaFunction),
      {
        requestParameters: {
          'method.request.querystring.CellId': true,
          'method.request.querystring.TenantId': true,
        },
        requestValidatorOptions: {
          validateRequestBody: false,
          validateRequestParameters: true,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );


    /**
     * Start of ListTenants method and associated resources
     */    
    // Lambda function that processes requests from API Gateway to List an existing Cell
    const listTenantsLambda = new LambdaFunction(this, 'ListTenantsFunction', {
      friendlyFunctionName: 'ListTenantsFunction',
      index: 'listTenants.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/ListTenants', 
      handler: 'handler',      
      environmentVariables: {
        'TENANT_MANAGEMENT_TABLE': cellManagementTable.tableArn
      }
    })
    cellManagementTable.grantReadData(listTenantsLambda.lambdaFunction); 

    const listTenantsResource = api.root.addResource("ListTenants");

    listTenantsResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    })

    // Create a method and associate the request model for list tenants
    const listTenantsMethod = listTenantsResource.addMethod(
      'GET',
      new LambdaIntegration(listTenantsLambda.lambdaFunction),
      {
        requestParameters: {
          'method.request.querystring.CellId': true,          
        },
        requestValidatorOptions: {
          validateRequestBody: false,
          validateRequestParameters: true,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );


    /**
     * Start of deactivateTenant method and associated resources
     */
    const deactivateTenantRequestModel = api.addModel('DeactivateTenantRequestModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Deactivate Tenant Request Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          TenantId: {
            type: JsonSchemaType.STRING,
          }
        },
        required: ['TenantId'],
      },
    });

    // Lambda function that processes requests from API Gateway to Deactive a Tenant
    const deactivateTenantLambda = new LambdaFunction(this, 'DeactivateTenantFunction', {
      friendlyFunctionName: 'DeactivateTenant',
      index: 'deactivateTenant.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/DeactivateTenant', 
      handler: 'handler', 
      environmentVariables: {
        "CELL_ROUTER_KVS_ARN": cellToTenantKvs.keyValueStoreArn,
      },        
    });

    deactivateTenantLambda.lambdaFunction.addToRolePolicy(new PolicyStatement({
      actions: ['cloudfront-keyvaluestore:DeleteKey','cloudfront-keyvaluestore:DescribeKeyValueStore'],
      resources: [cellToTenantKvs.keyValueStoreArn],
    }));

    // Create a resource
    const deactivateTenantResource = api.root.addResource('DeactivateTenant');
    deactivateTenantResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['PUT', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
    });

    // Create a method and associate the request model
    const deactivateTenantMethod = deactivateTenantResource.addMethod(
      'PUT',
      new LambdaIntegration(deactivateTenantLambda.lambdaFunction),
      {
        requestModels: {
          'application/json': deactivateTenantRequestModel,
        },
        requestValidatorOptions: {
          validateRequestBody: true,
          validateRequestParameters: false,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );

    /**
     * Start of activateTenant method and associated resources
     */
    const activateTenantRequestModel = api.addModel('ActivateTenantRequestModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Activate Tenant Request Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          TenantId: {
            type: JsonSchemaType.STRING,
          },
          CellId: {
            type: JsonSchemaType.STRING,
          }
        },
        required: ['TenantId','CellId'],
      },
    });

    // Lambda function that processes requests from API Gateway to create a new Tenant
    const activateTenantLambda = new LambdaFunction(this, 'ActivateTenantFunction', {
      friendlyFunctionName: 'ActivateTenant',
      index: 'activateTenant.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/ActivateTenant', 
      handler: 'handler', 
      environmentVariables: {
        CELL_MANAGEMENT_TABLE: cellManagementTable.tableArn,
        CELL_ROUTER_KVS_ARN: cellToTenantKvs.keyValueStoreArn
      },        
    });

    activateTenantLambda.lambdaFunction.addToRolePolicy(new PolicyStatement({
      actions: ['cloudfront-keyvaluestore:PutKey','cloudfront-keyvaluestore:DescribeKeyValueStore'],
      resources: [cellToTenantKvs.keyValueStoreArn],
    }));

    cellManagementTable.grantReadData(activateTenantLambda.lambdaFunction);

    // Create a resource
    const activateTenantResource = api.root.addResource('ActivateTenant');
    activateTenantResource.addCorsPreflight({
      allowOrigins: ['*'],
      allowMethods: ['PUT', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'X-Amz-Date',
        'Authorization',
        'X-Api-Key',
        'X-Amz-Security-Token',
        'X-Amz-User-Agent',
      ],
    });
    
    // Create a method and associate the request model
    const activateTenantMethod = activateTenantResource.addMethod(
      'PUT',
      new LambdaIntegration(activateTenantLambda.lambdaFunction),
      {
        requestModels: {
          'application/json': activateTenantRequestModel,
        },
        requestValidatorOptions: {
          validateRequestBody: true,
          validateRequestParameters: false,
        },
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: tokenAuthorizer,
      }
    );

    // Lambda function that monitors Cell Capacity
    const capacityObserverLambda = new LambdaFunction(this, 'CellCapacityObserverFunction', {
      friendlyFunctionName: 'CellCapacityObserverFunction',
      index: 'capacityObserver.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/CapacityObserver', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}
    });
    
    cellManagementTable.grantReadData(capacityObserverLambda.lambdaFunction);

    // Create an EventBridge rule that runs every minute
    const scheduledCapacityCheckRule = new Rule(this, 'ScheduleCapacityCheckRule', {
      schedule: Schedule.expression('rate(1 minute)'),
      enabled: true
    });

    scheduledCapacityCheckRule.addTarget(new targets.LambdaFunction(capacityObserverLambda.lambdaFunction));

    // Lambda function that persist metadata for Cells from EventBridge
    const persistCellMetadataLambda = new LambdaFunction(this, 'PersistCellMetadataFunction', {
      friendlyFunctionName: 'PersistCellMetadataFunction',
      index: 'persistCellMetadata.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/PersistCellMetadata', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}
    });
    
    cellManagementTable.grantWriteData(persistCellMetadataLambda.lambdaFunction);    


    // Create an EventBridge rule to process Metadata for Cells
    const persistCellMetadataRule = new Rule(this, 'PersistCellMetadataRule', {
      eventBus: cellManagementBus,
      eventPattern: {
        source: ['cellManagement.cellCreated','cellManagement.cellCreationError'],
        detailType: ['CellDetails'],
      },
    });

    persistCellMetadataRule.addTarget(new targets.LambdaFunction(persistCellMetadataLambda.lambdaFunction));

    /**
     * Start of Persist Tenant
     */
    // Lambda function that persist metadata for Tenants from EventBridge
    const persistTenantMetadataLambda = new LambdaFunction(this, 'PersistTenantMetadataFunction', {
      friendlyFunctionName: 'PersistTenantMetadataFunction',
      index: 'persistTenantMetadata.py',
      entry: 'lib/saas-management/cell-management-system/src/lambdas/PersistTenantMetadata', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}
    });
    cellManagementTable.grantReadWriteData(persistTenantMetadataLambda.lambdaFunction);


    // Create an EventBridge rule to process Metadata from Tenant creation
    const persistTenantMetadataRule = new Rule(this, 'PersistTenantMetadataRule', {
      eventBus: cellManagementBus,
      eventPattern: {
        source: ['cellManagement.tenantCreated','cellManagement.tenantCreationError'],
        detailType: ['TenantDetails'],
      },
    });

    persistTenantMetadataRule.addTarget(new targets.LambdaFunction(persistTenantMetadataLambda.lambdaFunction));

    this.cellManagementTable = cellManagementTable
    
    new CfnOutput(this, 'UserPoolId', {
      value: identityProvider.identityDetails.details['userPoolId'],
      exportName: 'UserPoolId',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: identityProvider.identityDetails.details['appClientId'],
      exportName: 'UserPoolClientId',
    });
    
  }
}
