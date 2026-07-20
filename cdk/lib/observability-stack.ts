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
import * as sqs from "aws-cdk-lib/aws-sqs";
import { type Construct } from "constructs";
import { type AppStack } from "./app-stack";
import { type SpsEnvConfig } from "./config";
import { type DataStack } from "./data-stack";
import { type EtlStack } from "./etl-stack";

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
 * Threshold for the B02 edit_authz_denied alarm: more than 3 denials in a
 * 5-minute window, repeating for two consecutive windows. Distinguishes a
 * confused user (1-3 denials in a row) from a misconfigured bot or a
 * predicate regression.
 *
 * Lowered 10 -> 3 on 2026-07-19, which is the "re-tune after the first month
 * of staging traffic" this comment used to defer. The measured baseline is not
 * merely low, it is exactly zero: max 0.0 across 342 datapoints over 7 days,
 * and no fire in the two months since the filter was created. Against a true
 * zero, ">10 in each of two consecutive 5m windows" means 22+ denials in ten
 * minutes before anyone hears about it -- while the realistic shape of an
 * authz-predicate regression is a handful of denials per window, forever. That
 * leaks silently at 10 and is caught at 3, and 3 still excludes the confused
 * user this comment already defined as 1-3.
 */
const EDIT_AUTHZ_DENIED_THRESHOLD = 3;

/** Props for {@link SpsObservabilityStack}. */
export interface ObservabilityStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** AppStack instance — read ALB / target group / ECS service references. */
  readonly appStack: AppStack;
  /** DataStack instance — read Aurora cluster / OpenSearch domain references. */
  readonly dataStack: DataStack;
  /**
   * EtlStack instance — its `etl-failures-{env}` topic is subscribed to the
   * on-call relay here so ETL step failures, the status/cadence CloudWatch
   * alarms, and the freshness heartbeat all reach Teams (#595). The topic
   * itself is owned by EtlStack; this stack only adds the relay subscription,
   * matching the appStack/dataStack "read the other stack's resources" pattern.
   */
  readonly etlStack: EtlStack;
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
   * SNS topic for the P2 "warn" tier: data-freshness / reconciler / resource-
   * pressure alarms demoted off the page topic so the on-call channel carries
   * only customer-facing P1. The relay subscribes to it and posts to a
   * separate, quieter Teams channel (falling back to the page channel if that
   * channel's webhook is not yet provisioned).
   */
  public readonly warnTopic: sns.Topic;
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

    // Estate-consolidation decouple (docs/cutover-decouple-increments-2026-06-30.md):
    // when observabilityMetricsByName is on, the Aurora/OpenSearch alarms + dashboard
    // widgets read their metrics by literal cluster/domain NAME (config) instead of
    // via the dataStack.auroraCluster / .opensearchDomain L2 handles — which severs
    // the two Data->Observability cross-stack Ref exports so the useSharedVpc flip can
    // replace those resources without "cannot update an export in use". OFF (shipped)
    // keeps the handle path, byte-identical. Deploy ordering (runbook): flip this and
    // deploy Sps-Observability-<env> EXCLUSIVELY, BEFORE the Data deploy that removes
    // the export, or CloudFormation re-trips "cannot delete export in use".
    const metricsByName = envConfig.observabilityMetricsByName;
    if (
      metricsByName &&
      (!envConfig.auroraClusterIdentifier ||
        !envConfig.opensearchDomainName ||
        !envConfig.publicAlbFullName ||
        !envConfig.publicTargetGroupFullName)
    ) {
      throw new Error(
        `observabilityMetricsByName is on for env="${env}" but one of ` +
          `auroraClusterIdentifier/opensearchDomainName/publicAlbFullName/` +
          `publicTargetGroupFullName is not set — the by-name metrics would synth ` +
          `empty AWS/RDS + AWS/ES + AWS/ApplicationELB dimensions that never alarm ` +
          `(treatMissingData NOT_BREACHING). Assign the snapshot-restored cluster/` +
          `domain identifiers and the replaced ALB/target-group full names in config ` +
          `before flipping the flag.`,
      );
    }
    // Aurora (AWS/RDS) metric by literal DBClusterIdentifier — used when
    // metricsByName is on. period/label are per call-site.
    const dbMetric = (
      metricName: string,
      statistic: string,
      opts: { period: Duration; label?: string },
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/RDS",
        metricName,
        dimensionsMap: { DBClusterIdentifier: envConfig.auroraClusterIdentifier },
        statistic,
        period: opts.period,
        label: opts.label,
      });
    // OpenSearch (AWS/ES) metric by literal DomainName. ClientId (the account) is
    // REQUIRED — without it the AWS/ES series is empty even with a correct DomainName.
    const osMetric = (
      metricName: string,
      statistic: string,
      opts: { period: Duration; label?: string },
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/ES",
        metricName,
        dimensionsMap: {
          DomainName: envConfig.opensearchDomainName,
          ClientId: this.account,
        },
        statistic,
        period: opts.period,
        label: opts.label,
      });
    // Public ALB (AWS/ApplicationELB) metric by literal LoadBalancer full name —
    // used when metricsByName is on, severing the App->Observability ALB
    // LoadBalancerFullName export (edge 9). Target-group (edge 10) metrics also
    // carry the LoadBalancer dim and are built inline where used.
    const albMetric = (
      metricName: string,
      statistic: string,
      opts: { period: Duration; label?: string },
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/ApplicationELB",
        metricName,
        dimensionsMap: { LoadBalancer: envConfig.publicAlbFullName },
        statistic,
        period: opts.period,
        label: opts.label,
      });

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

    // Warn topic carries the P2 tier: data-freshness / reconciler / resource-
    // pressure alarms that warrant attention but are not "wake on-call". The
    // on-call relay subscribes to it (below) and posts to a separate, quieter
    // Teams channel; if that channel's webhook is not yet provisioned the relay
    // falls back to the page channel, so demoting an alarm here never silently
    // drops it. Splitting the P2 traffic off the page topic is the core of the
    // alert-fatigue fix -- the page channel now carries only customer-facing
    // P1 (the app-unavailable composite, latency, and cluster-red).
    this.warnTopic = new sns.Topic(this, "WarnTopic", {
      topicName: `sps-warn-${env}`,
      displayName: `SPS ${env} warnings (P2)`,
    });

    const snsAction = new cwActions.SnsAction(this.alarmTopic);
    const warnAction = new cwActions.SnsAction(this.warnTopic);

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
        m5xx: metricsByName
          ? albMetric("HTTPCode_Target_5XX_Count", "Sum", {
              period: Duration.minutes(5),
            })
          : appStack.publicAlb.metrics.httpCodeTarget(
              elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
              { statistic: "Sum", period: Duration.minutes(5) },
            ),
        reqs: metricsByName
          ? albMetric("RequestCount", "Sum", { period: Duration.minutes(5) })
          : appStack.publicAlb.metrics.requestCount({
              statistic: "Sum",
              period: Duration.minutes(5),
            }),
      },
      label: "5xx rate (%) over 5m",
      period: Duration.minutes(5),
    });
    const alb5xxAlarm = new cloudwatch.Alarm(this, "PublicAlb5xxRateAlarm", {
      alarmName: `sps-alb-5xx-rate-${env}`,
      alarmDescription: `Public ALB target 5xx rate exceeds 1% over 5m (${env}). Burns the 99.5% availability SLO budget. See docs/SLOs.md. Next: check the ALB 5xx panel and the most recent deploy; roll back if the spike tracks a release, else pull app logs for the failing route.`,
      metric: alb5xxRate,
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // No direct action -- folded into the app-unavailable composite below so a
    // serving cascade pages once, not three times. Still evaluates (feeds the
    // composite + the reliability dashboard).

    // (2) Unhealthy host count -- requires both LoadBalancer + TargetGroup
    // dimensions; metric pulled off the target group directly.
    const unhealthyAlarm = new cloudwatch.Alarm(
      this,
      "PublicAlbUnhealthyHostsAlarm",
      {
        alarmName: `sps-alb-unhealthy-hosts-${env}`,
        alarmDescription: `Public ALB has zero healthy targets for 5 consecutive minutes (${env}). Circuit-breaker did not catch it -- real outage. Next: check ECS task health, the in-flight deploy, and the target-group health-check path.`,
        metric: metricsByName
          ? new cloudwatch.Metric({
              namespace: "AWS/ApplicationELB",
              metricName: "UnHealthyHostCount",
              dimensionsMap: {
                LoadBalancer: envConfig.publicAlbFullName,
                TargetGroup: envConfig.publicTargetGroupFullName,
              },
              statistic: "Maximum",
              period: Duration.minutes(1),
            })
          : appStack.publicTargetGroup.metrics.unhealthyHostCount({
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
    // No direct action -- folded into the app-unavailable composite below.

    // (3) Latency p99 -- the latency SLI directly.
    const latencyAlarm = new cloudwatch.Alarm(
      this,
      "PublicAlbLatencyP99Alarm",
      {
        alarmName: `sps-alb-latency-p99-${env}`,
        alarmDescription: `Public ALB target response time p99 > ${LATENCY_P99_THRESHOLD_MS}ms over 5m (${env}). Burns the latency SLO budget. See docs/SLOs.md. Next: open the reliability dashboard latency and Aurora SelectLatency panels; look for a slow query, a cold cache, or an undersized task.`,
        metric: metricsByName
          ? albMetric("TargetResponseTime", "p99", {
              period: Duration.minutes(5),
            })
          : appStack.publicAlb.metrics.targetResponseTime({
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
    // Prod pages on latency; staging warns. The 1500ms bar is a PROD SLO, and
    // staging's traffic is not prod's: measured over 7 days to 2026-07-19,
    // staging p99 is p50 0.64s but p95 16.7s -- a bimodal shape that is the
    // eval/sweep/batch workload (sponsor-match fan-out, extraction runs, roster
    // sweeps), not a user-facing regression. That distribution crossed the bar
    // constantly: 10 pages in 7 days, the single largest noise source in the
    // estate and the only noisy alarm on the page topic. Prod over the same
    // window sat at p50 0.35s and fired once in 30 days.
    //
    // Deliberately NOT retuning the staging threshold: any number that
    // suppresses a 16.7s p95 is far too high to mean anything as a page, so a
    // "calibrated" staging threshold would be theatre. The honest statement is
    // that staging latency is not an on-call event -- nobody is waiting on a
    // staging response -- so it warns and stays visible without waking anyone.
    latencyAlarm.addAlarmAction(env === "prod" ? snsAction : warnAction);

    // ------------------------------------------------------------------
    // ECS service alarms (1)
    // ------------------------------------------------------------------
    // (4) Running task count below desired -- a math expression so the
    // alarm fires when running < desired regardless of the desired-count
    // value (handles bootstrap appDesiredCount=0 case correctly: 0 < 0 is
    // false, no false-fire).
    // DesiredTaskCount / RunningTaskCount are published only to the
    // ECS/ContainerInsights namespace (Container Insights is enabled on the
    // cluster, app-stack.ts), NOT the AWS/ECS namespace that
    // BaseService.metric() targets -- there they carry no data, so anything
    // built on them (this alarm and the dashboard widget below) silently
    // never receives datapoints. Build them explicitly against the right
    // namespace; dimensions come from the same service construct the CPU/mem
    // metrics already reference, so no new cross-stack export.
    const ecsTaskCountMetric = (
      metricName: "DesiredTaskCount" | "RunningTaskCount",
      statistic: string,
      label?: string,
    ) =>
      new cloudwatch.Metric({
        namespace: "ECS/ContainerInsights",
        metricName,
        dimensionsMap: {
          ClusterName: appStack.ecsService.cluster.clusterName,
          ServiceName: appStack.ecsService.serviceName,
        },
        statistic,
        period: Duration.minutes(1),
        ...(label ? { label } : {}),
      });

    const taskCountShortfall = new cloudwatch.MathExpression({
      expression: "desired - running",
      usingMetrics: {
        desired: ecsTaskCountMetric("DesiredTaskCount", "Maximum"),
        running: ecsTaskCountMetric("RunningTaskCount", "Minimum"),
      },
      label: "Desired - Running tasks (5m)",
      period: Duration.minutes(1),
    });
    const taskShortfallAlarm = new cloudwatch.Alarm(
      this,
      "EcsTaskShortfallAlarm",
      {
        alarmName: `sps-ecs-task-shortfall-${env}`,
        alarmDescription: `ECS service running task count is below desired for 5 consecutive minutes (${env}). Tasks died and are not being replaced. Next: check ECS service events for image-pull, capacity, or IAM failures and the recent deploy.`,
        metric: taskCountShortfall,
        threshold: 0,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    // No direct action -- folded into the app-unavailable composite below.

    // ------------------------------------------------------------------
    // App-unavailable composite (cascade dedup)
    // ------------------------------------------------------------------
    // The three serving-failure symptoms above (5xx burst, zero healthy hosts,
    // task shortfall) commonly fire together from one root cause -- e.g. Aurora
    // connection-pool exhaustion takes the app down, which trips all three and
    // previously posted three separate page cards for one incident. Folding
    // them into a CloudWatch composite pages ONCE on any of them; the children
    // stay action-less (they still evaluate, feeding this composite and the
    // dashboard). Latency and cluster-red remain independent P1 alarms --
    // distinct failure modes, not part of the serving-down cascade.
    const appUnavailableAlarm = new cloudwatch.CompositeAlarm(
      this,
      "AppUnavailableAlarm",
      {
        compositeAlarmName: `sps-app-unavailable-${env}`,
        alarmDescription: `Public serving is degraded or down (${env}): one or more of 5xx-rate / zero-healthy-hosts / task-shortfall is in ALARM. Single P1 page for the serving cascade. See docs/SLOs.md. Next: open the reliability dashboard; if Aurora CPU/connections are also high, suspect DB connection-pool exhaustion; if it tracks the last deploy, roll back (DEPLOY-RUNBOOK.md).`,
        alarmRule: cloudwatch.AlarmRule.anyOf(
          cloudwatch.AlarmRule.fromAlarm(
            alb5xxAlarm,
            cloudwatch.AlarmState.ALARM,
          ),
          cloudwatch.AlarmRule.fromAlarm(
            unhealthyAlarm,
            cloudwatch.AlarmState.ALARM,
          ),
          cloudwatch.AlarmRule.fromAlarm(
            taskShortfallAlarm,
            cloudwatch.AlarmState.ALARM,
          ),
        ),
      },
    );
    appUnavailableAlarm.addAlarmAction(snsAction);

    // ------------------------------------------------------------------
    // Aurora cluster alarms (2)
    // ------------------------------------------------------------------
    // (5) CPU -- catches hot loops + runaway queries.
    //
    // Staging sustains for 30m, prod for 15m. The THRESHOLD is right in both
    // envs; the SUSTAIN is what made staging noisy. Measured over 7 days to
    // 2026-07-19, staging CPU steady-state is p50 26.6% / p95 29.1% -- nowhere
    // near the bar -- but every single >80% datapoint fell in the 03:27-03:42
    // nightly ETL window, and all three alarm fires were that window. The spike
    // is real, expected, and 15-20 minutes long, so 3x5m was precisely tuned to
    // catch a batch job doing its job. 6x5m rides it out while still catching a
    // genuinely stuck query.
    //
    // The underlying capacity fact, which no alarm currently states: staging's
    // writer sits at ServerlessDatabaseCapacity 2.0 (= its MaxCapacity) with
    // ACUUtilization pinned at 100% for the whole week, so the ETL has no
    // headroom to absorb into. Retuning the alarm hides the symptom; sizing
    // staging would fix it.
    const auroraCpuSustainPeriods = env === "prod" ? 3 : 6;
    const auroraCpuAlarm = new cloudwatch.Alarm(this, "AuroraCpuAlarm", {
      alarmName: `sps-aurora-cpu-${env}`,
      alarmDescription: `Aurora cluster CPU > 80% sustained for ${auroraCpuSustainPeriods * 5}m (${env}). Likely a hot query loop or runaway analytic. Next: check Performance Insights or the slow-query log; scale ACUs only if the load is legitimate.`,
      metric: metricsByName
        ? dbMetric("CPUUtilization", "Average", { period: Duration.minutes(5) })
        : dataStack.auroraCluster.metricCPUUtilization({
            statistic: "Average",
            period: Duration.minutes(5),
          }),
      threshold: 80,
      evaluationPeriods: auroraCpuSustainPeriods,
      datapointsToAlarm: auroraCpuSustainPeriods,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auroraCpuAlarm.addAlarmAction(warnAction); // P2 -- leading indicator, not an outage

    // (6) Connection count -- catches connection-pool exhaustion before the app
    // starts surfacing connection errors. Threshold is absolute rather than
    // percent-of-max since Aurora Serverless v2 max scales with capacity and the
    // raw number is easier to reason about.
    //
    // RETUNED 2026-07-13 after this alarm slept through three saturation events.
    // The old values (>80, 3x5m sustained) were reasoned from "writer-pool
    // defaults + headroom" -- not measured -- and landed in the one dead zone
    // that cannot see the actual failure. Measured on staging instead:
    //
    //   normal daily peak   60   (07-07, 07-09, 07-10, 07-11)
    //   leaked-pool plateau 75   (07-08 sat here ALL DAY, under the threshold)
    //   saturation / cap    90   (07-06, 07-12, 07-13 -- app cannot connect)
    //
    // Each leaked Prisma pool is exactly +15 connections, so a leak parks the
    // cluster at 75 -- BELOW the old 80 threshold -- indefinitely and invisibly,
    // one app-task roll away from the 90 cap. And when it did cross 80 it was a
    // ~6-minute spike, shorter than the 15 minutes of sustain the alarm demanded.
    // It was structurally blind on both axes: the plateau was too low and the
    // spike was too short. On 2026-07-13 that cost a user-visible outage on
    // /api/edit/sponsor-match (pool timeout, active=0 idle=0) which nothing
    // caught -- a human reported it.
    //
    // 70 sits above the measured normal peak (60) with headroom, and below the
    // leak plateau (75), so it fires on the LEAK rather than on the outage the
    // leak eventually causes. 2x5m keeps a single deploy transient from paging.
    // Leak source + cleanup runbook: docs/performance-baseline.md.
    const auroraConnectionsAlarm = new cloudwatch.Alarm(
      this,
      "AuroraConnectionsAlarm",
      {
        alarmName: `sps-aurora-connections-${env}`,
        alarmDescription: `Aurora active connection count > 70 sustained over 10m (${env}). Normal peak is 60; each leaked Prisma pool adds exactly 15, and the cluster caps near 90. Most likely a one-off ECS probe/eval task that never called db.$disconnect() and is still RUNNING long after printing its output. Next: aws ecs list-tasks --cluster sps-cluster-${env} --family sps-etl-${env} --desired-status RUNNING, stop the zombies (read-only probes are data-safe), and watch DatabaseConnections drain. See docs/performance-baseline.md.`,
        metric: metricsByName
          ? dbMetric("DatabaseConnections", "Maximum", {
              period: Duration.minutes(5),
            })
          : dataStack.auroraCluster.metricDatabaseConnections({
              statistic: "Maximum",
              period: Duration.minutes(5),
            }),
        threshold: 70,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    auroraConnectionsAlarm.addAlarmAction(warnAction); // P2 -- leading indicator

    // (6b) Prisma pool timeouts -- the HARM, not the leading indicator. (6) can
    // still be evaded (a leak that plateaus under 70, a cap change, a fan-out we
    // have not thought of); this fires whenever a request actually failed to get
    // a DB connection, whatever the cause. The app logs one JSON line per
    // occurrence: {"event":"edit_write_failed", ... "error":"pool timeout: failed
    // to retrieve a connection from pool after 10001ms (pool connections:
    // active=0 idle=0 limit=15)"}. `active=0 idle=0` means the pool could not
    // open a SINGLE connection -- the ceiling is the CLUSTER, not this task, so
    // recycling the app will not help; find what is holding the connections.
    //
    // One pool timeout is already a 500 in a user's face, so alarm on the first.
    //
    // ENV SUFFIX ON THE NAMESPACE IS LOAD-BEARING (Footgun #4, log-metric
    // edition). Staging and prod deploy this stack into the SAME account, so an
    // env-less namespace gives both envs ONE series: both metric filters write
    // it and both env alarms read it. Measured 2026-07-19 -- `list-metrics
    // --namespace SPS/Data` returned a single dimensionless DbPoolTimeout, and
    // sps-db-pool-timeout-prod (which pages on sps-alarms-prod) and
    // sps-db-pool-timeout-staging reported identical datapoint counts. A
    // staging pool timeout would have fired the PROD page.
    //
    // The idiomatic fix -- a metric-filter `dimensions: { Env: env }` -- is
    // rejected by AWS twice over: dimensions are mutually exclusive with
    // `defaultValue` (the zero-emission below is what proves the filter is
    // wired rather than phantom), and they require a JSON or space-delimited
    // pattern whose dimension VALUE is read from a log field -- a static
    // literal is not accepted, and the app does not log its env. Scoping the
    // namespace keeps both properties and costs nothing.
    new logs.MetricFilter(this, "DbPoolTimeoutMetricFilter", {
      logGroup: appStack.appLogGroup,
      filterName: `sps-db-pool-timeout-${env}`,
      filterPattern: logs.FilterPattern.literal('"pool timeout"'),
      metricNamespace: `SPS/Data/${env}`,
      metricName: "DbPoolTimeout",
      metricValue: "1",
      defaultValue: 0,
    });

    const dbPoolTimeoutAlarm = new cloudwatch.Alarm(
      this,
      "DbPoolTimeoutAlarm",
      {
        alarmName: `sps-db-pool-timeout-${env}`,
        alarmDescription: `A request could not get a DB connection from the pool (${env}) -- users are seeing 500s right now. If the log line says active=0 idle=0, the Aurora cluster is at its connection cap and recycling the app will NOT help. Next: check DatabaseConnections on the cluster, then stop any zombie one-off ECS tasks holding pools (see the sps-aurora-connections-${env} alarm and docs/performance-baseline.md).`,
        metric: new cloudwatch.Metric({
          namespace: `SPS/Data/${env}`, // env-scoped -- see the filter above
          metricName: "DbPoolTimeout",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    dbPoolTimeoutAlarm.addAlarmAction(snsAction); // P1 -- users are getting 500s

    // ------------------------------------------------------------------
    // OpenSearch domain alarms (2)
    // ------------------------------------------------------------------
    // (7) JVM memory pressure -- GC pressure cascades into query latency.
    //
    // 2 of 3 windows, not 3 of 3. The comment on the breaker filter below
    // suspected this alarm was blind to short bursts; the 7-day baseline to
    // 2026-07-19 confirms it. Staging exceeded 85% on three separate datapoints
    // and the alarm never fired, because 3-of-3 demands 15 unbroken minutes
    // while these bursts run under 10. Requiring 2 of 3 converts a 10-minute
    // burst into a warn without touching the threshold -- which stays at 85
    // because prod's own max (85.1%) is already sitting on it.
    const openSearchJvmAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchJvmPressureAlarm",
      {
        alarmName: `sps-opensearch-jvm-pressure-${env}`,
        alarmDescription: `OpenSearch JVM memory pressure > 85% for 10m of any 15m window (${env}). GC pressure will cascade into query latency. Next: check shard count and query load on the dashboard; throttle heavy queries or scale the domain.`,
        metric: metricsByName
          ? osMetric("JVMMemoryPressure", "Maximum", {
              period: Duration.minutes(5),
            })
          : dataStack.opensearchDomain.metric("JVMMemoryPressure", {
              statistic: "Maximum",
              period: Duration.minutes(5),
            }),
        threshold: 85,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    openSearchJvmAlarm.addAlarmAction(warnAction); // P2 -- GC pressure, not down yet

    // (8) Cluster status red -- shards unassigned, immediate.
    const openSearchRedAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchClusterRedAlarm",
      {
        alarmName: `sps-opensearch-cluster-red-${env}`,
        alarmDescription: `OpenSearch cluster status is RED (${env}). Shards unassigned -- searches affected. Next: check OpenSearch _cluster/health; reallocate or restore the affected index from snapshot.`,
        metric: metricsByName
          ? osMetric("ClusterStatus.red", "Maximum", {
              period: Duration.minutes(1),
            })
          : dataStack.opensearchDomain.metric("ClusterStatus.red", {
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

    // (8b) Parent circuit-breaker trips. There is no CloudWatch metric for
    // these -- OpenSearch only surfaces them as a `circuit_breaking_exception`
    // in the *app* log when a query is refused, and the app turns that into a
    // 502. The JVM-pressure alarm above is blind to them: it needs 15 minutes
    // sustained >85%, while a breaker trip is a ~2-minute burst (staging sat in
    // OK through a 97% spike, 2026-07-12). This filter is the direct signal --
    // one refused query is already a user-visible failure, so alarm on the
    // first one.
    new logs.MetricFilter(this, "OpenSearchBreakerMetricFilter", {
      logGroup: appStack.appLogGroup,
      filterName: `sps-opensearch-breaker-${env}`,
      filterPattern: logs.FilterPattern.literal('"circuit_breaking_exception"'),
      metricNamespace: `SPS/Search/${env}`, // env-scoped -- see (6b)
      metricName: "OpenSearchCircuitBreaker",
      metricValue: "1",
      defaultValue: 0,
    });

    const openSearchBreakerAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchBreakerAlarm",
      {
        alarmName: `sps-opensearch-breaker-${env}`,
        alarmDescription: `OpenSearch refused a query with circuit_breaking_exception (${env}) -- the parent breaker tripped at 95% of heap and the app returned 502. Next: check JVMMemoryPressure Maximum on the domain; the node is undersized or a query burst (e.g. the sponsor-match fan-out) is too heavy for the heap.`,
        metric: new cloudwatch.Metric({
          namespace: `SPS/Search/${env}`, // env-scoped -- see (6b)
          metricName: "OpenSearchCircuitBreaker",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    openSearchBreakerAlarm.addAlarmAction(warnAction); // P2 -- degraded search, not down

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
      metricNamespace: `SPS/Auth/${env}`, // env-scoped -- see (6b)
      metricName: "EditAuthzDenied",
      metricValue: "1",
      defaultValue: 0,
    });

    const editAuthzDeniedAlarm = new cloudwatch.Alarm(
      this,
      "EditAuthzDeniedAlarm",
      {
        alarmName: `sps-edit-authz-denied-${env}`,
        alarmDescription: `Edit-surface 403 (edit_authz_denied) count > ${EDIT_AUTHZ_DENIED_THRESHOLD} in any 5m window for 2 consecutive windows (${env}). Sustained rate -- predicate bug or active probing. See docs/SLOs.md. Next: check for an authz-predicate regression in the last deploy, or active probing; review the edit_authz_denied logs for the actor and path.`,
        metric: new cloudwatch.Metric({
          namespace: `SPS/Auth/${env}`, // env-scoped -- see (6b)
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
    editAuthzDeniedAlarm.addAlarmAction(warnAction); // P2 -- security signal, review-in-hours

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

    // P2 warn-channel webhook. Optional by design: the relay falls back to the
    // page channel when this secret is absent (lambda/oncall-relay/index.ts
    // getWarnWebhookUrl), so alarms can be demoted to the warn topic and ship
    // before the second Teams channel + its Power Automate webhook are
    // provisioned. `fromSecretNameV2` grants read on the name-scoped ARN
    // whether or not the secret exists yet; the runtime GetSecretValue
    // tolerates ResourceNotFound. To activate: create the secret with the
    // workflow URL, no redeploy needed (cold start picks it up).
    const teamsWarnWebhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "TeamsWarnWebhookSecret",
      `scholars/${env}/oncall/teams-webhook-url-warn`,
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

    // Dead-letter queue for the paging path. An async Lambda invocation retries
    // twice and then DISCARDS the event. On 2026-07-19 the prod relay hit
    // `TypeError: fetch failed` POSTing to the Teams webhook, burned all three
    // attempts inside three minutes (13:05:11 / 13:06:05 / 13:08:11), and the
    // message was gone -- and that message was the daily Freshness page
    // reporting a 34-day-stale Spotlight artifact (#1813).
    //
    // `sps-oncall-relay-errors-${env}` did its job: it fired and emailed. But
    // it can only say a delivery FAILED, never what the lost card said. This
    // queue keeps the SNS event so a dropped page stays readable and can be
    // replayed. 14 days is the SQS maximum -- a page lost on a Friday must
    // still be recoverable after a holiday.
    //
    // Deliberately NO alarm on queue depth: it would fire on precisely the
    // condition the errors alarm already covers, i.e. page twice for one fault.
    const relayDlq = new sqs.Queue(this, "OncallRelayDlq", {
      queueName: `sps-oncall-relay-dlq-${env}`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const relay = new NodejsFunction(this, "OncallRelayFunction", {
      functionName: `sps-oncall-relay-${env}`,
      deadLetterQueue: relayDlq,
      entry: path.join(__dirname, "../lambda/oncall-relay/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: relayLogGroup,
      environment: {
        TEAMS_WEBHOOK_SECRET_ARN: teamsWebhookSecret.secretArn,
        TEAMS_WARN_WEBHOOK_SECRET_ARN: teamsWarnWebhookSecret.secretArn,
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
    teamsWarnWebhookSecret.grantRead(relay);
    relay.addEventSource(new SnsEventSource(this.alarmTopic));
    relay.addEventSource(new SnsEventSource(this.warnTopic));

    // #595 — also relay ETL failures to Teams. EtlStack publishes three signal
    // types to `etl-failures-{env}`: per-step Catch SnsPublish, the
    // status/cadence CloudWatch alarms (SnsAction), and the freshness-heartbeat
    // status alarm. The topic shipped with NO subscriber (B23's PagerDuty
    // wiring never landed), so 8+ nights of nightly-cadence failures went unseen.
    //
    // The subscription is declared HERE (not via topic.addSubscription, which
    // places the AWS::SNS::Subscription in the topic's owning stack = EtlStack)
    // to avoid a stack dependency cycle: ObservabilityStack already depends on
    // EtlStack via `failureTopic`, so an EtlStack->ObservabilityStack edge (the
    // subscription referencing this relay) would cycle. Constructing the
    // Subscription + invoke permission in this stack's scope keeps both
    // resources on the existing ObservabilityStack->EtlStack edge. The relay
    // handles both payload shapes (adaptive-card.ts isCloudWatchAlarmPayload).
    new sns.Subscription(this, "EtlFailuresRelaySubscription", {
      topic: props.etlStack.failureTopic,
      protocol: sns.SubscriptionProtocol.LAMBDA,
      endpoint: relay.functionArn,
    });
    relay.addPermission("AllowEtlFailuresTopicInvoke", {
      principal: new iam.ServicePrincipal("sns.amazonaws.com"),
      sourceArn: props.etlStack.failureTopic.topicArn,
      action: "lambda:InvokeFunction",
    });

    // PR-7 — subscribe the same relay to the P1 page topic (abort-tier step
    // failures). Same in-this-stack wiring as EtlFailures above to avoid the
    // EtlStack->ObservabilityStack cycle. severityForRecord routes any non-warn
    // topic (etl-page-* included) to the page channel, so no relay change.
    new sns.Subscription(this, "EtlPageRelaySubscription", {
      topic: props.etlStack.pageTopic,
      protocol: sns.SubscriptionProtocol.LAMBDA,
      endpoint: relay.functionArn,
    });
    relay.addPermission("AllowEtlPageTopicInvoke", {
      principal: new iam.ServicePrincipal("sns.amazonaws.com"),
      sourceArn: props.etlStack.pageTopic.topicArn,
      action: "lambda:InvokeFunction",
    });

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
    // Reliability dashboard (Build A).
    //
    // One at-a-glance CloudWatch dashboard per env (`sps-reliability-${env}`,
    // both envs) over the four user-facing reliability surfaces -- public
    // ALB, CloudFront edge, the ECS service, the Aurora cluster. Read-only:
    // it graphs the same L2 metric handles the alarms above evaluate, so the
    // board and the page topic never disagree about "healthy". See
    // docs/SLOs.md for the targets each panel tracks.
    //
    // Why a CloudWatch dashboard at all when New Relic is the primary APM:
    // New Relic's free-tier metric retention is 8 days, but CloudWatch keeps
    // 1-second/1-minute metrics rolled up to 15 months. This board is the
    // long-horizon, vendor-neutral source of truth for the SLO review loop
    // and post-incident timelines that reach back past New Relic's window --
    // and it survives a New Relic outage or contract lapse. New Relic stays
    // the day-to-day APM; this is the durable reliability mirror.
    //
    // CloudFront caveat (read before editing the CF row): CloudFront only
    // publishes metrics in us-east-1 under a mandatory `Region` dimension
    // valued "Global". The aws-cdk-lib 2.254 `distribution.metric*` helpers
    // set ONLY `dimensionsMap: { DistributionId }` -- they omit the Region
    // dimension and do not pin the metric region -- so a graph built from
    // them shows no data. Every CloudFront series below is therefore a raw
    // `cloudwatch.Metric` with the full dimension set + `region: "us-east-1"`
    // via the `cfMetric` helper. The DistributionId comes from config
    // (`envConfig.cloudFrontDistributionId`), NOT the EdgeStack L2 handle: this
    // stack deploys standalone while EdgeStack is frozen behind the #502
    // NetScaler/WAF decision (importing the handle would force an Edge redeploy
    // that, without the live domain/cert/cidr context, would strip prod's alias
    // + cert + WAF). OriginLatency is a paid CloudFront additional metric that
    // needs `publishAdditionalMetrics: true` on the distribution; that flag is
    // set in edge-stack.ts but only takes effect on the NEXT Edge deploy, so
    // the OriginLatency panel below stays empty until Edge is redeployed. The
    // rest of the CF row graphs the always-available standard metrics.
    // ------------------------------------------------------------------

    /**
     * Build a CloudFront metric the way CloudFront actually publishes it:
     * namespace AWS/CloudFront, dimensions { DistributionId, Region: "Global" },
     * pinned to us-east-1. The 2.254 L2 `distribution.metric*` helpers omit
     * the Region dimension, which yields an empty graph -- hence this raw
     * fallback. DistributionId comes from config (decoupled from the frozen
     * EdgeStack -- see the caveat comment above).
     */
    const cfMetric = (
      metricName: string,
      statistic: string,
      label: string,
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/CloudFront",
        metricName,
        dimensionsMap: {
          DistributionId: envConfig.cloudFrontDistributionId,
          Region: "Global",
        },
        statistic,
        period: Duration.minutes(5),
        region: "us-east-1",
        label,
      });

    const dashboard = new cloudwatch.Dashboard(this, "ReliabilityDashboard", {
      dashboardName: `sps-reliability-${env}`,
    });

    // ---- ALB row ----------------------------------------------------
    const albLatencyWidget = new cloudwatch.GraphWidget({
      title: "ALB latency p50/p90/p99 (s)",
      width: 12,
      height: 6,
      left: [
        metricsByName
          ? albMetric("TargetResponseTime", "p50", {
              period: Duration.minutes(5),
              label: "p50",
            })
          : appStack.publicAlb.metrics.targetResponseTime({
              statistic: "p50",
              period: Duration.minutes(5),
              label: "p50",
            }),
        metricsByName
          ? albMetric("TargetResponseTime", "p90", {
              period: Duration.minutes(5),
              label: "p90",
            })
          : appStack.publicAlb.metrics.targetResponseTime({
              statistic: "p90",
              period: Duration.minutes(5),
              label: "p90",
            }),
        metricsByName
          ? albMetric("TargetResponseTime", "p99", {
              period: Duration.minutes(5),
              label: "p99",
            })
          : appStack.publicAlb.metrics.targetResponseTime({
              statistic: "p99",
              period: Duration.minutes(5),
              label: "p99",
            }),
      ],
      leftYAxis: { min: 0, label: "seconds" },
    });

    const albTrafficWidget = new cloudwatch.GraphWidget({
      title: "ALB requests + 5xx/4xx (5m sum)",
      width: 12,
      height: 6,
      left: [
        metricsByName
          ? albMetric("RequestCount", "Sum", {
              period: Duration.minutes(5),
              label: "Requests",
            })
          : appStack.publicAlb.metrics.requestCount({
              statistic: "Sum",
              period: Duration.minutes(5),
              label: "Requests",
            }),
      ],
      leftYAxis: { min: 0, label: "requests" },
      right: [
        metricsByName
          ? albMetric("HTTPCode_Target_5XX_Count", "Sum", {
              period: Duration.minutes(5),
              label: "Target 5xx",
            })
          : appStack.publicAlb.metrics.httpCodeTarget(
              elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
              {
                statistic: "Sum",
                period: Duration.minutes(5),
                label: "Target 5xx",
              },
            ),
        metricsByName
          ? albMetric("HTTPCode_Target_4XX_Count", "Sum", {
              period: Duration.minutes(5),
              label: "Target 4xx",
            })
          : appStack.publicAlb.metrics.httpCodeTarget(
              elbv2.HttpCodeTarget.TARGET_4XX_COUNT,
              {
                statistic: "Sum",
                period: Duration.minutes(5),
                label: "Target 4xx",
              },
            ),
        metricsByName
          ? albMetric("HTTPCode_ELB_5XX_Count", "Sum", {
              period: Duration.minutes(5),
              label: "ELB 5xx",
            })
          : appStack.publicAlb.metrics.httpCodeElb(
              elbv2.HttpCodeElb.ELB_5XX_COUNT,
              {
                statistic: "Sum",
                period: Duration.minutes(5),
                label: "ELB 5xx",
              },
            ),
      ],
      rightYAxis: { min: 0, label: "errors" },
    });

    // ---- CloudFront row ---------------------------------------------
    const cfErrorWidget = new cloudwatch.GraphWidget({
      title: "CloudFront error rate (%) + requests",
      width: 8,
      height: 6,
      left: [
        cfMetric("TotalErrorRate", "Average", "Total error rate"),
        cfMetric("4xxErrorRate", "Average", "4xx rate"),
        cfMetric("5xxErrorRate", "Average", "5xx rate"),
      ],
      leftYAxis: { min: 0, max: 100, label: "percent" },
      right: [cfMetric("Requests", "Sum", "Requests")],
      rightYAxis: { min: 0, label: "requests" },
    });

    const cfVolumeWidget = new cloudwatch.GraphWidget({
      title: "CloudFront bytes downloaded (5m sum)",
      width: 8,
      height: 6,
      left: [cfMetric("BytesDownloaded", "Sum", "Bytes downloaded")],
      leftYAxis: { min: 0, label: "bytes" },
    });

    // OriginLatency is a CloudFront additional metric (EdgeStack enables it via
    // publishAdditionalMetrics); the average + p99 origin round-trip is the
    // edge-to-ALB time and the first thing to check when ALB latency looks fine
    // but users report slow edges. ms (additional metrics are reported in ms).
    const cfLatencyWidget = new cloudwatch.GraphWidget({
      title: "CloudFront origin latency (ms)",
      width: 8,
      height: 6,
      left: [
        cfMetric("OriginLatency", "Average", "Origin latency avg"),
        cfMetric("OriginLatency", "p99", "Origin latency p99"),
      ],
      leftYAxis: { min: 0, label: "ms" },
    });

    // ---- ECS row ----------------------------------------------------
    const ecsUtilWidget = new cloudwatch.GraphWidget({
      title: "ECS CPU / Memory (%)",
      width: 12,
      height: 6,
      left: [
        appStack.ecsService.metricCpuUtilization({
          statistic: "Average",
          period: Duration.minutes(5),
          label: "CPU %",
        }),
        appStack.ecsService.metricMemoryUtilization({
          statistic: "Average",
          period: Duration.minutes(5),
          label: "Memory %",
        }),
      ],
      leftYAxis: { min: 0, max: 100, label: "percent" },
    });

    const ecsTasksWidget = new cloudwatch.GraphWidget({
      title: "ECS running vs desired tasks",
      width: 12,
      height: 6,
      left: [
        ecsTaskCountMetric("RunningTaskCount", "Minimum", "Running (min)"),
        ecsTaskCountMetric("DesiredTaskCount", "Maximum", "Desired (max)"),
      ],
      leftYAxis: { min: 0, label: "tasks" },
    });

    // ---- Aurora row (three-up, width 8 each = 24-col grid) ----------
    const auroraCpuWidget = new cloudwatch.GraphWidget({
      title: "Aurora CPU (%)",
      width: 8,
      height: 6,
      left: [
        metricsByName
          ? dbMetric("CPUUtilization", "Average", {
              period: Duration.minutes(5),
              label: "CPU %",
            })
          : dataStack.auroraCluster.metricCPUUtilization({
              statistic: "Average",
              period: Duration.minutes(5),
              label: "CPU %",
            }),
      ],
      leftYAxis: { min: 0, max: 100, label: "percent" },
    });

    const auroraConnWidget = new cloudwatch.GraphWidget({
      title: "Aurora connections",
      width: 8,
      height: 6,
      left: [
        metricsByName
          ? dbMetric("DatabaseConnections", "Maximum", {
              period: Duration.minutes(5),
              label: "Connections (max)",
            })
          : dataStack.auroraCluster.metricDatabaseConnections({
              statistic: "Maximum",
              period: Duration.minutes(5),
              label: "Connections (max)",
            }),
      ],
      leftYAxis: { min: 0, label: "connections" },
    });

    // SelectLatency has no dedicated L2 helper in 2.254 -- use the generic
    // `.metric(name, props)` accessor (same pattern as the OpenSearch alarms).
    const auroraSelectLatencyWidget = new cloudwatch.GraphWidget({
      title: "Aurora SelectLatency (ms)",
      width: 8,
      height: 6,
      left: [
        metricsByName
          ? dbMetric("SelectLatency", "Average", {
              period: Duration.minutes(5),
              label: "Select latency",
            })
          : dataStack.auroraCluster.metric("SelectLatency", {
              statistic: "Average",
              period: Duration.minutes(5),
              label: "Select latency",
            }),
      ],
      leftYAxis: { min: 0, label: "ms" },
    });

    // ---- Compose: a TextWidget header (full-width 24) forces a row break
    // before each section; addWidgets lays out left-to-right wrapping at the
    // 24-column grid edge. -------------------------------------------------
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# SPS reliability -- ${env}\nALB / CloudFront / ECS / Aurora. Read-only mirror of the page-topic alarms. See docs/SLOs.md.`,
        width: 24,
        height: 2,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: "## Public ALB", width: 24, height: 1 }),
    );
    dashboard.addWidgets(albLatencyWidget, albTrafficWidget);
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: "## CloudFront edge",
        width: 24,
        height: 1,
      }),
    );
    dashboard.addWidgets(cfLatencyWidget, cfErrorWidget, cfVolumeWidget);
    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: "## ECS service", width: 24, height: 1 }),
    );
    dashboard.addWidgets(ecsUtilWidget, ecsTasksWidget);
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: "## Aurora cluster",
        width: 24,
        height: 1,
      }),
    );
    dashboard.addWidgets(
      auroraCpuWidget,
      auroraConnWidget,
      auroraSelectLatencyWidget,
    );

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
    new CfnOutput(this, "WarnTopicArn", {
      value: this.warnTopic.topicArn,
      description:
        "SNS topic for the P2 warn tier (data-freshness / reconciler / resource-pressure). Relayed to a separate Teams channel, falling back to the page channel if scholars/{env}/oncall/teams-webhook-url-warn is unset.",
    });
    new CfnOutput(this, "OncallRelayFunctionArn", {
      value: relay.functionArn,
      description:
        "Lambda that relays page topic SNS events to a Teams workflow as Adaptive Card JSON (B27). Reads workflow URL from scholars/{env}/oncall/teams-webhook-url at cold start.",
    });
  }
}
