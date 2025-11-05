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
        id: 'AwsSolutions-L1',
        reason: 'Ignoring, for stability of workshop'
      }
    ]);
  }
}