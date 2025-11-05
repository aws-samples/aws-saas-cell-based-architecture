import {
    Stack,
    StackProps,
    CfnOutput,
    Tags,
    App,
    Fn,
    Duration,
    RemovalPolicy,
  } from 'aws-cdk-lib';
  import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
  import * as ec2 from 'aws-cdk-lib/aws-ec2';
  import * as kms from 'aws-cdk-lib/aws-kms';
  import * as logs from 'aws-cdk-lib/aws-logs';
  import * as rds from 'aws-cdk-lib/aws-rds';
  import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
  import { Construct } from 'constructs';
  import { TenantRDSInitializer } from './TenantRdsInitializerConstruct';

  
  export interface AuroraProps extends StackProps {
    cellId: string;
    vpc: ec2.IVpc;
    auroraClusterUsername: string;
    dbName: string;
    instanceType?: any;
    backupRetentionDays?: number;
    backupWindow?: string;
    preferredMaintenanceWindow?: string;
    ingressSources?: any[];
    description?:string;
  
  }
    
  export class AuroraPostgres extends Construct {
    constructor(scope: Construct, id: string, props:AuroraProps) {
      super(scope, id);
  
        let instanceType = props.instanceType;
        let backupRetentionDays = props.backupRetentionDays ?? 14;

        var ingressSources = [];
        if (typeof props.ingressSources !== 'undefined') {
            ingressSources = props.ingressSources;
        }

        if (backupRetentionDays < 14) {
            backupRetentionDays = 14;
        }
      
        // vpc
        const vpc = props.vpc        
        const isolated_subnets = vpc.isolatedSubnets;

        // all the ports
        const allAll = ec2.Port.allTraffic();
        const tcp5432 = ec2.Port.tcpRange(5432, 5432);
        
        let connectionPort: any;
        let connectionName: string;

        // Database Security Group
        const dbsg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
        vpc: vpc,
        allowAllOutbound: true,
        description: id + 'Database',
        securityGroupName: id + 'Database',
        });
        dbsg.addIngressRule(dbsg, allAll, 'all from self');
        dbsg.addEgressRule(ec2.Peer.ipv4('0.0.0.0/0'), allAll, 'all out');

        
        connectionPort = tcp5432;
        connectionName = 'tcp5432 PostgresSQL';

        for (let ingress_source of ingressSources!) {
            dbsg.addIngressRule(ingress_source, connectionPort, connectionName);            
        }

        // Declaring postgres engine
        let auroraEngine = rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_10,
        });

        let auroraParameters: any = {};
        // aurora params
        const auroraParameterGroup = new rds.ParameterGroup(
            this,
            'AuroraParameterGroup',
            {
                engine: auroraEngine,
                description: id + ' Parameter Group',
                parameters: auroraParameters,
            },
        );

        const auroraClusterSecret = new secretsmanager.Secret(
            this,
            'AuroraClusterCredentials',
            {
                secretName: props.dbName + `AuroraClusterCredentials-${props.cellId}`,
                description: props.dbName + `AuroraClusterCredentials-${props.cellId}`,
                generateSecretString: {
                excludeCharacters: "\"@/\\ '",
                generateStringKey: 'password',
                passwordLength: 30,
                secretStringTemplate: JSON.stringify({username: props.auroraClusterUsername}),
                },
            },
        );

        // aurora credentials
        const auroraClusterCredentials = rds.Credentials.fromSecret(
            auroraClusterSecret,
            props.auroraClusterUsername,
        );

        if (instanceType == null || instanceType == undefined) {
            instanceType = ec2.InstanceType.of(
                ec2.InstanceClass.BURSTABLE4_GRAVITON,
                ec2.InstanceSize.SMALL,
            );
        }

        // Aurora DB Key
        const kmsKey = new kms.Key(this, 'AuroraDatabaseKey', {
            enableKeyRotation: true,
            alias: props.dbName,
        });

        let cloudwatchLogsExports: any = ['postgresql'];
        
        const tenantRDSInitializer = new TenantRDSInitializer(this, `TenantRDSInitializer-${props.cellId}`, {
            cellId: props.cellId,
            vpc: vpc,
            dbCredSecretName: auroraClusterSecret.secretName,
            secretArn: auroraClusterSecret.secretArn            
        });

        dbsg.addIngressRule(tenantRDSInitializer.fnSg, connectionPort, connectionName);            

        const aurora_cluster = new rds.DatabaseCluster(this, 'AuroraDatabase', {
        engine: auroraEngine,
        credentials: auroraClusterCredentials,
        backup: {
            preferredWindow: props.backupWindow,
            retention: Duration.days(backupRetentionDays),
        },
        parameterGroup: auroraParameterGroup,
        storageEncrypted: true,
        storageEncryptionKey: kmsKey,
        deletionProtection: false,//setting this so that resource cleanup can be clean. Ideally should be true
        removalPolicy: RemovalPolicy.DESTROY,//setting this so that resource cleanup can be clean. Ideally should be something different
        copyTagsToSnapshot: true,
        cloudwatchLogsExports: cloudwatchLogsExports,
        cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
        preferredMaintenanceWindow: props.preferredMaintenanceWindow,
        instanceIdentifierBase: props.dbName,
        writer: rds.ClusterInstance.provisioned('writer',
            { instanceType: instanceType }),
        vpc: vpc,    
        vpcSubnets: {
            subnets : isolated_subnets
        },                
        securityGroups: [dbsg],
        
        });

        aurora_cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

        Tags.of(aurora_cluster).add('Name', props.dbName!, {
            priority: 300,
        });

        // aurora_cluster.addRotationSingleUser({
        // automaticallyAfter: Duration.days(30),
        // excludeCharacters: "\"@/\\ '",
        // vpcSubnets: {
        //         subnets : private_subnets
        //     },
        // });
        

        
        /*
        * CloudWatch Dashboard
        */

        const dashboard = new cloudwatch.Dashboard(this, 'AuroraMonitoringDashboard', {
            dashboardName: props.dbName,
        });
  
        let dbConnections = aurora_cluster.metricDatabaseConnections();
        let cpuUtilization = aurora_cluster.metricCPUUtilization();
        let deadlocks = aurora_cluster.metricDeadlocks();
        let freeLocalStorage = aurora_cluster.metricFreeLocalStorage();
        let freeableMemory = aurora_cluster.metricFreeableMemory();
        let networkRecieveThroughput = aurora_cluster.metricNetworkReceiveThroughput();
        let networkThroughput = aurora_cluster.metricNetworkThroughput();
        let networkTransmitThroughput = aurora_cluster.metricNetworkTransmitThroughput();
        let snapshotStorageUsed = aurora_cluster.metricSnapshotStorageUsed();
        let totalBackupStorageBilled = aurora_cluster.metricTotalBackupStorageBilled();
        let volumeBytesUsed = aurora_cluster.metricVolumeBytesUsed();
        let volumeReadIoPs = aurora_cluster.metricVolumeReadIOPs();
        let volumeWriteIoPs = aurora_cluster.metricVolumeWriteIOPs();
    
    
        //  The average amount of time taken per disk I/O operation (average over 1 minute)
        const readLatency = aurora_cluster.metric('ReadLatency', {
            statistic: 'Average',
            period: Duration.seconds(60),
        });
    
        const widgetDbConnections = new cloudwatch.GraphWidget({
            title: 'DB Connections',
            // Metrics to display on left Y axis.
            left: [dbConnections],
        });
    
        const widgetCpuUtilizaton = new cloudwatch.GraphWidget({
            title: 'CPU Utilization',
            // Metrics to display on left Y axis
            left: [cpuUtilization],
        });
    
        const widgetReadLatency = new cloudwatch.GraphWidget({
            title: 'Read Latency',
            //  Metrics to display on left Y axis.
            left: [readLatency],
        });
    
        freeLocalStorage = aurora_cluster.metricFreeLocalStorage();
        freeableMemory = aurora_cluster.metricFreeableMemory();
        networkRecieveThroughput = aurora_cluster.metricNetworkReceiveThroughput();
        networkThroughput = aurora_cluster.metricNetworkThroughput();
        networkTransmitThroughput = aurora_cluster.metricNetworkTransmitThroughput();
        snapshotStorageUsed = aurora_cluster.metricSnapshotStorageUsed();
        totalBackupStorageBilled = aurora_cluster.metricTotalBackupStorageBilled();
        volumeBytesUsed = aurora_cluster.metricVolumeBytesUsed();
        volumeReadIoPs = aurora_cluster.metricVolumeReadIOPs();
        volumeWriteIoPs = aurora_cluster.metricVolumeWriteIOPs();
    
        const widgetDeadlocks = new cloudwatch.GraphWidget({
            title: 'Deadlocks',
            left: [deadlocks],
        });
    
        const widgetFreeLocalStorage = new cloudwatch.GraphWidget({
            title: 'Free Local Storage',
            left: [freeLocalStorage],
        });
    
        const widgetFreeableMemory = new cloudwatch.GraphWidget({
            title: 'Freeable Memory',
            left: [freeableMemory],
        });
    
        const widget_network_receive_throughput = new cloudwatch.GraphWidget({
            title: 'Network Throughput',
            left: [networkRecieveThroughput, networkThroughput, networkTransmitThroughput],
    
        });
    
        const widgetTotalBackupStorageBilled = new cloudwatch.GraphWidget({
            title: 'Backup Storage Billed',
            left: [totalBackupStorageBilled],
        });
    
        const widgetVolumeBytes = new cloudwatch.GraphWidget({
            title: 'Storage',
            left: [volumeBytesUsed, snapshotStorageUsed],
        });
    
        const widgetVolumeIops = new cloudwatch.GraphWidget({
            title: 'Volume IOPs',
            left: [volumeReadIoPs, volumeWriteIoPs],
        });
    
    
        dashboard.addWidgets(
            widgetDbConnections,
            widgetCpuUtilizaton
        );
        dashboard.addWidgets(
            widgetTotalBackupStorageBilled,
            widgetFreeLocalStorage
        );
        dashboard.addWidgets(
            widgetFreeableMemory,
            widgetVolumeBytes,
            widgetVolumeIops,
        );
        dashboard.addWidgets(
            widget_network_receive_throughput,
            widgetReadLatency,
            widgetDeadlocks,
        );

      

        new CfnOutput(this, `RDSSecretName-${props.cellId}`, {
            exportName: aurora_cluster.stack.stackName+':SecretName',
            value: aurora_cluster.secret?.secretArn!,
        });

        new CfnOutput(this, `RDSSecretArn-${props.cellId}`, {
            exportName: aurora_cluster.stack.stackName+':SecretArn',
            value: aurora_cluster.secret?.secretArn!,
        });


        new CfnOutput(this, `RDSInstanceIdentifiers-${props.cellId}`, {
            exportName: aurora_cluster.stack.stackName+'InstanceIdentifiers',
            value: aurora_cluster.instanceIdentifiers.toString(),
        });

        const instance_endpoints:any = [];

        for (let ie of aurora_cluster.instanceEndpoints) {
            instance_endpoints.push(ie.hostname);
        }
        new CfnOutput(this, `RDSEndpoints-${props.cellId}`, {
            exportName: `RDSEndpoints-${props.cellId}`,
            value: instance_endpoints.toString(),
        });

        new CfnOutput(this, `RDSClusterEndpoint-${props.cellId}`, {
            exportName: `RDSClusterEndpoint-${props.cellId}`,
            value: aurora_cluster.clusterEndpoint.socketAddress,
        });

        new CfnOutput(this, `RDSClusterHost-${props.cellId}`, {
            exportName: `RDSClusterHost-${props.cellId}`,
            value: aurora_cluster.clusterEndpoint.hostname,
        });

        new CfnOutput(this, `RDSClusterPort-${props.cellId}`, {
            exportName: `RDSClusterPort-${props.cellId}`,
            value: aurora_cluster.clusterEndpoint.port.toString(),
        });

        

    }
  
  }
  
  
  
  
  
  
  
  