import { 
  Stack, 
  StackProps, 
  RemovalPolicy, 
  CfnOutput, 
  Duration 
} from 'aws-cdk-lib';
import { 
  CacheCookieBehavior, 
  CachePolicy, 
  CacheHeaderBehavior, 
  CacheQueryStringBehavior, 
  Distribution, 
  LambdaEdgeEventType, 
  SecurityPolicyProtocol, 
  OriginAccessIdentity, 
  AllowedMethods,
  OriginRequestPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { readFileSync } from 'fs';
import { Construct } from 'constructs';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'

export interface CommonCellRouterProps extends StackProps
{
  readonly s3LoggingBucketArn: string;
}

export class CommonCellRouter extends Stack {

  readonly s3ConfigBucketName: string;

  constructor(scope: Construct, id: string, props: CommonCellRouterProps) {
    
    /**
     * call the parent constructor
     */
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    const logBucket = Bucket.fromBucketArn(this,"loggingBucket",props.s3LoggingBucketArn);

    //origin access identity
    const cfOriginAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity');

    const s3DefaultOriginBucket = new Bucket(this, 'DefaultOriginBucket',{
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: "logs/buckets/default-origin-bucket/",
      serverAccessLogsBucket: logBucket,  
    });

    s3DefaultOriginBucket.grantRead(cfOriginAccessIdentity);

    /**
     * this variable is used to define the path and permissions
     * for the lambda
     */
    const cellMappingObjectKey = 'tenantToCellMapping.json'

    const configBucket = new Bucket(this, 'RequestRouterConfigBucket',{
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: "logs/buckets/config-bucket/",
      serverAccessLogsBucket: logBucket,  
    });

    this.s3ConfigBucketName = configBucket.bucketName

    /**
     * Lambda@edge does not support environment variables, so
     * read the function code from the file and inject the necessary variables
     */
    const functionCode = readFileSync('lib/application-plane/common-components/cell-router/src/lambdas/CellRouter/cellRouter.py', 'utf8').replace('S3_BUCKET_NAME', configBucket.bucketName).replace('S3_OBJECT_KEY',cellMappingObjectKey);

    // Create a Lambda function
    const cellRoutingLambda = new Function(this, 'CellRoutingLambda', {
      runtime: Runtime.PYTHON_3_12,
      code: Code.fromInline(functionCode),
      handler: 'index.lambda_handler',
    });

    // Add s3 get permissions to the role
    cellRoutingLambda.role?.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:GetObject',
      ],
      resources: [`${configBucket.bucketArn}/${cellMappingObjectKey}`],
    }));

    // Create a CloudFront Distribution
    const distribution = new Distribution(this, 'MyDistribution', {
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: 'logs/cloudfront/cell-router/',
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: new S3Origin(s3DefaultOriginBucket,{
          originAccessIdentity: cfOriginAccessIdentity,
        }),
        cachePolicy: new CachePolicy(this, 'ApiCachePolicy', {
          headerBehavior: CacheHeaderBehavior.allowList('tenantid'),
          queryStringBehavior: CacheQueryStringBehavior.all(),
          cookieBehavior: CacheCookieBehavior.none(),
          minTtl: Duration.minutes(0),
          maxTtl: Duration.minutes(1),
          defaultTtl: Duration.minutes(0),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        edgeLambdas: [{
            includeBody: true,
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: cellRoutingLambda.currentVersion,            
          },
        ],
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: AllowedMethods.ALLOW_ALL
      },
    });

    new CfnOutput(this, 'DistributionUrl', {
      value: distribution.domainName,
      description: 'The DNS name of CF Distribution',
    });

    new CfnOutput(this, 'ConfigBucketArn', {
      value: configBucket.bucketArn,
      description: 'The Arn for the Config S3 Bucket',
    });
  }
}
