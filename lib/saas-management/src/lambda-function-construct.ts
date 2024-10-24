import { RemovalPolicy } from 'aws-cdk-lib';
import { Function, Runtime, Code }  from 'aws-cdk-lib/aws-lambda';
import { Role, Policy, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as lambda_python from '@aws-cdk/aws-lambda-python-alpha';
import { log } from 'console';

export interface LambdaFunctionProps {
  friendlyFunctionName: string
  index: string
  entry: string 
  handler: string    
  environmentVariables?: {[key: string]: string}
}

export class LambdaFunction extends Construct {
  public readonly lambdaFunction: Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${props.friendlyFunctionName}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const executionRole = new Role(this, 'LambdaExecutionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const logPolicy = new Policy(this, 'LambdaLoggingPolicy', {
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['logs:CreateLogGroup'],
          resources: [logGroup.logGroupArn],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['logs:CreateLogStream','logs:PutLogEvents'],
          resources: [`${logGroup.logGroupArn}/*`],
        }),
      ],
    });
    logPolicy.attachToRole(executionRole);

    this.lambdaFunction = new lambda_python.PythonFunction(this, 'lambdaFunction', {
      entry: props.entry,
      runtime: Runtime.PYTHON_3_12,
      handler: props.handler,
      index: props.index,
      logGroup: logGroup,
      environment: {
        ...props.environmentVariables
      },
      role: executionRole
    });
  }
}
