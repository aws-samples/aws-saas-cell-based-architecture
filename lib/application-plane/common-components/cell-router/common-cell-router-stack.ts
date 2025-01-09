import { 
  Stack, 
  StackProps, 
  RemovalPolicy, 
  CfnOutput, 
  Duration,
  PhysicalName 
} from 'aws-cdk-lib';
import { 
  CacheCookieBehavior, 
  CachePolicy, 
  CacheHeaderBehavior, 
  CacheQueryStringBehavior, 
  Distribution, 
  SecurityPolicyProtocol, 
  AllowedMethods,
  OriginRequestPolicy,
  KeyValueStore,
  Function,
  FunctionCode,
  FunctionRuntime,
  FunctionEventType,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket, BucketEncryption, BlockPublicAccess, BucketAccessControl } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CdkNagUtils } from './src/utils/cdk-nag-utils'

export class CommonCellRouter extends Stack {
  readonly distributionId: string;
  readonly cellToTenantKvsArn: string;

  constructor(scope: Construct, id: string, props: StackProps) {
    
    /**
     * call the parent constructor
     */
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    const logBucket = new Bucket(this, 's3AccessLogBucket', {
      bucketName: PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      accessControl: BucketAccessControl.LOG_DELIVERY_WRITE,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        id: 'object retention policy',
        expiration: Duration.days(7)
      }]
    });

    const s3DefaultOriginBucket = new Bucket(this, 'DefaultOriginBucket',{
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: "logs/buckets/default-origin-bucket/",
      serverAccessLogsBucket: logBucket,  
    });

    // Create a Key Value Store
    const keyValueStore = new KeyValueStore(this, 'CellToTenantKeyValueStore', {
      keyValueStoreName: 'cell-tenant-mapping-store',
      comment: 'Store for mapping of cells to tenants',
    });

    // Create the Routing CloudFront Function
    const routerFunction = new Function(this, 'CellRoutingFunction', {
      functionName: 'tenant-router',
      code: FunctionCode.fromFile({
        filePath: 'lib/application-plane/common-components/cell-router/src/functions/cell-router.js'
      }),
      runtime: FunctionRuntime.JS_2_0,
      keyValueStore: keyValueStore,
    });

    // Create a CloudFront Distribution
    const distribution = new Distribution(this, 'MyDistribution', {
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: 'logs/cloudfront/cell-router/',
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(s3DefaultOriginBucket),
        cachePolicy: new CachePolicy(this, 'ApiCachePolicy', {
          headerBehavior: CacheHeaderBehavior.allowList('tenantid','Authorization'),
          queryStringBehavior: CacheQueryStringBehavior.all(),
          cookieBehavior: CacheCookieBehavior.none(),
          minTtl: Duration.minutes(0),
          maxTtl: Duration.minutes(1),
          defaultTtl: Duration.minutes(0),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        functionAssociations: [
          {
            function: routerFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
        originRequestPolicy: OriginRequestPolicy.CORS_CUSTOM_ORIGIN,
        allowedMethods: AllowedMethods.ALLOW_ALL
      },
    });

    this.distributionId = distribution.distributionId
    this.cellToTenantKvsArn = keyValueStore.keyValueStoreArn;

    new CfnOutput(this, 'DistributionUrl', {
      value: distribution.domainName,
      description: 'The DNS name of CF Distribution',
    });

    new CfnOutput(this, 'CellToTenantKvsArn', {
      value: keyValueStore.keyValueStoreArn,
      description: 'The Arn for the Cell to Tenant KVS',
    })
  }
}
