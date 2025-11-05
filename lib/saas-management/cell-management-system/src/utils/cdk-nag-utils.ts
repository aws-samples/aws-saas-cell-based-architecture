import { NagSuppressions } from 'cdk-nag'

export class CdkNagUtils {

  static suppressCDKNag(context: any): void {
    NagSuppressions.addStackSuppressions(context, [
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA cannot be leveraged for a workshop.  User and account is shortlived, and MFA is unnecessary/impractical.'
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'Advanced Security Mode is unnecessary for a workshop. User and account is shortlived.'
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Authorization cannot be used for OPTIONS as part of CORS'
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS Managed policies are permitted.'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Restriction applied at the log group level, and more granular restrictions are not possible as resources are created dynamically as and when required.'
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'API Gateway request validation is unnecessary; custom logic in the integration handles validation and logging of request errors.'
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'WAFv2 is not required.'
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Custom request authorizer is being used.'
      },
      {
        id: 'AwsSolutions-COG1',
        reason: 'Default password is sufficient for a workshop with temporary users'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Ignoring, for stability of workshop'
      }
    ]);
  }
}