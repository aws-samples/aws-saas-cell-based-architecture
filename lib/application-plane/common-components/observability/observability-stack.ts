import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration, Tags } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';

import { CdkNagUtils } from './src/utils/cdk-nag-utils'
import { Construct } from 'constructs';
import { Dashboard, GraphWidget, MathExpression, Row, GraphWidgetView, TextWidget } from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export interface CommonObservabilityProps extends StackProps {
  readonly distributionId: string
}

export class CommonObservability extends Stack {

  readonly aggregateHttp5xxAlarmName: string ;

  constructor(scope: Construct, id: string, props: CommonObservabilityProps) {
    super(scope, id, props);

    // Handle CDK nag suppressions.
    CdkNagUtils.suppressCDKNag(this);

    Tags.of(this).add('SaaSApplicationService', `Observability`);                

    //TODO: Paste the code for the aggregated alarms, below this line             
    
    const applicationPlaneHealthDashboard = new Dashboard(this, 'ApplicationPlaneHealthDashboard', {
        dashboardName: 'SaaS-App-Plane-Health-Dashboard',
        defaultInterval: Duration.minutes(30)          
    });

    applicationPlaneHealthDashboard.addWidgets(
        new TextWidget({
            markdown: `# Application Plane Health Dashboard`,
            height: 1,
            width: 24
        }),
        //TODO: Paste the code for aggregated metrics, below this line
            
        //TODO: Paste the code for the alarm widgets, below this line     
                  
        new Row(
            new GraphWidget({
                title: 'Total API Requests By Cell',
                left: [
                    new MathExpression({
                        expression: 'SELECT COUNT(CellAPICount) FROM SaaSApplicationPlane GROUP BY cellId',
                        label: 'Requests',                            
                    })
                ],
                leftYAxis: {
                    label: 'Count',
                    showUnits: false
                },
                period: Duration.minutes(1),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
            new GraphWidget({
                title: 'Average API Latency By Cell',                    
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(CellAPILatency) FROM SaaSApplicationPlane GROUP BY cellId',
                        label: 'Latency',                            
                    })
                ],
                leftYAxis: {
                    label: 'Milliseconds',
                    showUnits: false
                },
                period: Duration.minutes(1),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            })
        ),
        new Row(
            new GraphWidget({
                title: 'Database ReadIOPS By Cell',
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(ReadIOPS) FROM "AWS/RDS" GROUP BY DBClusterIdentifier',
                        label: 'ReadIOPS',                            
                    })
                ],
                leftYAxis: {
                    label: 'Count/Second',
                    showUnits: false
                },
                period: Duration.minutes(5),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
            new GraphWidget({
                title: 'Database WriteIOPS By Cell',
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(WriteIOPS) FROM "AWS/RDS" GROUP BY DBClusterIdentifier',
                        label: 'WriteIOPS',
                    })
                ],
                leftYAxis: {
                    label: 'Count/Second',
                    showUnits: false
                },
                period: Duration.minutes(5),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
            new GraphWidget({
                title: 'Database CPU Utilization By Cell',                    
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(CPUUtilization) FROM "AWS/RDS" GROUP BY DBClusterIdentifier',
                        label: 'CPUUtilization',                            
                    })
                ],
                leftYAxis: {
                    label: 'Percent',
                    showUnits: false
                },         
                period: Duration.minutes(5),           
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
        ),
        new Row(
            new GraphWidget({
                title: 'ECS CPU Utilization By Cell',
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(CPUUtilization) FROM "AWS/ECS" GROUP BY ClusterName',
                        label: 'CPU Utilization',                            
                    })
                ],
                leftYAxis: {
                    label: 'Percent',
                    showUnits: false
                },
                period: Duration.minutes(5),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
            new GraphWidget({
                title: 'ECS Memory Utilization By Cell',
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(MemoryUtilization) FROM "AWS/ECS" GROUP BY ClusterName',
                        label: 'Memory Utilization',                            
                    })
                ],
                leftYAxis: {
                    label: 'Percent',
                    showUnits: false
                },
                period: Duration.minutes(5),
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
            new GraphWidget({
                title: 'Tenant CPU Utilization',                    
                left: [
                    new MathExpression({
                        expression: 'SELECT AVG(CPUUtilization) FROM "AWS/ECS" GROUP BY ServiceName',
                        label: 'CPUUtilization',                            
                    })
                ],
                leftYAxis: {
                    label: 'Percent',
                    showUnits: false
                },         
                period: Duration.minutes(5),           
                width: 8,
                height: 6,
                liveData: true,
                view: GraphWidgetView.TIME_SERIES
            }),
        )             
    )
  }
}
