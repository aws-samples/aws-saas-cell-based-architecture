import { Stack, StackProps, RemovalPolicy, Tags, Duration, CfnOutput } from 'aws-cdk-lib';
import {
  AuthorizationType,
  IdentitySource,
  RestApi,
  TokenAuthorizer,
  LambdaIntegration,
  EndpointType,
  Model,
  JsonSchemaVersion,
  JsonSchemaType,  
  MethodLoggingLevel,
  LogGroupLogDestination
} from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { LogGroup, RetentionDays} from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { IdentityProvider } from './identity-provider-construct';
import { LambdaFunction  } from '../src/lambda-function-construct';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'

export interface ControlPlaneStackProps extends StackProps
{
  readonly s3ConfigBucketName: string;
  readonly eventBusArn: string;
  readonly versionSsmParameter: ssm.StringParameter;
}

export class ControlPlaneStack extends Stack {
  readonly cellManagementTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    Tags.of(this).add('SaaSApplicationService', 'ControlPlane');

    const identityProvider = new IdentityProvider(this, 'IdentityProvider');
    const idpDetails = identityProvider.identityDetails;

    const cellManagementBus = events.EventBus.fromEventBusArn(this, 'eventBus', props.eventBusArn);
    
    // Lambda function that processes requests from API Gateway to create a new Cell
    const authorizerLambda = new LambdaFunction(this, 'AuthorizerLambda', {
      friendlyFunctionName: 'AuthorizerFunction',
      index: 'controlPlaneAuthorizer.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/Authorizer', 
      handler: 'handler',         
      environmentVariables: {'IDP_DETAILS': JSON.stringify(idpDetails)}
    });

    const tokenAuthorizer = new TokenAuthorizer(this, 'ControlPlaneAuthorizer', {
      handler: authorizerLambda.lambdaFunction,
      identitySource: IdentitySource.header('Authorization'),
      resultsCacheTtl: Duration.seconds(30),
    });

    // Create DynamoDB Table for Cell Management
    const cellManagementTable = new dynamodb.Table(this, 'cellManagementTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Add Global Secondary Index
    cellManagementTable.addGlobalSecondaryIndex({
      indexName: 'TenantIDIndex',
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      // You can optionally add a sort key if needed
      // sortKey: { name: 'someOtherAttribute', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['cell_id', 'tenant_name', 'tenant_email', 'tenant_tier'],
    });

    const s3ConfigBucket = s3.Bucket.fromBucketName(this, 'requestRouterConfigBucket',props.s3ConfigBucketName)

    const restAPIAccessLogGroup = new LogGroup(this, 'APIGatewayAccessLogs', {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK,
    });

    /**
     * The API Gateway API for the control plane operations
     */
    const api = new RestApi(this, 'ControlPlaneApi', {
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
    });

    const controlPlaneApi = api.root.addResource("CellControlPlaneApi")

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
      entry: 'lib/saas-management/control-plane/src/lambdas/CreateCell', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn,
                             'CELL_MANAGEMENT_BUS': cellManagementBus.eventBusName}
    })
    cellManagementTable.grantReadWriteData(createCellLambda.lambdaFunction);
    cellManagementBus.grantPutEventsTo(createCellLambda.lambdaFunction);

    const createCellResource = controlPlaneApi.addResource("CreateCell");
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
      entry: 'lib/saas-management/control-plane/src/lambdas/ListCells', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}  
    });
    cellManagementTable.grantReadData(listCellsLambda.lambdaFunction);
    
    const listCellsResource = controlPlaneApi.addResource("ListCells");
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
    const describeCellRequestByCellIdModel = api.addModel('DescribeCellRequestByCellIdModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Describe Cell Request by CellId Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          CellId: {
            type: JsonSchemaType.STRING,
          }
        },
        required: ['CellId'],
      },
    });

    // Lambda function that processes requests from API Gateway to Describe an existing Cell
    const describeCellLambda = new LambdaFunction(this, 'DescribeCellFunction', {
      friendlyFunctionName: 'DescribeCellFunction',
      index: 'describeCell.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/DescribeCell', 
      handler: 'handler',      
      environmentVariables: {
        'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn
      }
    })
    cellManagementTable.grantReadData(describeCellLambda.lambdaFunction); 

    const describeCellResource = controlPlaneApi.addResource("DescribeCell");
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

    /**
     * Start of updateCell method and associated resources
     */
    const updateCellRequestModel = api.addModel('UpdateCellRequestModel', {
      contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: 'Update Cell Request Data Model',
        type: JsonSchemaType.OBJECT,
        properties: {
          CellId: {
            type: JsonSchemaType.STRING,
          },
          CellOperation: {
            type: JsonSchemaType.STRING,
            enum: ['CHANGE_SIZE','CELL_VERSION'],
          },
          CellConfiguration: {
            type: JsonSchemaType.STRING,
          }
        },
        required: ['CellId','CellOperation'],
      },
    });

    // Lambda function that processes requests from API Gateway to create a new Cell
    const updateCellLambda = new LambdaFunction(this, 'UpdateCellFunction', {
      friendlyFunctionName: 'UpdateCellFunction',
      index: 'updateCell.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/UpdateCell', 
      handler: 'handler',         
    })
    
    const updateCellResource = controlPlaneApi.addResource("UpdateCell");
    updateCellResource.addCorsPreflight({
      allowOrigins: ['*'],
        allowMethods: ['PUT', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ]
    })

    // Create a method and associate the request model
    const updateCellMethod = updateCellResource.addMethod(
      'PUT',
      new LambdaIntegration(updateCellLambda.lambdaFunction),
      {
        requestModels: {
          'application/json': updateCellRequestModel,
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
      entry: 'lib/saas-management/control-plane/src/lambdas/AssignTenantToCell', 
      handler: 'handler', 
      environmentVariables: {
        CELL_MANAGEMENT_TABLE: cellManagementTable.tableArn,
        CELL_MANAGEMENT_BUS: cellManagementBus.eventBusName,
        IMAGE_VER_SSM_PARAM_NAME: props.versionSsmParameter.parameterName
      },        
    });

    cellManagementTable.grantReadWriteData(assignTenantToCellLambda.lambdaFunction);
    cellManagementBus.grantPutEventsTo(assignTenantToCellLambda.lambdaFunction);

    const policyStatement = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [props.versionSsmParameter.parameterArn],
    });
     assignTenantToCellLambda.lambdaFunction.addToRolePolicy(policyStatement);

    // Create a resource
    const assignTenantToCellResource = controlPlaneApi.addResource('AssignTenantToCell');
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

    // Lambda function that processes requests from API Gateway to create a new Tenant
    const deactivateTenantLambda = new LambdaFunction(this, 'DeactivateTenantFunction', {
      friendlyFunctionName: 'DeactivateTenant',
      index: 'deactivateTenant.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/DeactivateTenant', 
      handler: 'handler', 
      environmentVariables: {
        "S3_BUCKET_NAME": s3ConfigBucket.bucketName,
      },        
    });

    s3ConfigBucket.grantReadWrite(deactivateTenantLambda.lambdaFunction);

    // Create a resource
    const deactivateTenantResource = controlPlaneApi.addResource('DeactivateTenant');
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
      entry: 'lib/saas-management/control-plane/src/lambdas/ActivateTenant', 
      handler: 'handler', 
      environmentVariables: {
        S3_BUCKET_NAME: s3ConfigBucket.bucketName,
        CELL_MANAGEMENT_TABLE: cellManagementTable.tableArn,
      },        
    });

    s3ConfigBucket.grantReadWrite(activateTenantLambda.lambdaFunction);
    cellManagementTable.grantReadData(activateTenantLambda.lambdaFunction);

    // Create a resource
    const activateTenantResource = controlPlaneApi.addResource('ActivateTenant');
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

    // Lambda function that processes requests from API Gateway to create a new Cell
    const persistCellMetadataLambda = new LambdaFunction(this, 'PersistCellMetadataFunction', {
      friendlyFunctionName: 'PersistCellMetadataFunction',
      index: 'persistCellMetadata.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/PersistCellMetadata', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}
    });
    
    cellManagementTable.grantWriteData(persistCellMetadataLambda.lambdaFunction);    


    // Create an EventBridge rule to process Metadata from Cell creation
    const persistCellMetadataRule = new events.Rule(this, 'PersistCellMetadataRule', {
      eventBus: cellManagementBus,
      eventPattern: {
        source: ['cellManagement.cellCreated','cellManagement.cellCreationError'],
        detailType: ['CellDetails'],
      },
    });

    persistCellMetadataRule.addTarget(new targets.LambdaFunction(persistCellMetadataLambda.lambdaFunction));

    /**
     * STart of Persist Tenant
     */
    // Lambda function that processes requests from API Gateway to create a new Cell
    const persistTenantMetadataLambda = new LambdaFunction(this, 'PersistTenantMetadataFunction', {
      friendlyFunctionName: 'PersistTenantMetadataFunction',
      index: 'persistTenantMetadata.py',
      entry: 'lib/saas-management/control-plane/src/lambdas/PersistTenantMetadata', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_TABLE': cellManagementTable.tableArn}
    });
    cellManagementTable.grantWriteData(persistTenantMetadataLambda.lambdaFunction);    


    // Create an EventBridge rule to process Metadata from Cell creation
    const persistTenantMetadataRule = new events.Rule(this, 'PersistTenantMetadataRule', {
      eventBus: cellManagementBus,
      eventPattern: {
        source: ['cellManagement.tenantCreated'],
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
