import { CfnOutput, Stack, StackProps, RemovalPolicy, Fn } from 'aws-cdk-lib';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'
import { Construct } from 'constructs';

export interface BridgeStackProps extends StackProps {
  s3LoggingBucketArn: string
}

export class BridgeStack extends Stack {

  readonly orchestrationEventBus: EventBus;
  readonly imageVersionParam: StringParameter;
  readonly cellSourceBucketArn: string;
  
  constructor(scope: Construct, id: string, props: BridgeStackProps) {
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    const logBucket = Bucket.fromBucketArn(this,"loggingBucket",props.s3LoggingBucketArn);

    // Create the EventBridge bus for the communication between control plane and application plane
    const orchestrationEventBus = new EventBus(this, 'CellManagementBus', {
        eventBusName: 'cell-management-bus',
    });

    const imageVersionParameter = new StringParameter(this, 'ImageVersionParameter', {
        parameterName: '/saas/image-version',
        stringValue: 'not populated',
    });

    const s3CellSourceBucket = new Bucket(this, 'CellSourceBucket',{
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: "logs/buckets/cell-source-bucket/",
  });

    this.orchestrationEventBus = orchestrationEventBus;
    this.imageVersionParam = imageVersionParameter;
    this.cellSourceBucketArn = s3CellSourceBucket.bucketArn;

    new CfnOutput(this, 'S3SourceBucketName', {
      value: s3CellSourceBucket.bucketName,
      description: 'S3 Source Bucket Name',
      exportName: 'S3SourceBucketName'
    })
  }
}
