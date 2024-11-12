import { Stack, StackProps, RemovalPolicy, Tags, Duration, CfnOutput } from 'aws-cdk-lib';
import {
  AuthorizationType,
  RestApi,
  TokenAuthorizer,
  EndpointType,
  LogGroupLogDestination,
  ConnectionType,
  VpcLink,
  HttpIntegration, AccessLogFormat, MethodLoggingLevel
} from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { LogGroup, RetentionDays, MetricFilter, FilterPattern } from 'aws-cdk-lib/aws-logs';
import { Unit } from 'aws-cdk-lib/aws-cloudwatch';
import { IdentityProvider } from './IdentityProviderConstruct';
import { LambdaFunction } from './LambdaFunctionConstruct';
import { AuroraPostgres } from './RdsPostgresConstruct';
import { CdkNagUtils } from '../utils/cdk-nag-utils'
import path = require('path');

interface CellStackProps extends StackProps {
  cellId: string;
  cellSize: string;
}

export class CellStack extends Stack {
  constructor(scope: Construct, id: string, props: CellStackProps) {
    super(scope, id);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    Tags.of(this).add('SaaSApplicationService', `CellAppPlane-${props.cellId}`);


    // Define the instance types for ECS and RDS based on the cell size
    //default to small
    let ecsInstanceType = ec2.InstanceType.of(
      ec2.InstanceClass.M5,
      ec2.InstanceSize.LARGE
    )
    let rdsInstanceType = ec2.InstanceType.of(
      ec2.InstanceClass.R5,
      ec2.InstanceSize.LARGE
    )
    let tenantsSupported = 20;

    if (props.cellSize == 'S') {
      ecsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      )
      rdsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      )
      tenantsSupported = 20;
    }

    if (props.cellSize == 'M') {
      ecsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.LARGE
      )
      rdsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.LARGE
      )
      tenantsSupported = 10;
    }

    if (props.cellSize == 'L') {
      ecsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.XLARGE
      )
      rdsInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.LARGE
      )
      tenantsSupported = 5;
    }


    // Create a VPC with isolated subnets
    const vpcName = `Cell_VPC-${props.cellId}`;
    const vpc = new ec2.Vpc(this, vpcName, {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private_with_egress',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'private_isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ]
    });

    // Create an ECS cluster
    const clusterName = `Cell_Cluster-${props.cellId}`;
    const cluster = new ecs.Cluster(this, clusterName, {
      vpc: vpc
    });

    const ecsInstanceRole = new iam.Role(this, 'EcsInstanceRole-${props.cellId}', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
      ],
    });

    // User data script to install and run a simple HTTP server and configure S3 bucket name
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'yum install -y httpd',
      'echo \'Hello World\' > /var/www/html/index.html',
      'systemctl start httpd',
      'systemctl enable httpd'
    );

    // Create an Auto Scaling Group with ECS-optimized AMI
    const asg = new autoscaling.AutoScalingGroup(this, `DefaultAutoScalingGroup-${props.cellId}`, {
      instanceType: ecsInstanceType,
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      vpc: vpc,
      minCapacity: 1,
      maxCapacity: 2,
      requireImdsv2: true,
      newInstancesProtectedFromScaleIn: false,
      role: ecsInstanceRole,
      userData: userData
    });

    //create security group for auto scaling group asg
    const asgSecurityGroup = new ec2.SecurityGroup(this, `ASGSecurityGroup-${props.cellId}`, {
      vpc: vpc,
      allowAllOutbound: true
    });
    asg.addSecurityGroup(asgSecurityGroup);

    // Add the ASG as a capacity provider to the ECS cluster
    const capacityProvider = new ecs.AsgCapacityProvider(this, `CapacityProvider-${props.cellId}`, {
      autoScalingGroup: asg,
      enableManagedTerminationProtection: false
    });

    cluster.addAsgCapacityProvider(capacityProvider);

    // Create an ALB
    const lbName = `Cell_ALB-${props.cellId}`;
    const alb = new elbv2.ApplicationLoadBalancer(this, lbName, {
      vpc: vpc,
      internetFacing: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    const listener = alb.addListener(`PrivateListener-${props.cellId}`, {
      port: 80,
      open: true
    });

    // Add ASG as a target to ALB with an HTTP health check
    const albTarget = listener.addTargets(`ASGTargetGroup-${props.cellId}`, {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/',
        protocol: elbv2.Protocol.HTTP,
        port: '80'
      }
    });

    // Allow incoming traffic from the ALB to the ASG
    asg.connections.allowFrom(alb, ec2.Port.tcpRange(32768, 65535), 'allow incoming traffic from ALB');

    const nlb = new elbv2.NetworkLoadBalancer(this, `CellNLB-${props.cellId}`, {
      vpc: vpc,
      internetFacing: false,
      crossZoneEnabled: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    const nlbListener = nlb.addListener(`NlbListener-${props.cellId}`, {
      port: 80
    });

    const nlbTargetGroup = nlbListener.addTargets(`NlbTargets-${props.cellId}`, {
      targets: [new targets.AlbArnTarget((alb.loadBalancerArn), 80)],
      port: 80,
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        port: '80'
      }
    });

    nlbTargetGroup.node.addDependency(listener);

    // Create the aurora postgres cluster
    const rdsPostgres = new AuroraPostgres(this, `CellDBServer-${props.cellId}`, {
      cellId: props.cellId,
      vpc: vpc,
      dbName: `CellDB-${props.cellId}`,
      auroraClusterUsername: "saasadmin",
      ingressSources: [asgSecurityGroup],
      instanceType: rdsInstanceType
    });

    //Cognito Setup
    const identityProvider = new IdentityProvider(this, `IdentityProvider-${props.cellId}`);
    const idpDetails = identityProvider.identityDetails;

    //Authorizer lambda function that uses Cognito
    const authorizerLambda = new LambdaFunction(this, `TenantAuthorizerLambda-${props.cellId}`, {
      friendlyFunctionName: `TenantAuthorizerFunction-${props.cellId}`,
      index: 'authorizer.py',
      entry: path.join(__dirname, '../lambdas'),
      handler: 'handler',
      environmentVariables: {'IDP_DETAILS': JSON.stringify(idpDetails)},
    })

    /**
     * The API Gateway API for the cell
     */
    const restAPIAccessLogGroup = new LogGroup(this, `APIGatewayAccessLogs-${props.cellId}`, {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK,
    });

    const api = new RestApi(this, `CellApi-${props.cellId}`, {
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new LogGroupLogDestination(restAPIAccessLogGroup),
        accessLogFormat: AccessLogFormat.custom(
          `{"tenantId":"$context.authorizer.tenantId", "responseLatency":"$context.responseLatency", "requestId":"$context.requestId", \
                    "ip":"$context.identity.sourceIp", "requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod", \
                    "routeKey":"$context.routeKey", "status":"$context.status", "protocol":"$context.protocol", \
                    "responseLength":"$context.responseLength", "resourcePath":"$context.resourcePath", "cellId":"${props.cellId}"}`),

        loggingLevel: MethodLoggingLevel.INFO,
      },
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: new TokenAuthorizer(this, `TenantAuthorizer-${props.cellId}`, {
          handler: authorizerLambda.lambdaFunction
        }),
      },
      cloudWatchRole: true
    });

    const cellAPILatency = new MetricFilter(this, `APIGatewayMetricFilterLatency-${props.cellId}`, {
      logGroup: restAPIAccessLogGroup,
      metricNamespace: 'SaaSApplicationPlane',
      metricName: 'CellAPILatency',
      filterPattern: FilterPattern.any(
        FilterPattern.stringValue('$.resourcePath', '=', '/product'),
      ),
      metricValue: '$.responseLatency',
      unit: Unit.MILLISECONDS,
      dimensions: {
        tenantId: '$.tenantId',
        status: '$.status',
        cellId: '$.cellId'
      },

    })

    const cellAPICount = new MetricFilter(this, `APIGatewayMetricFilterCount-${props.cellId}`, {
      logGroup: restAPIAccessLogGroup,
      metricNamespace: 'SaaSApplicationPlane',
      metricName: 'CellAPICount',
      filterPattern: FilterPattern.any(
        FilterPattern.stringValue('$.resourcePath', '=', '/product'),
      ),
      metricValue: '1',
      unit: Unit.COUNT,
      dimensions: {
        tenantId: '$.tenantId',
        status: '$.status',
        cellId: '$.cellId'
      },
    })


    const vpcLink = new VpcLink(this, `ECSVpcLink-${props.cellId}`, {
      targets: [nlb]
    });

    const integration = new HttpIntegration(`http://${nlb.loadBalancerDnsName}/product`, {
      httpMethod: 'ANY',
      proxy: true,
      options: {
        connectionType: ConnectionType.VPC_LINK,
        vpcLink: vpcLink,
        requestParameters: {
          'integration.request.header.tenantId': 'context.authorizer.tenantId'
        }
      },
    });

    // const integrationProductId = new HttpIntegration(`http://${nlb.loadBalancerDnsName}/product/{id}`, {
    //   httpMethod: 'ANY',
    //   proxy: true,
    //   options: {
    //     connectionType: ConnectionType.VPC_LINK,
    //     vpcLink: vpcLink,
    //     requestParameters: {
    //       'integration.request.header.tenantId': 'context.authorizer.tenantId'
    //     }
    //   },
    // });

    const productResource = api.root.addResource('product');
    //const productIDResource = productResource.addResource('{id}');

    productResource.addMethod('GET', integration);
    productResource.addMethod('POST', integration);
    // productIDResource.addMethod('GET', integrationProductId);
    // productIDResource.addMethod('PUT', integrationProductId);
    // productIDResource.addMethod('DELETE', integrationProductId);

    // Output values for import into other stacks
    new CfnOutput(this, `CellVpcId`, {value: vpc.vpcId, exportName: `CellVpcId-${props.cellId}`});
    new CfnOutput(this, `CellECSClusterName`, {
      value: cluster.clusterName,
      exportName: `CellECSClusterName-${props.cellId}`
    });
    new CfnOutput(this, `CellAsgName`, {value: asg.autoScalingGroupName, exportName: `CellAsgName-${props.cellId}`});
    new CfnOutput(this, `CellALBArn`, {value: alb.loadBalancerArn, exportName: `CellALBArn-${props.cellId}`});
    new CfnOutput(this, `CellListenerArn`, {
      value: listener.listenerArn,
      exportName: `CellListenerArn-${props.cellId}`
    });
    new CfnOutput(this, `CellALBSecurityGroupId`, {
      value: alb.connections.securityGroups[0].securityGroupId,
      exportName: `CellALBSecurityGroupId-${props.cellId}`
    });
    new CfnOutput(this, `CellApiUrl`, {value: api.url, exportName: `CellApiUrl-${props.cellId}`});
    new CfnOutput(this, `CellUserPoolId`, {
      value: identityProvider.identityDetails.details['userPoolId'],
      exportName: `CellUserPoolId-${props.cellId}`
    });
    new CfnOutput(this, `CellAppClientId`, {
      value: identityProvider.identityDetails.details['appClientId'],
      exportName: `CellAppClientId-${props.cellId}`
    });
    new CfnOutput(this, `CellTotalTenantsSupported`, {
      value: tenantsSupported.toString(),
      exportName: `CellTotalTenantsSupported-${props.cellId}`
    })
  }
}
