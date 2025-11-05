import { NagSuppressions } from 'cdk-nag'

export class CdkNagUtils {

  static suppressCDKNag(context: any): void {
    NagSuppressions.addStackSuppressions(context, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Managed Policies are ok for this solution'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Allow wildcard expressions to grant permissions for multi-related actions that share a common prefix for AWS Managed policies.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Specify fixed lambda runtime version to ensure compatibility with application testing and deployments.'
      },
      {
        id: 'AwsSolutions-SQS3',
        reason: 'Payload is not critical and does not require a DLQ'
      },
      {
        id: 'AwsSolutions-SF1',
        reason: 'ERROR level is sufficient for this solution'
      },
      {
        id: 'AwsSolutions-ECR1',
        reason: 'Public access to ECR is required for this solution'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Ignoring, for stability of workshop'
      }
    ]);
  }
}