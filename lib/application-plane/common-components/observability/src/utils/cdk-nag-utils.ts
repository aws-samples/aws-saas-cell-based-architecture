import { NagSuppressions } from 'cdk-nag'

export class CdkNagUtils {

  static suppressCDKNag(context: any): void {
    NagSuppressions.addStackSuppressions(context, [
      {
        id: 'AwsSolutions-S1',
        reason: "The S3 bucket is a log bucket and does not require logs enabled."
      },
    ]);
  }
}