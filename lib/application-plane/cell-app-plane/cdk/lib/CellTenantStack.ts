import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { createHash } from 'crypto'
import { AwsCustomResource, AwsCustomResourcePolicy, AwsSdkCall, PhysicalResourceId } from 'aws-cdk-lib/custom-resources'
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CfnUserPoolUserToGroupAttachment, IUserPool } from "aws-cdk-lib/aws-cognito";
import { CdkNagUtils } from '../utils/cdk-nag-utils'

interface CellTenantStackProps extends cdk.StackProps {
    cellId: string;
    tenantId: string;
    tenantEmail: string;
    priorityBase: string;
    productImageVersion: string;
}

export class CellTenantStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CellTenantStackProps) {
        super(scope, id, props);

        // Handle CDK nag suppressions.
        CdkNagUtils.suppressCDKNag(this);

        const stack = Stack.of(this)
        const { tenantId } = props;

        if (!tenantId) {
            throw new Error('tenantId context parameter is required');
        }

        const tenantPriorityBase = Number(props.priorityBase);

        // Retrieve Account ID and Region from the environment context
        const accountId = cdk.Stack.of(this).account;
        const region = cdk.Stack.of(this).region;

        // Common Tags for all Tenant Specific AWS Resources 
        const commonTags = {            
            TenantId: tenantId
        };
        
        Object.entries(commonTags).forEach(([key, value]) => {
            Tags.of(this).add(key, value);
        });
        
        // Import values from ApplicationPlaneStack outputs
        const vpcId = cdk.Fn.importValue(`CellVpcId-${props.cellId}`);
        const clusterName = cdk.Fn.importValue(`CellECSClusterName-${props.cellId}`);
        const lbArn = cdk.Fn.importValue(`CellALBArn-${props.cellId}`);
        const listenerArn = cdk.Fn.importValue(`CellListenerArn-${props.cellId}`);
        const securityGroupId = cdk.Fn.importValue(`CellALBSecurityGroupId-${props.cellId}`);
        const rdsHost = cdk.Fn.importValue(`RDSClusterHost-${props.cellId}`);
        const rdsPort = cdk.Fn.importValue(`RDSClusterPort-${props.cellId}`);
        const userPoolId = cdk.Fn.importValue(`CellUserPoolId-${props.cellId}`);
        const appClientId = cdk.Fn.importValue(`CellAppClientId-${props.cellId}`);

        // Import VPC using the VPC ID
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
            vpcId: vpcId,
            availabilityZones: cdk.Fn.getAzs()
        });

        // Import ECS Cluster using the Cluster Name
        const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
            clusterName: clusterName,
            vpc: vpc
        });

        // Import Security Group
        const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'SecurityGroup', securityGroupId);

        // Import Load Balancer
        const lb = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, 'LoadBalancer', {
            loadBalancerArn: lbArn,
            securityGroupId: securityGroupId
        });

        // Import existing listener using Listener ARN
        const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'ExistingListener', {
            listenerArn: listenerArn,
            securityGroup: securityGroup
        });

        // Create an IAM role for ECS Task Definition
        const adminRoleTasdef = new iam.Role(this, 'AdminRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        adminRoleTasdef.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
        );

        // Create an ECS task definition with the admin role
        const taskDefinition = new ecs.Ec2TaskDefinition(this, `TaskDef_${tenantId}`, {
            executionRole: adminRoleTasdef,
            taskRole: adminRoleTasdef
        });

        Object.entries(commonTags).forEach(([key, value]) => {
            Tags.of(taskDefinition).add(key, value);
        });

        // Add a container to the task definition
        const container = taskDefinition.addContainer('product', {
            image: ecs.ContainerImage.fromRegistry(`${accountId}.dkr.ecr.${region}.amazonaws.com/product-service:${props.productImageVersion}`),
            cpu: 256,
            memoryLimitMiB: 512,
            environment: {
                AWS_ACCOUNT_ID: accountId,
                AWS_REGION: region
            },
            logging: ecs.LogDriver.awsLogs({ streamPrefix: 'product', logRetention: 7 })
        });

        // Add port mapping to the container
        container.addPortMappings({
            containerPort: 80,
            hostPort: 0,
            protocol: ecs.Protocol.TCP
        });

        // Create an ECS service
        const service = new ecs.Ec2Service(this, 'Service', {
            cluster: cluster,
            taskDefinition: taskDefinition,
            propagateTags: ecs.PropagatedTagSource.SERVICE,
            circuitBreaker: { enable: true, rollback: true }
        });

        // Grant the task role permissions to pull the image from ECR
        const repository = ecr.Repository.fromRepositoryAttributes(this, 'ProductServiceRepo', {
            repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/product-service`,
            repositoryName: `product-service`
        });
        repository.grantPull(taskDefinition.taskRole);

        const healthCheck = {
            interval: cdk.Duration.seconds(60),
            path: '/health',
            timeout: cdk.Duration.seconds(5)
        };

        // Create a Target Group for the ECS service
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            vpc: vpc,
            port: 80,
            targets: [service],
            healthCheck: healthCheck
        });

        // Add Listener Rule for HTTP Header and Path '/upload'
        listener.addAction('ListenerRuleUpload', {
            priority: tenantPriorityBase + 1,
            conditions: [
                elbv2.ListenerCondition.httpHeader('tenantId', [tenantId]),
                elbv2.ListenerCondition.pathPatterns(['/product', '/product/*'])
            ],
            action: elbv2.ListenerAction.forward([targetGroup])
        });

        // Add Listener Rule for HTTP Header and Path '/health'
        listener.addAction('ListenerRuleSvcHealth', {
            priority:  tenantPriorityBase + 2,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/health'])
            ],
            action: elbv2.ListenerAction.forward([targetGroup])
        });

        // Add Listener Rule for '/'
        listener.addAction('ListenerRuleDefault', {
            priority:  tenantPriorityBase + 3,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/'])
            ],
            action: elbv2.ListenerAction.forward([targetGroup])
        });                


        //provision database
        const tenantSecret = new secretsmanager.Secret(
            this,
            props.tenantId + 'Credentials',
            {
                secretName: props.tenantId + 'Credentials',
                description: props.tenantId + 'Credentials',
                generateSecretString: {
                excludeCharacters: "\"@/\\ '",
                generateStringKey: 'password',
                passwordLength: 30,
                secretStringTemplate: JSON.stringify({username: props.tenantId, host: rdsHost, port: rdsPort}),
                },
            },
        );
        
        //import existing lambda function
        const lambdaFunctionName = cdk.Fn.importValue(`TenantRDSInitializerLambdaName-${props.cellId}`);

        const lambdaFunction = lambda.Function.fromFunctionName(this, 'LambdaFunction', lambdaFunctionName);

        // Custom resource for tenant provisioning - create new database and tables
        const provisionPayload: string = JSON.stringify({
            tenantId: props.tenantId,
            tenantSecretName: props.tenantId + 'Credentials',
            tenantState: 'PROVISION'
        })
        const provisionPayloadHashPrefix = createHash('md5').update(provisionPayload).digest('hex').substring(0, 6)

        const sdkProvisioningCall: AwsSdkCall = {
          service: 'Lambda',
          action: 'invoke',
          parameters: {
            FunctionName: lambdaFunction.functionName,
            Payload: provisionPayload
          },
          physicalResourceId: PhysicalResourceId.of(`${id}-AwsSdkCall-${lambdaFunction.latestVersion + provisionPayloadHashPrefix}`)
        }
        
        const provisioningCustomResourceFnRole = new iam.Role(this, 'AwsProvisioningCustomResourceRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
        })
        provisioningCustomResourceFnRole.addToPolicy(
          new iam.PolicyStatement({
            resources: [lambdaFunction.functionArn],
            actions: ['lambda:InvokeFunction']
          })
        )
        const provisioningCustomResource = new AwsCustomResource(this, 'AwsProvisioningCustomResource', {
          policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
          onCreate: sdkProvisioningCall,
          timeout: cdk.Duration.minutes(10),
          role: provisioningCustomResourceFnRole
        })

        provisioningCustomResource.node.addDependency(tenantSecret)


        // Custom resource for tenant de-provisioning - drop database and users
        const deprovisionPayload: string = JSON.stringify({
            tenantId: props.tenantId,
            tenantSecretName: props.tenantId + 'Credentials',
            tenantState: 'DE-PROVISION'
        })
        const deprovisionPayloadHashPrefix = createHash('md5').update(deprovisionPayload).digest('hex').substring(0, 6)

        const deprovisioningSdkCall: AwsSdkCall = {
            service: 'Lambda',
            action: 'invoke',
            parameters: {
              FunctionName: lambdaFunction.functionName,
              Payload: deprovisionPayload
            },
            physicalResourceId: PhysicalResourceId.of(`${id}-AwsSdkCall-${lambdaFunction.latestVersion + deprovisionPayloadHashPrefix}`)
          }
          
        const deprovisioningCustomResourceFnRole = new iam.Role(this, 'AwsDeProvisioningCustomResourceRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
        })
        deprovisioningCustomResourceFnRole.addToPolicy(
        new iam.PolicyStatement({
            resources: [lambdaFunction.functionArn],
            actions: ['lambda:InvokeFunction']
        })
        )
        const deprovisioningCustomResource = new AwsCustomResource(this, 'AwsDeProvisioningCustomResource', {
        policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
        onDelete: deprovisioningSdkCall,
        timeout: cdk.Duration.minutes(10),
        role: deprovisioningCustomResourceFnRole
        })
        deprovisioningCustomResource.node.addDependency(tenantSecret)
        
        const tenantAdminUsername = `tenantadmin-${tenantId}`
        
        // Create the user inside the Cognito user pool using Lambda backed AWS Custom resource
        const adminCreateUser = new AwsCustomResource(this, 'AwsCustomResource-CreateUser', {
            onCreate: {
                service: 'CognitoIdentityServiceProvider',
                action: 'adminCreateUser',
                parameters: {
                    UserPoolId: userPoolId,
                    Username: tenantAdminUsername,                                        
                    UserAttributes: [
                        {
                            Name: 'custom:tenantId',
                            Value: tenantId,
                        },
                        {
                            Name: 'custom:role',
                            Value: 'TenantAdmin',
                        },
                        {
                            Name: 'email',
                            Value: props.tenantEmail,
                        },
                    ],
                },
                physicalResourceId: PhysicalResourceId.of(`AwsCustomResource-CreateUser-${tenantId}`),
            },
            onDelete: {
                service: "CognitoIdentityServiceProvider",
                action: "adminDeleteUser",
                parameters: {
                    UserPoolId: userPoolId,
                    Username: tenantAdminUsername,
                },
            },
            policy: AwsCustomResourcePolicy.fromSdkCalls({resources: AwsCustomResourcePolicy.ANY_RESOURCE}),
            installLatestAwsSdk: true,
        });

        // Create a custom resource to create a new user group for the tenant 
       const adminCreateGroup = new AwsCustomResource(this, 'AwsCustomResource-CreateGroup', {
            onCreate: {
                service: 'CognitoIdentityServiceProvider',
                action: 'createGroup',
                parameters: {
                    GroupName: tenantId,
                    UserPoolId: userPoolId,
                    Description: `Group for tenant ${tenantId}`,
                    Precedence: 0,
                },
                physicalResourceId: PhysicalResourceId.of(`AwsCustomResource-CreateGroup-${tenantId}`),
            },
            onDelete: {
                service: "CognitoIdentityServiceProvider",
                action: "deleteGroup",
                parameters: {
                    GroupName: tenantId,
                    UserPoolId: userPoolId,
                },
            },
            policy: AwsCustomResourcePolicy.fromSdkCalls({resources: AwsCustomResourcePolicy.ANY_RESOURCE}),
            installLatestAwsSdk: true,
        });

        // attach tenant admin to group
        const userToAdminsGroupAttachment = new CfnUserPoolUserToGroupAttachment(this, 'AttachAdminToAdminsGroup', {
            userPoolId: userPoolId,
            groupName: tenantId,
            username: tenantAdminUsername,
        });
        userToAdminsGroupAttachment.node.addDependency(adminCreateUser);
        userToAdminsGroupAttachment.node.addDependency(adminCreateGroup);

        new cdk.CfnOutput(this, `ECSServiceName-${tenantId}`, { value: service.serviceName, exportName: `EcsService-${tenantId}` });
    }
}
