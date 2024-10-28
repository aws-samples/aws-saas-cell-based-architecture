import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as fs from 'fs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sqs from 'aws-cdk-lib/aws-sqs';


export interface AppPlaneStaggeredDeploymentsInterface extends cdk.StackProps {
  cellManagementTable: Table;
  cellCodeBuildProject: codebuild.Project;
  productServiceBuildProject: codebuild.Project;
  tenantManagementCodeBuildProject: codebuild.Project;
  s3SourceBucketName: string;
  sourceZipLocation: string;
  region: string;
  account: string;
  commonLoggingBucketArn: string;
}

export class AppPlaneStaggeredDeploymentsConstruct extends Construct {

    constructor(scope: Construct, id: string, props: AppPlaneStaggeredDeploymentsInterface) {
      super(scope, id);
      const s3SourceBucketName = props.s3SourceBucketName; 
      const sourceZipLocation = props.sourceZipLocation;

      const logBucket = s3.Bucket.fromBucketArn(this,"loggingBucket",props.commonLoggingBucketArn);

      const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        autoDeleteObjects: true,
        serverAccessLogsBucket: logBucket,
        serverAccessLogsPrefix: "logs/buckets/artifacts-bucket/",
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const lambdaPolicy = new iam.PolicyStatement({
        actions: [
          "s3:*Object",
        ],
        resources: [
          `${artifactsBucket.bucketArn}/*`,
        ],
      })

      
      const lambdaFunctionPrep = new lambda.Function(this, "prep-deploy", {
        handler: "lambda-prepare-deploy.lambda_handler",
        runtime: lambda.Runtime.PYTHON_3_12,
        code: new lambda.AssetCode(process.cwd() + '/lib/saas-management/cell-provisioning-system/src/lambdas/PrepDeploy'),
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
        environment: {
          BUCKET: artifactsBucket.bucketName,
          CELL_MANAGEMENT_TABLE_NAME: props.cellManagementTable.tableName
        },
        initialPolicy: [lambdaPolicy],
        logRetention: logs.RetentionDays.ONE_DAY,        
      });


      lambdaFunctionPrep.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "s3:ListBucket"
          ],
          resources: [
            artifactsBucket.bucketArn,
          ]
        })
      );
  
      lambdaFunctionPrep.addToRolePolicy(new iam.PolicyStatement({
          actions: [
            "codepipeline:PutJobSuccessResult",
            "codepipeline:PutJobFailureResult",
            "kms:Decrypt",
          ],
          resources: ["*"]
        })
      );
  
      lambdaFunctionPrep.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:GetItem",
          ],
          resources: [
            `arn:aws:dynamodb:${props.region}:${props.account}:table/${props.cellManagementTable.tableName}`,
          ]
        })
      );
  
      lambdaFunctionPrep.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLambdaInsightsExecutionRolePolicy"));
      lambdaFunctionPrep.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
  
      const sourceCodeBucket = s3.Bucket.fromBucketName(this, 'S3SourceBucket', s3SourceBucketName);
  
      
      // Define CodePipeline.
      const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
        pipelineName: 'CellDeploymentStateMachine',
        artifactBucket: artifactsBucket,
      });
  
      // Source
      const sourceOutput = new codepipeline.Artifact();
  
      // Add the Source stage.
      pipeline.addStage({
        stageName: 'Source',
        actions: [
          new codepipeline_actions.S3SourceAction({
            actionName: 'S3_Source',
            bucket: sourceCodeBucket,
            bucketKey: sourceZipLocation,
            output: sourceOutput,
            variablesNamespace: 'SourceVariables',
            trigger: codepipeline_actions.S3Trigger.POLL
          }),
        ],
      });
      
      const buildOutput = new codepipeline.Artifact();

      // add codebuild stage to pipeline
      pipeline.addStage({
        stageName: 'Build',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'CodeBuild',
            project: props.productServiceBuildProject,
            input: sourceOutput,   
            outputs: [buildOutput],         
            variablesNamespace: 'BuildVariables',
          })          
        ],
      });
      
      const deployOutput = new codepipeline.Artifact();

      // Add PrepDeploy stage to retrieve tenant data from dynamoDB.
      pipeline.addStage({
        stageName: 'PrepDeploy',
        actions: [
          new codepipeline_actions.LambdaInvokeAction({
            actionName: 'PrepareDeployment',
            lambda: lambdaFunctionPrep,
            outputs: [deployOutput],
            userParameters: {
              'artifact': 'Artifact_Build_Build-Cell',
              's3_source_version_id': '#{SourceVariables.VersionId}',
              'product_image_version': '#{BuildVariables.CODEBUILD_BUILD_NUMBER}'
            }
          })
        ],
      });
  
      // Create Lambda iterator to cycle through waved deployments.
      const lambdaFunctionIterator = new lambda.Function(this, "WaveIterator", {
        handler: "iterator.lambda_handler",
        runtime: lambda.Runtime.PYTHON_3_12,
        code: lambda.Code.fromAsset(process.cwd() + '/lib/saas-management/cell-provisioning-system/src/lambdas/Iterator', {exclude: ['*.json']}),
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
      });
  
      const stepfunctionLogGroup = new logs.LogGroup(this, 'stepFunctionLG', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.FIVE_DAYS,        
      });
  
      const approvalQueue = new sqs.Queue(this, 'ApprovalQueue', {
        enforceSSL: true
      });
  
      // Step function needs permissions to create resources
      const sfnPolicy = new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: [
              "s3:ListBucket",
              "s3:GetObjectVersion"
            ],
            resources: [
              artifactsBucket.bucketArn,
              sourceCodeBucket.bucketArn,
            ]
          }),
          new iam.PolicyStatement({
            resources: [
              `${artifactsBucket.bucketArn}/*`,
              `${sourceCodeBucket.bucketArn}/*`,
            ],
            actions: [
              "s3:*Object"
            ],
          }),
          new iam.PolicyStatement({
            resources: ["*"],
            actions: [
              "logs:*",
              "cloudformation:DescribeStacks",
              "cloudformation:CreateStack",
              "cloudformation:UpdateStack",
              "cloudformation:CreateChangeSet",
              "cloudwatch:PutMetricAlarm",
              "cloudwatch:PutMetricAlarm",
              "lambda:*",
              "apigateway:*",
              "dynamodb:*",
              "iam:GetRole",
              "iam:UpdateRole",
              "iam:DeleteRole",
              "iam:CreateRole",
              "iam:ListRoles",
              "iam:PassRole",
              "iam:GetPolicy",
              "iam:PassRole",
              "iam:UpdatePolicy",
              "iam:DetachRolePolicy",
              "iam:AttachRolePolicy",
              "iam:DeleteRolePolicy",
              "iam:DeletePolicy",
              "iam:PutRolePolicy",
              "iam:GetRolePolicy",
              "codedeploy:*",
              "codebuild:StartBuild",
              "codebuild:BatchGetBuilds",
              "codebuild:BatchGetReports",
              "sqs:sendmessage",
              "events:PutTargets",
              "events:PutRule",
              "events:DescribeRule"
            ],
          }),
        ],
      });
  
      const stepfunctionDeploymentRole = new iam.Role(this, 'StepFunctionRole', {
        assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
        description: 'Role assumed by deployment state machine',
        inlinePolicies: {
          deployment_policy: sfnPolicy,
        },
      });
  
      const filePath = require('path').join(__dirname, '/src/stepfunctions/deploymentstatemachine.asl.json')
      const file = fs.readFileSync(filePath);
  
      new stepfunctions.CfnStateMachine(this, 'DeploymentCfnStateMachine', {
        roleArn: stepfunctionDeploymentRole.roleArn,
        // the properties below are optional
        definitionString: file.toString(),
        definitionSubstitutions: {
          ITERATOR_LAMBDA_ARN: lambdaFunctionIterator.functionArn,
          APPROVAL_QUEUE_URL: approvalQueue.queueUrl,
          CELL_MANAGEMENT_TABLE_NAME: props.cellManagementTable.tableName,
          CODE_BUILD_PROJECT_NAME: props.cellCodeBuildProject.projectName,
          TENANT_MGMT_CODE_BUILD_PROJECT_NAME: props.tenantManagementCodeBuildProject.projectName
        },
        stateMachineName: 'CellDeploymentStateMachine',
        stateMachineType: 'STANDARD',
        tracingConfiguration: {
          enabled: true
        },
        loggingConfiguration: {
          level: 'ERROR',
          destinations: [
            {
              cloudWatchLogsLogGroup: {logGroupArn: stepfunctionLogGroup.logGroupArn}
            }
          ]
        }
      });
  
      const stateMachine = stepfunctions.StateMachine.fromStateMachineName(this, 'DeploymentStateMachine', 'CellDeploymentStateMachine');
  
      const stepFunctionAction = new codepipeline_actions.StepFunctionInvokeAction({
        actionName: 'InvokeStepFunc',
        stateMachine: stateMachine,
        stateMachineInput: codepipeline_actions.StateMachineInput.filePath(deployOutput.atPath('output.json'))
      });
  
      pipeline.addStage({
        stageName: 'InvokeStepFunctions',
        actions: [stepFunctionAction],
      });
  
      new cdk.CfnOutput(this, 'CellDeploymentPipeline', {
        value: pipeline.pipelineName,
      });

  
  }
}
