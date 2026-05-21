import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { type Construct } from "constructs";
import { type AppStack } from "./app-stack";
import { type SpsEnvConfig } from "./config";
import { type DataStack } from "./data-stack";

/**
 * The email subscribed to the **notify** topic (cost guardrails + low-urgency
 * fan-out). The page topic carries no email subscription — a Microsoft Teams
 * channel webhook is subscribed out-of-band per docs/oncall.md (B23 split).
 * ADR-008 records the address in the secrets-stack convention; this is the
 * operator's work email for live ops traffic, not the harness identity.
 */
const NOTIFY_SUBSCRIBER_EMAIL = "paa2013@med.cornell.edu";

/**
 * Account-wide monthly budget ceiling. Calibrated to roughly 40% headroom
 * above the audited Phase 0+1 baseline (~$425/mo combined across both envs)
 * so it catches a runaway provisioning before the bill arrives without
 * false-firing on routine variance. Quarterly review per docs/SLOs.md.
 */
const MONTHLY_BUDGET_USD = 600;

/**
 * Cost Anomaly Detection threshold in USD/day. The baseline daily spend at
 * this writing is ~$14; a 4x spike (the kind we want to catch) is north of
 * $50, while a normal 1.5x bumpy day is under $20. Re-tune after the first
 * month of post-launch data.
 */
const COST_ANOMALY_DAILY_USD = 50;

/** Latency SLO target in milliseconds. Mirrored from docs/SLOs.md. */
const LATENCY_P99_THRESHOLD_MS = 1500;

/** Props for {@link SpsObservabilityStack}. */
export interface ObservabilityStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** AppStack instance — read ALB / target group / ECS service references. */
  readonly appStack: AppStack;
  /** DataStack instance — read Aurora cluster / OpenSearch domain references. */
  readonly dataStack: DataStack;
}

/**
 * ObservabilityStack — alarms, alarm destination, and (prod only) the
 * account-wide cost guardrails (ADR-008, B22+B23).
 *
 * Per-env stack (`Sps-Observability-{env}`). Eight CloudWatch alarms cover
 * the public ALB / ECS / Aurora / OpenSearch surfaces; every alarm publishes
 * to the env's **page** SNS topic (`sps-alarms-{env}`), which a Microsoft
 * Teams channel webhook is subscribed to via HTTPS out-of-band per
 * docs/oncall.md. (Teams matches the WCM-native ops pattern; ServiceNow
 * incident integration tracked as a B23 follow-on.)
 *
 * The stack creates a second **notify** SNS topic (`sps-notify-{env}`) used
 * exclusively for low-urgency fan-out: the account-wide budget thresholds and
 * the Cost Anomaly Detection subscriber publish there, and the operator's
 * work email is subscribed there. The page topic carries zero email
 * subscriptions so a forecasted-budget tap can't wake on-call at 02:00 (B23).
 *
 * The budget and Cost Anomaly Detection monitor are account-wide AWS
 * resources, so they are created by the prod stack only -- deploying them
 * twice (once per env) would conflict on the AWS-side name. Staging synth
 * therefore contains zero AWS::Budgets::Budget and zero AWS::CE::*
 * resources; this is asserted by the test file.
 */
export class SpsObservabilityStack extends Stack {
  /** SNS topic every alarm in this stack publishes to. Teams channel webhook subscribed out-of-band. */
  public readonly alarmTopic: sns.Topic;
  /**
   * SNS topic for low-urgency fan-out: budget thresholds, cost-anomaly
   * subscriber, and the operator email. Separate from `alarmTopic` so a
   * forecasted-spend tap doesn't page on-call (B23).
   */
  public readonly notifyTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { envConfig, appStack, dataStack } = props;
    const env = envConfig.envName;

    // ------------------------------------------------------------------
    // SNS topics — page (alarms -> Teams channel) and notify (cost -> email)
    // ------------------------------------------------------------------
    // Page topic keeps the B22 name `sps-alarms-${env}` to avoid a
    // replacement-style logical-id churn on the existing CFN resource (and
    // to keep the staging-side email-confirmation grant chain intact across
    // the deploy). The Teams channel webhook is added as an HTTPS
    // subscription out-of-band per docs/oncall.md; no AWS::SNS::Subscription
    // is declared here.
    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `sps-alarms-${env}`,
      displayName: `SPS ${env} alarms (page)`,
    });

    // Notify topic carries the cost guardrail fan-out and the operator
    // email. Distinct topic, distinct logical id, distinct AWS-side name.
    this.notifyTopic = new sns.Topic(this, "NotifyTopic", {
      topicName: `sps-notify-${env}`,
      displayName: `SPS ${env} notifications (notify)`,
    });
    this.notifyTopic.addSubscription(
      new snsSubs.EmailSubscription(NOTIFY_SUBSCRIBER_EMAIL),
    );

    const snsAction = new cwActions.SnsAction(this.alarmTopic);

    // ------------------------------------------------------------------
    // Public ALB alarms (3)
    // ------------------------------------------------------------------
    // (1) 5xx rate -- ratio of target-side 5xx to total request count.
    // Math expression rather than a raw count so a quiet period at 0 RPS
    // does not false-fire on a single error.
    const alb5xxRate = new cloudwatch.MathExpression({
      expression: "(m5xx / IF(reqs > 0, reqs, 1)) * 100",
      usingMetrics: {
        m5xx: appStack.publicAlb.metrics.httpCodeTarget(
          elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
          { statistic: "Sum", period: Duration.minutes(5) },
        ),
        reqs: appStack.publicAlb.metricRequestCount({
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
      },
      label: "5xx rate (%) over 5m",
      period: Duration.minutes(5),
    });
    const alb5xxAlarm = new cloudwatch.Alarm(this, "PublicAlb5xxRateAlarm", {
      alarmName: `sps-alb-5xx-rate-${env}`,
      alarmDescription: `Public ALB target 5xx rate exceeds 1% over 5m (${env}). Burns the 99.5% availability SLO budget. See docs/SLOs.md.`,
      metric: alb5xxRate,
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alb5xxAlarm.addAlarmAction(snsAction);

    // (2) Unhealthy host count -- requires both LoadBalancer + TargetGroup
    // dimensions; metric pulled off the target group directly.
    const unhealthyAlarm = new cloudwatch.Alarm(
      this,
      "PublicAlbUnhealthyHostsAlarm",
      {
        alarmName: `sps-alb-unhealthy-hosts-${env}`,
        alarmDescription: `Public ALB has zero healthy targets for 5 consecutive minutes (${env}). Circuit-breaker did not catch it -- real outage.`,
        metric: appStack.publicTargetGroup.metrics.unhealthyHostCount({
          statistic: "Maximum",
          period: Duration.minutes(1),
        }),
        threshold: 0,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    unhealthyAlarm.addAlarmAction(snsAction);

    // (3) Latency p99 -- the latency SLI directly.
    const latencyAlarm = new cloudwatch.Alarm(
      this,
      "PublicAlbLatencyP99Alarm",
      {
        alarmName: `sps-alb-latency-p99-${env}`,
        alarmDescription: `Public ALB target response time p99 > ${LATENCY_P99_THRESHOLD_MS}ms over 5m (${env}). Burns the latency SLO budget. See docs/SLOs.md.`,
        metric: appStack.publicAlb.metrics.targetResponseTime({
          statistic: "p99",
          period: Duration.minutes(5),
        }),
        threshold: LATENCY_P99_THRESHOLD_MS / 1000, // ALB metric is seconds
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    latencyAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // ECS service alarms (1)
    // ------------------------------------------------------------------
    // (4) Running task count below desired -- a math expression so the
    // alarm fires when running < desired regardless of the desired-count
    // value (handles bootstrap appDesiredCount=0 case correctly: 0 < 0 is
    // false, no false-fire).
    const taskCountShortfall = new cloudwatch.MathExpression({
      expression: "desired - running",
      usingMetrics: {
        desired: appStack.ecsService.metric("DesiredTaskCount", {
          statistic: "Maximum",
          period: Duration.minutes(1),
        }),
        running: appStack.ecsService.metric("RunningTaskCount", {
          statistic: "Minimum",
          period: Duration.minutes(1),
        }),
      },
      label: "Desired - Running tasks (5m)",
      period: Duration.minutes(1),
    });
    const taskShortfallAlarm = new cloudwatch.Alarm(
      this,
      "EcsTaskShortfallAlarm",
      {
        alarmName: `sps-ecs-task-shortfall-${env}`,
        alarmDescription: `ECS service running task count is below desired for 5 consecutive minutes (${env}). Tasks died and are not being replaced.`,
        metric: taskCountShortfall,
        threshold: 0,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    taskShortfallAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // Aurora cluster alarms (2)
    // ------------------------------------------------------------------
    // (5) CPU -- catches hot loops + runaway queries.
    const auroraCpuAlarm = new cloudwatch.Alarm(this, "AuroraCpuAlarm", {
      alarmName: `sps-aurora-cpu-${env}`,
      alarmDescription: `Aurora cluster CPU > 80% sustained for 10m (${env}). Likely a hot query loop or runaway analytic.`,
      metric: dataStack.auroraCluster.metricCPUUtilization({
        statistic: "Average",
        period: Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auroraCpuAlarm.addAlarmAction(snsAction);

    // (6) Connection count -- catches connection-pool exhaustion before
    // the app starts surfacing connection errors. Threshold is absolute
    // (80 connections) rather than percent-of-max since Aurora Serverless
    // v2 max scales with capacity and the raw number is easier to reason
    // about. 80 covers writer-pool defaults + headroom.
    const auroraConnectionsAlarm = new cloudwatch.Alarm(
      this,
      "AuroraConnectionsAlarm",
      {
        alarmName: `sps-aurora-connections-${env}`,
        alarmDescription: `Aurora active connection count > 80 sustained over 5m (${env}). Symptom of connection-pool exhaustion or unintended app fan-out.`,
        metric: dataStack.auroraCluster.metricDatabaseConnections({
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 80,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    auroraConnectionsAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // OpenSearch domain alarms (2)
    // ------------------------------------------------------------------
    // (7) JVM memory pressure -- GC pressure cascades into query latency.
    const openSearchJvmAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchJvmPressureAlarm",
      {
        alarmName: `sps-opensearch-jvm-pressure-${env}`,
        alarmDescription: `OpenSearch JVM memory pressure > 85% for 15m (${env}). GC pressure will cascade into query latency.`,
        metric: dataStack.opensearchDomain.metric("JVMMemoryPressure", {
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 85,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    openSearchJvmAlarm.addAlarmAction(snsAction);

    // (8) Cluster status red -- shards unassigned, immediate.
    const openSearchRedAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchClusterRedAlarm",
      {
        alarmName: `sps-opensearch-cluster-red-${env}`,
        alarmDescription: `OpenSearch cluster status is RED (${env}). Shards unassigned -- searches affected.`,
        metric: dataStack.opensearchDomain.metric("ClusterStatus.red", {
          statistic: "Maximum",
          period: Duration.minutes(1),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    openSearchRedAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // Prod-only: account-wide cost guardrail
    // ------------------------------------------------------------------
    // Budget and Cost Anomaly Detection are account-scoped resources. If
    // both the staging and prod stacks created them, CloudFormation would
    // conflict on the AWS-side name on the second deploy. Guarded behind
    // env === "prod"; staging synth contains zero of these resources, which
    // is asserted in the test file.
    if (env === "prod") {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "sps-monthly-budget",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: MONTHLY_BUDGET_USD,
            unit: "USD",
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "FORECASTED",
              threshold: 50,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                subscriptionType: "SNS",
                address: this.notifyTopic.topicArn,
              },
            ],
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "FORECASTED",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                subscriptionType: "SNS",
                address: this.notifyTopic.topicArn,
              },
            ],
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                subscriptionType: "SNS",
                address: this.notifyTopic.topicArn,
              },
            ],
          },
        ],
      });

      // AWS Budgets publishes to SNS via the AWS Budgets service principal;
      // grant it Publish on the **notify** topic (B23 page/notify split).
      // Without this the budget notifications silently no-op.
      this.notifyTopic.grantPublish(
        new iam.ServicePrincipal("budgets.amazonaws.com"),
      );

      const anomalyMonitor = new ce.CfnAnomalyMonitor(
        this,
        "AnomalyMonitor",
        {
          monitorName: "sps-anomaly-monitor",
          monitorType: "DIMENSIONAL",
          monitorDimension: "SERVICE",
        },
      );

      new ce.CfnAnomalySubscription(this, "AnomalySubscription", {
        subscriptionName: "sps-anomaly-subscription",
        frequency: "DAILY",
        monitorArnList: [anomalyMonitor.ref],
        subscribers: [
          {
            type: "SNS",
            address: this.notifyTopic.topicArn,
            status: "CONFIRMED",
          },
        ],
        thresholdExpression: JSON.stringify({
          Dimensions: {
            Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
            MatchOptions: ["GREATER_THAN_OR_EQUAL"],
            Values: [String(COST_ANOMALY_DAILY_USD)],
          },
        }),
      });

      // Cost Anomaly Detection publishes via a different service principal,
      // also against the notify topic (B23 page/notify split).
      this.notifyTopic.grantPublish(
        new iam.ServicePrincipal("costalerts.amazonaws.com"),
      );
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description:
        "SNS topic every CloudWatch alarm publishes to (page). The Teams channel webhook is subscribed out-of-band per docs/oncall.md.",
    });
    new CfnOutput(this, "NotifyTopicArn", {
      value: this.notifyTopic.topicArn,
      description:
        "SNS topic for cost guardrails + low-urgency fan-out (notify). Operator email subscription lands here, not on the page topic.",
    });
  }
}
