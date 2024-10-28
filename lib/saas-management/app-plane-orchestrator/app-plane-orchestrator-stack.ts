import {CfnOutput, Stack, StackProps, RemovalPolicy, Fn} from 'aws-cdk-lib';
import { IntegrationPattern,JsonPath, Pass, Fail, Choice, Succeed, Condition, StateMachine, DefinitionBody, LogLevel } from 'aws-cdk-lib/aws-stepfunctions';
import { CodeBuildStartBuild, LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Project, BuildSpec, Source, ComputeType, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LambdaFunction  } from '../src/lambda-function-construct';
import * as events from 'aws-cdk-lib/aws-events';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { LogGroup, RetentionDays} from 'aws-cdk-lib/aws-logs';
import { AppPlaneStaggeredDeploymentsConstruct } from './app-plane-staggered-deployment-construct';
import { Construct } from 'constructs';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'

export interface AppPlaneOrchestratorInterface extends StackProps {
  orchestrationBus: events.EventBus;
  cellManagementTable: Table;
  s3LoggingBucketArn: string;
  s3CellSourceBucketArn: string;
}

export class AppPlaneOrchestratorStack extends Stack {

  constructor(scope: Construct, id: string, props: AppPlaneOrchestratorInterface) {
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    const logBucket = Bucket.fromBucketArn(this,"loggingBucket",props.s3LoggingBucketArn);
    const s3CellSourceBucket = Bucket.fromBucketArn(this,"cellSourceBucket", props.s3CellSourceBucketArn);
    
    const cellSourceDeployment = new s3deploy.BucketDeployment(this, 'DeployCellSource', {
        sources: [s3deploy.Source.asset('lib/application-plane/cell-app-plane.zip')],
        destinationBucket: s3CellSourceBucket,        
        extract: false
    });

    // Create an ECR repository
    const repository = new ecr.Repository(this, `ProductServiceRepo`, {
      repositoryName: `product-service`,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true
    });

    // Define the repository policy
    const repositoryPolicyStatement = new iam.PolicyStatement({
      actions: ['ecr:*'],
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal("*")] // This allows all AWS principals to perform actions
    });

    // Add the policy to the repository
    repository.addToResourcePolicy(repositoryPolicyStatement);

    // Create a new KMS key
    const codeBuildCmk = new Key(this, 'CodeBuildEncryptionKey', {
      description: 'KMS key for CodeBuild project encryption',
      enableKeyRotation: true,
    });

    // Create a CodeBuild project
    const productServiceProject = new Project(this, 'ProductServiceProject', {
      projectName: 'SaasProductServiceBuildProject',
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 18,
            },
            commands: [
              `ACCOUNT_ID=${this.account}`,
              `REGION=${this.region}`,
              `echo ACCOUNT: $ACCOUNT_ID, REGION: $REGION`,
              'cd scripts',
            ],
          },
          build: {
            commands: [
              `./build-product-image.sh ${this.region} ${this.account}`
            ],
          },
          post_build: {
            commands: [
              'echo Product Image Created',
            ],
          },          
        },        
        artifacts: {
        },
        env: {
          'exported-variables': ['CODEBUILD_BUILD_NUMBER'],
        },
      }),
      source: Source.s3({
        bucket: s3CellSourceBucket,
        path: Fn.select(0, cellSourceDeployment.objectKeys)
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: ComputeType.SMALL,
      },
      encryptionKey: codeBuildCmk
    });

    // Grant CloudFormation permissions to the CodeBuild project
    productServiceProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'ssm:PutParameter',
          'ecr:DescribeImages',
          'ecr:DescribeRepositories',
          'ecr:BatchGetImage',
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:GetAuthorizationToken',
          'ecr:UploadLayerPart',
          'sts:GetCallerIdentity'
        ],
        resources: ['*'],
    }));

    repository.grantPullPush(productServiceProject);

    productServiceProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
           'sts:AssumeRole',
           'iam:PassRole'
        ],
        resources: [
           'arn:aws:iam::*:role/cdk-readOnlyRole',
           'arn:aws:iam::*:role/cdk-hnb659fds-deploy-role-*',
           'arn:aws:iam::*:role/cdk-hnb659fds-file-publishing-*'
        ],
    }));

    // ------- Cell Management -------- //

    // Create an EventBridge rule
    const createCellRule = new events.Rule(this, 'CreateCellRule', {
        eventBus: props.orchestrationBus,
        eventPattern: {
          source: ['cellManagement.createCell'],
          detailType: ['CellData'],
        },
    });

    
    // Create a CodeBuild project
    const cellCodebuildProject = new Project(this, 'CellCreationProject', {
      projectName: 'SaasCellCreationBuildProject',
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 18,
            },
            commands: [
              'echo CELL_ID=$CELL_ID',
              'echo CELL_SIZE=$CELL_SIZE',
              'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
              'npm install -g typescript',
              'npm install -g aws-cdk',
              'cd cdk',
              'npm install',
            ],
          },
          build: {
            commands: [
              'cd ../scripts',
              'source ./deploy-cell.sh $CELL_ID $CELL_SIZE',
              'STACK_OUTPUTS=$(<stack_outputs.json)',
            ],
          },
          post_build: {
            commands: [
              'echo Deployment completed successfully',
            ],
          },
        },
        artifacts: {
          files: ['./cdk/stack_outputs.json'],
        },
        env: {
          'exported-variables': ['STACK_OUTPUTS','CELL_ID']
        },
      }),
      source: Source.s3({
        bucket: s3CellSourceBucket,
        path: Fn.select(0, cellSourceDeployment.objectKeys)
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: ComputeType.SMALL,
      },
      encryptionKey: codeBuildCmk
    });

    // Grant CloudFormation permissions to the CodeBuild project
    cellCodebuildProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:DescribeStacks',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:ListStacks',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:CreateChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
          'ssm:GetParameter',
          'ssm:PutParameter',
          'ecr:DescribeImages',
          'ecr:DescribeRepositories',
          'ecr:BatchGetImage',
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:GetAuthorizationToken',
          'ecr:UploadLayerPart',
          'sts:GetCallerIdentity'
        ],
        resources: ['*'],
    }));

    repository.grantPullPush(cellCodebuildProject);

    cellCodebuildProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
           'sts:AssumeRole',
           'iam:PassRole'
        ],
        resources: [
           'arn:aws:iam::*:role/cdk-readOnlyRole',
           'arn:aws:iam::*:role/cdk-hnb659fds-deploy-role-*',
           'arn:aws:iam::*:role/cdk-hnb659fds-file-publishing-*'
        ],
    }));

    // Define success and failure states
    const buildSucceeded = new Succeed(this, 'Cell Creation Succeeded');
    const buildFailed = new Fail(this, 'Cell Creation Failed', {
      cause: 'CodeBuild build failed',
    });

    // Lambda function that processes requests from API Gateway to create a new Cell
    const persistCellDetailsLambda = new LambdaFunction(this, 'PersistCellDetails', {
      friendlyFunctionName: 'PersistCellDetailsFunction',
      index: 'persistCellDetails.py',
      entry: 'lib/saas-management/app-plane-orchestrator/src/lambdas/persistCellDetails', 
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_BUS': props.orchestrationBus.eventBusName}
    });

    props.orchestrationBus.grantPutEventsTo(persistCellDetailsLambda.lambdaFunction);

    // Create a Step Functions task to invoke the Lambda function
    const invokeLambdaOnSuccessTask = new LambdaInvoke(this, 'PersistCellMetaDataOnSuccess', {
      lambdaFunction: persistCellDetailsLambda.lambdaFunction,
      outputPath: '$.Payload',
    });

    // Create a Step Functions task to invoke the Lambda function
    const invokeLambdaOnFailureTask = new LambdaInvoke(this, 'UpdateCellStatusOnFailure', {
      lambdaFunction: persistCellDetailsLambda.lambdaFunction,
      outputPath: '$.Payload',
    });

    // Create a Step Function task to start the CodeBuild project
    const startBuildTask = new CodeBuildStartBuild(this, 'StartCellCreation', {
      project: cellCodebuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        CELL_ID: { value: JsonPath.stringAt('$.CellId') },
        CELL_SIZE: { value: JsonPath.stringAt('$.CellSize') }
      },
    }).addCatch(invokeLambdaOnFailureTask.next(buildFailed));

    const stepFunctionDefinition = startBuildTask
      .next(invokeLambdaOnSuccessTask)
      .next(buildSucceeded)

    // Create the state machine
    const createCellStateMachine = new StateMachine(this, 'CellManagementStateMachine', {
      definitionBody: DefinitionBody.fromChainable(stepFunctionDefinition),
      logs: { 
        level: LogLevel.ALL,
        destination: new LogGroup(this, 'CreateCellStepFunctionLogGroup', {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      },
      tracingEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add the Step Function as a target of the EventBridge rule
    createCellRule.addTarget(new SfnStateMachine(createCellStateMachine, {
        input: events.RuleTargetInput.fromObject({
            CellId: events.EventField.fromPath('$.detail.cell_id'),
            CellSize: events.EventField.fromPath('$.detail.cell_size'),
        })
    }));

    // ------- Tenant Management -------- //

    // Create an EventBridge rule
    const createTenantRule = new events.Rule(this, 'CreateTenantRule', {
        eventBus: props.orchestrationBus,
        eventPattern: {
          source: ['cellManagement.createTenant'],
          detailType: ['TenantData'],
        },
    });

    // Create a CodeBuild project
    const tenantMgtCodeBuild = new Project(this, 'TenantCreationProject', {
      projectName: 'SaasTenantCreationBuildProject',
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 18,
            },
            commands: [
              'echo CELL_ID=$CELL_ID',
              'echo TENANT_ID=$TENANT_ID',
              'echo TENANT_EMAIL=$TENANT_EMAIL',
              'echo TENANT_LISTENER_PRIORITY=$TENANT_LISTENER_PRIORITY',
              'echo PRODUCT_IMAGE_VERSION=$PRODUCT_IMAGE_VERSION',
              'npm install -g typescript',
              'npm install -g aws-cdk',
              'cd cdk',
              'npm install',
            ],
          },
          build: {
            commands: [
              'cd $CODEBUILD_SRC_DIR/scripts',
              'source ./deploy-tenant.sh $CELL_ID $TENANT_ID $TENANT_EMAIL $TENANT_LISTENER_PRIORITY $PRODUCT_IMAGE_VERSION',
              'cd $CODEBUILD_SRC_DIR/cdk',
              'STACK_OUTPUTS=$(<tenant_stack_outputs.json)',
            ],
          },
          post_build: {
            commands: [
              'echo Deployment completed successfully',
            ],
          },
        },
        env: {
          'exported-variables': ['STACK_OUTPUTS','CELL_ID','TENANT_ID'],
        }
      }),
      source: Source.s3({
        bucket: s3CellSourceBucket,
        path: Fn.select(0, cellSourceDeployment.objectKeys)
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: ComputeType.SMALL,
      },
      encryptionKey: codeBuildCmk
    });

    // Grant CloudFormation permissions to the CodeBuild project
    tenantMgtCodeBuild.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:DescribeStacks',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:ListStacks',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:CreateChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
          'ssm:GetParameter',
          'ssm:PutParameter'
        ],
        resources: ['*'],
    }));

    tenantMgtCodeBuild.addToRolePolicy(new iam.PolicyStatement({
        actions: [
           'sts:AssumeRole',
           'iam:PassRole'
        ],
        resources: [
           'arn:aws:iam::*:role/cdk-readOnlyRole',
           'arn:aws:iam::*:role/cdk-hnb659fds-deploy-role-*',
           'arn:aws:iam::*:role/cdk-hnb659fds-file-publishing-*'
        ],
    }));

    // Lambda function that processes requests from API Gateway to create a new Cell
    const persistTenantDetailsLambda = new LambdaFunction(this, 'PersistTenantDetails', {
      friendlyFunctionName: 'PersistTenantDetailsFunction',
      index: 'persistTenantDetails.py',
      entry: 'lib/saas-management/app-plane-orchestrator/src/lambdas/persistTenantDetails',
      handler: 'handler',
      environmentVariables: {'CELL_MANAGEMENT_BUS': props.orchestrationBus.eventBusName}
    });

    props.orchestrationBus.grantPutEventsTo(persistTenantDetailsLambda.lambdaFunction);

    // Create a Step Functions task to invoke the Lambda function
    const invokeTenantLambdaTaskOnSuccess = new LambdaInvoke(this, 'PersistTenantMetadataOnSuccess', {
        lambdaFunction: persistTenantDetailsLambda.lambdaFunction,
        outputPath: '$.Payload',
    });

    // Create a Step Functions task to invoke the Lambda function
    const invokeTenantLambdaTaskOnFailure = new LambdaInvoke(this, 'PersistTenantMetadataOnFailure', {
      lambdaFunction: persistTenantDetailsLambda.lambdaFunction,
      outputPath: '$.Payload',
    });

    // Define success and failure states
    const tenantBuildSucceeded = new Succeed(this, 'Tenant Creation Succeeded');
    const tenantBuildFailed = new Fail(this, 'Tenant Creation Failed', {
      cause: 'CodeBuild build failed',
    });

    // Create a Step Function task to start the CodeBuild project
    const startTenantBuildTask = new CodeBuildStartBuild(this, 'StartTenantCreation', {
      project: tenantMgtCodeBuild,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        CELL_ID: { value: JsonPath.stringAt('$.CellId') },
        TENANT_ID: { value: JsonPath.stringAt('$.TenantId') },
        TENANT_NAME: { value: JsonPath.stringAt('$.TenantName') },
        TENANT_EMAIL: { value: JsonPath.stringAt('$.TenantEmail') },
        TENANT_LISTENER_PRIORITY: { value: JsonPath.stringAt('$.TenantListenerPriority') },
        PRODUCT_IMAGE_VERSION: { value: JsonPath.stringAt('$.ProductImageVersion') }
      },
    }).addCatch(invokeTenantLambdaTaskOnFailure.next(tenantBuildFailed));

    const tenantStepFunctionDefinition = startTenantBuildTask
      .next(invokeTenantLambdaTaskOnSuccess)
      .next(tenantBuildSucceeded)

    // Create the state machine
    const createTenantStateMachine = new StateMachine(this, 'TenantManagementStateMachine', {
      definitionBody: DefinitionBody.fromChainable(tenantStepFunctionDefinition),
      logs: { 
        level: LogLevel.ALL,
        destination: new LogGroup(this, 'CreateTenantStepFunctionLogGroup', {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      },
      tracingEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add the Step Function as a target of the EventBridge rule
    createTenantRule.addTarget(new SfnStateMachine(createTenantStateMachine, {
        input: events.RuleTargetInput.fromObject({
            CellId: events.EventField.fromPath('$.detail.cell_id'),
            TenantId: events.EventField.fromPath('$.detail.tenant_id'),
            TenantName: events.EventField.fromPath('$.detail.tenant_name'),
            TenantEmail: events.EventField.fromPath('$.detail.tenant_email'),
            TenantListenerPriority: events.EventField.fromPath('$.detail.tenant_listener_priority'),
            ProductImageVersion: events.EventField.fromPath('$.detail.product_image_version'),
        })
    }));

    // ------- Stack Outputs -------- //

    // Output the state machine ARN
    new CfnOutput(this, 'StateMachineArn', {
      value: createCellStateMachine.stateMachineArn,
      description: 'State Machine ARN',
    });    
    
    let appPlaneStaggeredDeployments = new AppPlaneStaggeredDeploymentsConstruct(this, 'AppPlaneStaggeredDeployments', {
        cellManagementTable: props.cellManagementTable,
        cellCodeBuildProject: cellCodebuildProject,    
        productServiceBuildProject: productServiceProject,
        tenantManagementCodeBuildProject: tenantMgtCodeBuild,
        s3SourceBucketName: s3CellSourceBucket.bucketName,
        sourceZipLocation: Fn.select(0, cellSourceDeployment.objectKeys),
        region: this.region,
        account: this.account,
        commonLoggingBucketArn: logBucket.bucketArn,
    });            
  }
}
