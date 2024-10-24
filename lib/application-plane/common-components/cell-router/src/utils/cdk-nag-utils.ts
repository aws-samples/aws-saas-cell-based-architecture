import { NagSuppressions } from 'cdk-nag'

export class CdkNagUtils {

  static suppressCDKNag(context: any): void {
    NagSuppressions.addStackSuppressions(context, [
      {
        id: 'AwsSolutions-COG4',
        reason: 'Cognito user pool authorizer unnecessary; Custom request authorizer is being used.'
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
        id: 'AwsSolutions-CFR1',
        reason: 'CloudFront geo restrictions are not necessary for this solution.'
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF is unnecessary.  Defense in depth is present in the solution.'
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: "Suppress false positive.  Minimum TLS version is set"
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policies acceptable for this solution.'
      }
    ]);
  }
}