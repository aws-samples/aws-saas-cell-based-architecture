import { RemovalPolicy } from 'aws-cdk-lib';
import { Function, Runtime, Code }  from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as lambda_python from '@aws-cdk/aws-lambda-python-alpha';

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

    this.lambdaFunction = new lambda_python.PythonFunction(this, 'lambdaFunction', {
      entry: props.entry,
      runtime: Runtime.PYTHON_3_13,
      handler: props.handler,
      index: props.index,
      logGroup: logGroup,
      environment: {
        ...props.environmentVariables
      }
    });
  }
}
