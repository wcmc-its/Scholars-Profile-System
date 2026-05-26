import * as path from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SnsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
 * Cost Anomaly Detection threshold in USD. Compared against
 * `ANOMALY_TOTAL_IMPACT_ABSOLUTE` on the subscription; the baseline daily
 * spend at this writing is ~$14, a 4x spike (the kind we want to catch) is
 * north of $50, and a normal 1.5x bumpy day is under $20. Re-tune after the
 * first month of post-launch data.
 *
 * Note on naming: the prior `COST_ANOMALY_DAILY_USD` name was a leftover from
 * `frequency: "DAILY"` on the subscription, which is incompatible with SNS
 * subscribers (Cost Explorer rejects DAILY/WEEKLY + SNS at deploy time with
 * HTTP 400 -- see #440). The constant describes the *threshold*, not a
 * cadence; the subscription itself is IMMEDIATE.
 */
const COST_ANOMALY_THRESHOLD_USD = 50;

/** Latency SLO target in milliseconds. Mirrored from docs/SLOs.md. */
const LATENCY_P99_THRESHOLD_MS = 1500;

/**
 * Minimum absolute target-5xx count in a 5-minute window before the 5xx *rate*
 * alarm is allowed to evaluate. Without a floor, a single stray 5xx in a
 * low-traffic window reads as a huge rate and pages: this is what produced the
 * 2026-05-26 flap, where 1 error / 4 requests (25%) and 3 errors / 46 requests
 * (6.5%) both crossed the 1% threshold on a quiet ALB. Requiring a handful of
 * errors first preserves the SLO-rate semantics for a genuine burst at any
 * traffic level while ignoring the 1-3 stray-error noise. Re-tune in the SLO
 * review loop; tracked in docs/SLOs.md.
 */
const MIN_5XX_FOR_RATE_ALARM = 5;

/**
 * Threshold for the B02 edit_authz_denied alarm: more than 10 denials in a
 * 5-minute window, repeating for two consecutive windows. Distinguishes a
 * confused user (1-3 denials in a row) from a misconfigured bot or a
 * predicate regression. Re-tune after the first month of staging traffic,
 * same loop as COST_ANOMALY_THRESHOLD_USD; tracked in docs/SLOs.md.
 */
const EDIT_AUTHZ_DENIED_THRESHOLD = 10;

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
 * Per-env stack (`Sps-Observability-{env}`). Nine CloudWatch alarms cover
 * the public ALB / ECS / Aurora / OpenSearch surfaces plus the B02 edit-
 * surface 403 rate; every alarm publishes to the env's **page** SNS topic
 * (`sps-alarms-{env}`), which a Microsoft Teams channel webhook is subscribed
 * to via HTTPS out-of-band per docs/oncall.md. (Teams matches the WCM-native
 * ops pattern; ServiceNow incident integration tracked as a B23 follow-on.)
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
  /**
   * Lambda that subscribes to {@link alarmTopic} and POSTs an Adaptive Card
   * to the Power Automate Teams webhook (B27). Replaces the direct SNS HTTPS
   * subscription that B23 originally documented -- empirically disproven
   * 2026-05-21 because the Power Automate `Request` trigger enforces a JSON
   * body type at the trigger level and SNS sends form-urlencoded; see
   * `docs/oncall.md` § Gotchas.
   */
  public readonly relayFunction: lambda.IFunction;

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
    // (1) 5xx rate -- ratio of target-side 5xx to total request count, gated
    // behind a minimum absolute error count (MIN_5XX_FOR_RATE_ALARM). The bare
    // ratio false-fires on a quiet ALB: a single stray 5xx in a single-digit-
    // request window reads as 25%+ and pages (the 2026-05-26 flap). The outer
    // IF returns 0 until at least MIN_5XX_FOR_RATE_ALARM errors land in the
    // window, so transient one-off 5xx are ignored while a genuine burst still
    // trips the 1% threshold at any traffic level. Hard-down (0 healthy hosts)
    // is covered separately by the unhealthy-hosts alarm below.
    const alb5xxRate = new cloudwatch.MathExpression({
      expression: `IF(m5xx >= ${MIN_5XX_FOR_RATE_ALARM}, (m5xx / IF(reqs > 0, reqs, 1)) * 100, 0)`,
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
    // Edit authz-denied alarm (B02 #101)
    // ------------------------------------------------------------------
    // (9) edit_authz_denied rate -- the app log group records one JSON
    // line per 403 from the edit surface (`lib/auth/authz-events.ts`); the
    // metric filter pattern keys the count off the `event` field. A
    // sustained rate is a predicate bug or active probing -- a normal day
    // is 0; a confused user or a fat-fingered link is 1-3 in a row. The
    // threshold (> 10 in a 5-minute window, two consecutive windows)
    // separates those from a regression. Re-tune in staging.
    //
    // Filter pattern is keyed on the literal event name string emitted by
    // `logAuthzDenied()`. If that string ever changes, the filter silently
    // stops matching; the comment in `lib/auth/authz-events.ts` warns
    // future renamers of this binding.
    new logs.MetricFilter(this, "EditAuthzDeniedMetricFilter", {
      logGroup: appStack.appLogGroup,
      filterName: `sps-edit-authz-denied-${env}`,
      filterPattern: logs.FilterPattern.stringValue(
        "$.event",
        "=",
        "edit_authz_denied",
      ),
      metricNamespace: "SPS/Auth",
      metricName: "EditAuthzDenied",
      metricValue: "1",
      defaultValue: 0,
    });

    const editAuthzDeniedAlarm = new cloudwatch.Alarm(
      this,
      "EditAuthzDeniedAlarm",
      {
        alarmName: `sps-edit-authz-denied-${env}`,
        alarmDescription: `Edit-surface 403 (edit_authz_denied) count > ${EDIT_AUTHZ_DENIED_THRESHOLD} in any 5m window for 2 consecutive windows (${env}). Sustained rate -- predicate bug or active probing. See docs/SLOs.md.`,
        metric: new cloudwatch.Metric({
          namespace: "SPS/Auth",
          metricName: "EditAuthzDenied",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: EDIT_AUTHZ_DENIED_THRESHOLD,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    editAuthzDeniedAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // On-call relay Lambda (B27)
    // ------------------------------------------------------------------
    // SNS -> Lambda -> Adaptive Card JSON POST to a Power Automate Teams
    // workflow URL. B23 originally documented `aws sns subscribe --protocol
    // https` against the workflow URL directly; that path was empirically
    // disproven 2026-05-21 -- the Power Automate `Request` trigger enforces
    // a JSON body type at the trigger level (not at schema validation) and
    // SNS hardcodes `Content-Type: application/x-www-form-urlencoded` on
    // HTTPS delivery, so SNS subscribe attempts fail with HTTP 400 and the
    // subscription silently never lands. The Lambda exists to bridge that
    // gap (see `docs/oncall.md` § Gotchas for the full evidence trail).
    //
    // No VPC attach -- the Lambda's only outbound URL is sourced from a
    // secret we control, SSRF surface is nil (zero user-controlled URL
    // inputs), and VPC-attaching would force a NAT for one HTTPS POST per
    // alarm. Documented as a deliberate non-VPC decision in the threat
    // model (SPEC § Threat model T8).
    const teamsWebhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "TeamsWebhookSecret",
      `scholars/${env}/oncall/teams-webhook-url`,
    );

    // Explicit log group rather than NodejsFunction's `logRetention` prop --
    // the prop pulls in a CloudFormation custom resource (a second
    // AWS::Lambda::Function and IAM::Role per stack) which would double the
    // Lambda + role count and break the SPEC's 1-Lambda assertion. Owning
    // the log group also gives a stable name we can reference in the
    // runbook (`/aws/lambda/sps-oncall-relay-${env}`).
    const relayLogGroup = new logs.LogGroup(this, "OncallRelayLogGroup", {
      logGroupName: `/aws/lambda/sps-oncall-relay-${env}`,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const relay = new NodejsFunction(this, "OncallRelayFunction", {
      functionName: `sps-oncall-relay-${env}`,
      entry: path.join(__dirname, "../lambda/oncall-relay/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: relayLogGroup,
      environment: {
        TEAMS_WEBHOOK_SECRET_ARN: teamsWebhookSecret.secretArn,
      },
      bundling: {
        // Provided by the Lambda runtime; bundling it duplicates the SDK
        // into the deployable and inflates cold start.
        externalModules: ["@aws-sdk/client-secrets-manager"],
        // Source maps off per SPEC § Decisions locked -- bundle is small,
        // stack traces are line-accurate enough without them. Flip on if
        // a prod stack-trace ever shows wrong line numbers.
        sourceMap: false,
        target: "node22",
      },
    });
    this.relayFunction = relay;

    teamsWebhookSecret.grantRead(relay);
    relay.addEventSource(new SnsEventSource(this.alarmTopic));

    // Failure-mode design (SPEC § Failure-mode design): if this Lambda
    // errors, route to the NOTIFY topic (email) -- not the page topic --
    // because the page topic IS this Lambda; routing failure back through
    // itself either silently flaps or recursively masks the original alarm.
    // Email is the out-of-band fallback.
    const relayErrorsAlarm = new cloudwatch.Alarm(this, "OncallRelayErrors", {
      alarmName: `sps-oncall-relay-errors-${env}`,
      alarmDescription: `On-call relay Lambda surfaced one or more invocation errors in the last minute (${env}). Paging-path delivery is at risk -- check Lambda CloudWatch logs and the Teams workflow URL in Secrets Manager. Routed to the notify topic (email) because the page topic flows through this Lambda.`,
      metric: relay.metricErrors({
        period: Duration.minutes(1),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    relayErrorsAlarm.addAlarmAction(new cwActions.SnsAction(this.notifyTopic));

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

      // `frequency` must be IMMEDIATE when any subscriber is `Type: SNS`;
      // Cost Explorer rejects DAILY/WEEKLY + SNS at deploy time with HTTP 400
      // ("Daily or weekly frequencies only support Email subscriptions"). CDK
      // does not synth-validate this combinatoric constraint -- see #440 and
      // the synth-time guard in `test/observability-stack.test.ts`.
      // Semantically correct: the threshold below describes the *condition*
      // for an alert; IMMEDIATE means alert on detection, matching the rest
      // of this stack's posture.
      new ce.CfnAnomalySubscription(this, "AnomalySubscription", {
        subscriptionName: "sps-anomaly-subscription",
        frequency: "IMMEDIATE",
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
            Values: [String(COST_ANOMALY_THRESHOLD_USD)],
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
    new CfnOutput(this, "OncallRelayFunctionArn", {
      value: relay.functionArn,
      description:
        "Lambda that relays page topic SNS events to a Teams workflow as Adaptive Card JSON (B27). Reads workflow URL from scholars/{env}/oncall/teams-webhook-url at cold start.",
    });
  }
}
