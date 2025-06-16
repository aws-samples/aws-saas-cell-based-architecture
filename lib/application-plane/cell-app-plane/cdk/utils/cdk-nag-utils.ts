import { NagSuppressions } from 'cdk-nag'

export class CdkNagUtils {

  static suppressCDKNag(context: any): void {
    NagSuppressions.addStackSuppressions(context, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC Flow logs unnecessary for current implementation, relying on access log from API Gateway.'
      },
      {
        id: 'AwsSolutions-ECS4',
        reason: 'CloudWatch Container Insights not required for tracking microservice performance.'
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'AdvancedSecurityMode: Advanced mode is deprecated.'
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Cognito user pool authorizer unnecessary; Custom request authorizer is being used.'
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Managed policies are permitted.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Specify fixed lambda runtime version to ensure compatibility with application testing and deployments.'
      },
      {
        id: 'AwsSolutions-SNS2',
        reason: 'Not utilizing SNS notifications.'
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'Not utilizing SNS notifications.'
      },
      {
        id: 'AwsSolutions-EC26',
        reason: 'EBS encryption unnecessary.'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Allow wildcard expressions to grant permissions for multi-related actions that share a common prefix for AWS Managed policies.'
      },
      {
        id: 'AwsSolutions-AS3',
        reason: 'Notifications not required for Auto Scaling Group.'
      },
     {
        id: 'AwsSolutions-ELB2',
        reason: 'ELB access logs not required.'
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Automatic rotation not necessary.'
      },
      {
        id: 'AwsSolutions-RDS6',
        reason: 'Fine-grained access control methods in place to restrict tenant access.'
      },
      {
        id: 'AwsSolutions-RDS10',
        reason: 'Deletion protection not required for current use case.'
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'API Gateway request validation is unnecessary; custom logic in the integration handles validation and logging of request errors.'
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Custom request authorizer is being used.'
      },
      {
        id: 'AwsSolutions-EC23',
        reason: 'ALB is protected in private subnet to receive traffic only from the NLB in a private integration with API Gateway.'
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'For this solution, statically defined environment variables are sufficient.'
      }
    ]);
  }
}