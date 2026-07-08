import * as path from "node:path";
import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as athena from "aws-cdk-lib/aws-athena";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link AnalyticsStack}. */
export interface AnalyticsStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /**
   * The AppStack ECS task role. AnalyticsStack attaches a workgroup-scoped
   * Athena/Glue/S3 policy to it here (rather than AppStack importing the
   * CFN-named analytics bucket) so the in-app Usage dashboard can query the
   * `daily_usage` rollup. Gives an Analytics→App stack dependency; the grant is
   * usage-table-only (no read on the raw `cf_access_logs` S3 data / PII).
   */
  readonly appTaskRole: iam.IRole;
}

/**
 * AnalyticsStack — CloudFront usage analytics (ADR-008, the 9th stack).
 *
 * Per-env stack (`Sps-Analytics-${env}`, both envs). Turns the raw CloudFront
 * standard access logs that EdgeStack writes to `s3://<logsBucket>/cf/<env>/`
 * into a nightly pre-aggregated `daily_usage` table an operator (or a BI tool)
 * can query cheaply for marketing metrics -- pageviews, top profiles, search
 * terms, referrers, geo, device class.
 *
 * Layout:
 * - A NEW durable analytics bucket (RETAIN, no expiry lifecycle) holds the
 *   Athena query results (`athena-results/`) and the rollup partitions
 *   (`rollup/daily-usage/`). It is deliberately SEPARATE from EdgeStack's log
 *   bucket: that bucket has a blanket 90-day expiry rule
 *   (`sps-cf-logs-expire-${env}`, no prefix filter) that would delete rollups
 *   we intend to keep.
 * - Glue catalog: database `sps_usage_${env}`, external table `cf_access_logs`
 *   over the raw CF logs, and `daily_usage` (TSV, partition-projected on dt so
 *   no MSCK REPAIR / partition catalog management is ever needed).
 * - Athena workgroup `sps-usage-${env}` (enforced config, SSE-S3 results, a
 *   bytes-scanned cost cap) + saved CfnNamedQuery marketing queries.
 * - A nightly rollup Lambda (`sps-cf-usage-rollup-${env}`) fired by an
 *   EventBridge rule, gated on `envConfig.usageRollupScheduleEnabled`.
 *
 * SECURITY / PII (ADR-008): the durable `daily_usage` table holds ONLY
 * aggregates (counts by dimension); the rollup Lambda never writes raw client
 * IPs to it. The raw `cf_access_logs` table and the Athena workgroup DO expose
 * client IPs and unredacted paths, so access to this stack's Glue catalog +
 * workgroup is operator-restricted -- do not add public or broad grants. The
 * Lambda role is least-privilege (scoped to the workgroup ARN, the catalog/db/
 * tables, and the two specific bucket prefixes); no `s3:*` or `athena:*`.
 */
export class AnalyticsStack extends Stack {
  /** Durable bucket for Athena results + rollup partitions (no expiry). */
  public readonly analyticsBucket: s3.Bucket;
  /** The nightly rollup Lambda. */
  public readonly rollupFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const env = envConfig.envName;

    // Raw CloudFront access-log bucket, referenced by NAME (not the EdgeStack
    // L2 handle) so this stack deploys standalone while EdgeStack is frozen
    // behind the #502 NetScaler/WAF decision -- importing edgeStack.logsBucket
    // would force an Edge redeploy that, without the live domain/cert/cidr
    // context, would strip prod's alias + cert + WAF. The name is config-pinned
    // and stable (the bucket is RETAIN).
    const rawLogsBucket = s3.Bucket.fromBucketName(
      this,
      "RawLogsBucket",
      envConfig.cloudFrontLogsBucketName,
    );

    // Object-key prefixes (kept as consts so the table LOCATION, the Lambda
    // env, and the IAM scoping all reference the same literal -- a drift
    // between any two of them silently breaks the rollup at runtime).
    const athenaResultsPrefix = "athena-results";
    const rollupPrefix = "rollup/daily-usage";

    // ------------------------------------------------------------------
    // Durable analytics bucket (RETAIN, no expiry).
    //
    // Separate from EdgeStack.logsBucket on purpose: that bucket's 90-day
    // blanket lifecycle (no prefix filter) would delete rollups. This bucket
    // has NO lifecycle rule -- rollups are tiny aggregate files we keep
    // indefinitely so they survive the raw-log expiry. Name left unset so CFN
    // generates a unique env-scoped name (the stack name carries ${env}),
    // mirroring EdgeStack.logsBucket. enforceSSL synthesizes a deny-non-TLS
    // bucket policy; S3_MANAGED + BLOCK_ALL match the rest of the estate.
    // ------------------------------------------------------------------
    this.analyticsBucket = new s3.Bucket(this, "AnalyticsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // NO lifecycleRules -- the durable home for rollups.
    });

    // ------------------------------------------------------------------
    // Glue catalog database. One Glue Data Catalog per account, so the db
    // name carries the env suffix to isolate staging/prod within the shared
    // catalog. catalogId is the deploying account (Aws.ACCOUNT_ID).
    // ------------------------------------------------------------------
    const usageDatabase = new glue.CfnDatabase(this, "UsageDatabase", {
      catalogId: Aws.ACCOUNT_ID,
      databaseInput: {
        name: `sps_usage_${env}`,
        description: `SPS CloudFront usage analytics (${env}). Backs Athena queries over CloudFront access logs.`,
      },
    });

    // ------------------------------------------------------------------
    // Raw external table over the CloudFront standard (legacy) access logs.
    //
    // EdgeStack writes them to logsBucket at prefix cf/<env>/ (logFilePrefix).
    // The format is tab-separated, gzip-compressed, with TWO header lines
    // (#Version and #Fields) -- so LazySimpleSerDe + field.delim TAB +
    // skip.header.line.count=2. Column order MUST match the CloudFront
    // standard-log field order exactly (33 columns); reordering silently
    // misreads. Gzip is auto-detected from the .gz extension; no
    // compressionType key needed. The AWS-documented column names are used
    // verbatim, including the double-r `cs_referrer` spelling and the
    // reserved-word `date`/`time` (the rollup SQL double-quotes "date").
    //
    // LOCATION derives from the L2 handle (synth-time name guarantee), not a
    // hardcoded bucket name.
    // ------------------------------------------------------------------
    const rawTable = new glue.CfnTable(this, "CfAccessLogsTable", {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: usageDatabase.ref,
      tableInput: {
        name: "cf_access_logs",
        description: `Raw CloudFront standard access logs (${env}), TSV+gzip, 2 header lines. Exposes client IPs -- operator-restricted.`,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          classification: "csv",
          "skip.header.line.count": "2",
        },
        storageDescriptor: {
          columns: [
            { name: "date", type: "date" },
            { name: "time", type: "string" },
            { name: "x_edge_location", type: "string" },
            { name: "sc_bytes", type: "bigint" },
            { name: "c_ip", type: "string" },
            { name: "cs_method", type: "string" },
            { name: "cs_host", type: "string" },
            { name: "cs_uri_stem", type: "string" },
            { name: "sc_status", type: "int" },
            { name: "cs_referrer", type: "string" },
            { name: "cs_user_agent", type: "string" },
            { name: "cs_uri_query", type: "string" },
            { name: "cs_cookie", type: "string" },
            { name: "x_edge_result_type", type: "string" },
            { name: "x_edge_request_id", type: "string" },
            { name: "x_host_header", type: "string" },
            { name: "cs_protocol", type: "string" },
            { name: "cs_bytes", type: "bigint" },
            { name: "time_taken", type: "float" },
            { name: "x_forwarded_for", type: "string" },
            { name: "ssl_protocol", type: "string" },
            { name: "ssl_cipher", type: "string" },
            { name: "x_edge_response_result_type", type: "string" },
            { name: "cs_protocol_version", type: "string" },
            { name: "fle_status", type: "string" },
            { name: "fle_encrypted_fields", type: "int" },
            { name: "c_port", type: "int" },
            { name: "time_to_first_byte", type: "float" },
            { name: "x_edge_detailed_result_type", type: "string" },
            { name: "sc_content_type", type: "string" },
            { name: "sc_content_len", type: "bigint" },
            { name: "sc_range_start", type: "bigint" },
            { name: "sc_range_end", type: "bigint" },
          ],
          location: rawLogsBucket.s3UrlForObject(`cf/${env}/`),
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat:
            "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary:
              "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
            parameters: { "field.delim": "\t" },
          },
        },
      },
    });

    // ------------------------------------------------------------------
    // Rollup table `daily_usage`: pre-aggregated daily usage, TSV, partitioned
    // by dt with PARTITION PROJECTION so Athena never needs MSCK REPAIR and the
    // rollup Lambda never manages the Glue partition catalog. Non-partition
    // columns are (metric, dimension, cnt); dt is the projected partition key.
    // Lives in the durable analytics bucket under rollup/daily-usage/.
    //
    // The storage.location.template's ${dt} placeholder is interpolated by
    // ATHENA at query time -- it is a literal string, NOT a TS template
    // expression. It is built by string concat so neither TS nor Prettier
    // touches the ${dt}. A synth-time guard asserts the literal survives.
    // ------------------------------------------------------------------
    const rollupLocation = this.analyticsBucket.s3UrlForObject(rollupPrefix);
    const dailyUsageTable = new glue.CfnTable(this, "DailyUsageTable", {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: usageDatabase.ref,
      tableInput: {
        name: "daily_usage",
        description: `Pre-aggregated daily CloudFront usage (${env}), TSV, partition-projected on dt. Aggregates only -- no client IPs.`,
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "dt", type: "string" }],
        parameters: {
          classification: "csv",
          "projection.enabled": "true",
          "projection.dt.type": "date",
          // First CF log day is 2026-05-22 (AWS handles); NOW = today sentinel.
          "projection.dt.range": "2026-05-22,NOW",
          "projection.dt.format": "yyyy-MM-dd",
          "storage.location.template": `${rollupLocation}/dt=` + "${dt}/",
        },
        storageDescriptor: {
          columns: [
            { name: "metric", type: "string" },
            { name: "dimension", type: "string" },
            { name: "cnt", type: "bigint" },
          ],
          location: rollupLocation,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat:
            "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary:
              "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
            parameters: { "field.delim": "\t" },
          },
        },
      },
    });
    dailyUsageTable.addDependency(usageDatabase);
    rawTable.addDependency(usageDatabase);

    // ------------------------------------------------------------------
    // Operator (interactive) Athena workgroup. Hosts the saved marketing
    // queries below and is where a human runs ad-hoc analytics. enforce=true
    // makes the result location + SSE-S3 mandatory regardless of caller input.
    // The bytes-scanned cutoff caps a runaway INTERACTIVE scan: the raw CF
    // table is unpartitioned (CloudFront writes the date into the log FILENAME,
    // not a path segment, so neither Hive partitions nor projection can prune
    // it), so a no-predicate SELECT * over cf_access_logs could scan the whole
    // prefix -- 1 GiB stops that. The nightly rollup Lambda legitimately must
    // scan the full corpus, so it runs in its OWN uncapped workgroup
    // (rollupWorkGroup, below) -- the cap here would otherwise silently fail the
    // nightly job once traffic grows. recursiveDeleteOption lets the stack tear
    // down the workgroup even with saved queries still attached.
    // ------------------------------------------------------------------
    const workGroup = new athena.CfnWorkGroup(this, "UsageWorkGroup", {
      name: `sps-usage-${env}`,
      description: `SPS CloudFront usage analytics workgroup (${env}). Operator-restricted -- exposes client IPs via cf_access_logs.`,
      recursiveDeleteOption: true,
      state: "ENABLED",
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1_073_741_824, // 1 GiB cost guard
        resultConfiguration: {
          outputLocation:
            this.analyticsBucket.s3UrlForObject(athenaResultsPrefix),
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // ------------------------------------------------------------------
    // App workgroup -- used ONLY by the in-app /edit/usage dashboard
    // (lib/analytics/athena-client.ts, via SPS_USAGE_WORKGROUP). Its results
    // land under a DEDICATED `athena-results/app/` prefix, NOT the shared
    // `athena-results/` root the operator + rollup workgroups write to. That
    // isolation is the whole point: the app task role is granted S3 read only
    // on `athena-results/app/*` below, so it can never read an operator's
    // ad-hoc query results over the PII-bearing raw `cf_access_logs` table.
    // The app only ever queries the pre-aggregated `daily_usage` table, so the
    // 1 GiB cap (mirroring the operator workgroup) is never approached.
    // ------------------------------------------------------------------
    // Referenced by NAME (SPS_USAGE_WORKGROUP env in app-stack), not by
    // construct — no local binding needed.
    new athena.CfnWorkGroup(this, "AppUsageWorkGroup", {
      name: `sps-usage-app-${env}`,
      description: `SPS in-app usage dashboard workgroup (${env}). /edit/usage only -- reads the pre-aggregated daily_usage table; results isolated under athena-results/app/.`,
      recursiveDeleteOption: true,
      state: "ENABLED",
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1_073_741_824, // 1 GiB cost guard
        resultConfiguration: {
          outputLocation: this.analyticsBucket.s3UrlForObject(
            `${athenaResultsPrefix}/app`,
          ),
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // ------------------------------------------------------------------
    // Rollup workgroup -- used ONLY by the nightly rollup Lambda. It has NO
    // bytes-scanned cap on purpose: the rollup INSERT scans the unpartitioned
    // cf_access_logs corpus (~6x per run across the UNION arms), which grows
    // past 1 GiB as traffic ramps post-launch. Capping it would silently fail
    // the nightly job and stop the durable daily_usage history accumulating --
    // the very thing this stack exists to preserve. Runaway protection instead
    // comes from the Lambda's 8-minute Athena poll budget (it stops the query)
    // and the account-wide Cost Anomaly Detection monitor (ObservabilityStack,
    // prod). Same enforced result location + SSE-S3 as the operator workgroup.
    // ------------------------------------------------------------------
    const rollupWorkGroup = new athena.CfnWorkGroup(this, "RollupWorkGroup", {
      name: `sps-usage-rollup-${env}`,
      description: `SPS CloudFront usage rollup workgroup (${env}). Nightly rollup Lambda only -- uncapped, scans the unpartitioned raw log table.`,
      recursiveDeleteOption: true,
      state: "ENABLED",
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        // No bytesScannedCutoffPerQuery -- see comment above.
        resultConfiguration: {
          outputLocation:
            this.analyticsBucket.s3UrlForObject(athenaResultsPrefix),
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // ------------------------------------------------------------------
    // Saved marketing queries (one CfnNamedQuery per metric). Each reads the
    // pre-aggregated daily_usage table by its `metric` discriminator so an
    // operator can run a metric by name without re-pasting SQL. queryString
    // is plain ASCII SQL. workGroup takes the workgroup NAME string; an
    // explicit addDependency guarantees the workgroup exists at create time.
    // ------------------------------------------------------------------
    interface SavedQuery {
      readonly constructId: string;
      readonly name: string;
      readonly description: string;
      readonly sql: string;
    }
    const savedQueries: readonly SavedQuery[] = [
      {
        constructId: "QueryDailyPageviews",
        name: `sps-usage-daily-pageviews-${env}`,
        description: "Daily profile pageviews over the rollup.",
        sql: [
          "SELECT dt, SUM(cnt) AS pageviews",
          "FROM daily_usage",
          "WHERE metric = 'pageviews'",
          "GROUP BY dt",
          "ORDER BY dt DESC",
        ].join("\n"),
      },
      {
        constructId: "QueryTopProfiles",
        name: `sps-usage-top-profiles-${env}`,
        description: "Top 50 profiles by pageview (dimension = vanity slug).",
        sql: [
          "SELECT dimension AS slug, SUM(cnt) AS views",
          "FROM daily_usage",
          "WHERE metric = 'profile'",
          "GROUP BY dimension",
          "ORDER BY views DESC",
          "LIMIT 50",
        ].join("\n"),
      },
      {
        constructId: "QuerySearchTerms",
        name: `sps-usage-search-terms-${env}`,
        description: "Top 100 search terms (dimension = decoded q=).",
        sql: [
          "SELECT dimension AS term, SUM(cnt) AS searches",
          "FROM daily_usage",
          "WHERE metric = 'search_term'",
          "GROUP BY dimension",
          "ORDER BY searches DESC",
          "LIMIT 100",
        ].join("\n"),
      },
      {
        constructId: "QueryReferrers",
        name: `sps-usage-referrers-${env}`,
        description:
          "Referrers split internal/direct vs external host (dimension).",
        sql: [
          "SELECT dimension AS referrer, SUM(cnt) AS hits",
          "FROM daily_usage",
          "WHERE metric = 'referrer'",
          "GROUP BY dimension",
          "ORDER BY hits DESC",
        ].join("\n"),
      },
      {
        constructId: "QueryGeo",
        name: `sps-usage-geo-${env}`,
        description: "Hits by coarse continent (x-edge-location based).",
        sql: [
          "SELECT dimension AS region, SUM(cnt) AS hits",
          "FROM daily_usage",
          "WHERE metric = 'geo'",
          "GROUP BY dimension",
          "ORDER BY hits DESC",
        ].join("\n"),
      },
      {
        constructId: "QueryDevice",
        name: `sps-usage-device-${env}`,
        description: "Hits by device class (bot/tablet/mobile/desktop).",
        sql: [
          "SELECT dimension AS device, SUM(cnt) AS hits",
          "FROM daily_usage",
          "WHERE metric = 'device'",
          "GROUP BY dimension",
          "ORDER BY hits DESC",
        ].join("\n"),
      },
      // --- Per-URL performance (read the RAW cf_access_logs table, not the
      // daily_usage rollup). These expose time_taken / TTFB / status the rollup
      // deliberately drops. Bounded to the trailing 7 days because cf_access_logs
      // is NOT partition-projected -- a wider window scans more log objects and
      // the workgroup's bytes-scanned cap will abort a runaway. The route
      // normalization regexp (dynamic id/slug -> ':id') is the ONE tuning point
      // for all three: add a segment name here to collapse a new dynamic route.
      // ponytail: 7-day window + regexp route-fold; widen/extend only if an
      // operator actually needs it.
      {
        constructId: "QueryPerfSlowRoutes",
        name: `sps-perf-slow-routes-${env}`,
        description:
          "Slowest routes over 7d: p50/p95/p99 time_taken + p95 TTFB (seconds), min 50 hits.",
        sql: [
          "SELECT",
          "  regexp_replace(cs_uri_stem, '(/(scholar|center|department|division|topics|topic|publication|core|unit)/)[^/?]+', '$1:id') AS route,",
          "  COUNT(*) AS hits,",
          "  round(approx_percentile(time_taken, 0.5), 3) AS p50_s,",
          "  round(approx_percentile(time_taken, 0.95), 3) AS p95_s,",
          "  round(approx_percentile(time_taken, 0.99), 3) AS p99_s,",
          "  round(approx_percentile(time_to_first_byte, 0.95), 3) AS ttfb_p95_s",
          "FROM cf_access_logs",
          "WHERE \"date\" >= current_date - interval '7' day AND cs_method = 'GET'",
          "GROUP BY 1",
          "HAVING COUNT(*) >= 50",
          "ORDER BY p95_s DESC",
          "LIMIT 50",
        ].join("\n"),
      },
      {
        constructId: "QueryPerfErrorsByRoute",
        name: `sps-perf-errors-by-route-${env}`,
        description:
          "4xx / 5xx counts + 5xx rate by route over 7d (routes with any error).",
        sql: [
          "SELECT",
          "  regexp_replace(cs_uri_stem, '(/(scholar|center|department|division|topics|topic|publication|core|unit)/)[^/?]+', '$1:id') AS route,",
          "  COUNT(*) AS hits,",
          "  SUM(CASE WHEN sc_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS c4xx,",
          "  SUM(CASE WHEN sc_status BETWEEN 500 AND 599 THEN 1 ELSE 0 END) AS c5xx,",
          "  round(100.0 * SUM(CASE WHEN sc_status >= 500 THEN 1 ELSE 0 END) / COUNT(*), 2) AS err5xx_pct",
          "FROM cf_access_logs",
          "WHERE \"date\" >= current_date - interval '7' day",
          "GROUP BY 1",
          "HAVING SUM(CASE WHEN sc_status >= 400 THEN 1 ELSE 0 END) > 0",
          "ORDER BY c5xx DESC, c4xx DESC",
          "LIMIT 50",
        ].join("\n"),
      },
      {
        constructId: "QueryPerfCacheHit",
        name: `sps-perf-cache-hit-${env}`,
        description:
          "Edge cache outcome mix over 7d (x_edge_result_type share) -- Hit/Miss/RefreshHit/Error.",
        sql: [
          "SELECT",
          "  x_edge_result_type AS result_type,",
          "  COUNT(*) AS hits,",
          "  round(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct",
          "FROM cf_access_logs",
          "WHERE \"date\" >= current_date - interval '7' day",
          "GROUP BY 1",
          "ORDER BY hits DESC",
        ].join("\n"),
      },
    ];
    for (const q of savedQueries) {
      const named = new athena.CfnNamedQuery(this, q.constructId, {
        database: usageDatabase.ref,
        workGroup: workGroup.name,
        name: q.name,
        description: q.description,
        queryString: q.sql,
      });
      named.addDependency(workGroup);
      named.addDependency(usageDatabase);
    }

    // ------------------------------------------------------------------
    // In-app Usage dashboard grant (/edit/usage). Attach a workgroup-scoped
    // Athena/Glue/S3 policy to the AppStack task role so the app can query the
    // `daily_usage` rollup at read time. Declared HERE (not via appTaskRole
    // .grant* / analyticsBucket.grantRead, which would attach to the role's
    // default policy in AppStack and import this CFN-named bucket THERE) so the
    // dependency runs Analytics->App and every ARN below is local to this stack.
    //
    // LEAST PRIVILEGE: query on the capped `sps-usage-${env}` workgroup only;
    // Glue read on the `daily_usage` table only (NOT `cf_access_logs`); S3 read
    // on the rollup-source prefix + read/write on the athena-results prefix
    // only. No S3 access to the raw `cf/` log prefix, so the app can never read
    // client IPs / unredacted paths — the usage aggregates carry no PII.
    // ------------------------------------------------------------------
    new iam.Policy(this, "AppUsageQueryPolicy", {
      policyName: `sps-usage-app-query-${env}`,
      roles: [props.appTaskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "AthenaUsageWorkgroup",
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
          ],
          resources: [
            this.formatArn({
              service: "athena",
              resource: "workgroup",
              // App-only workgroup — results land under athena-results/app/, NOT
              // the shared root the operator/rollup workgroups use.
              resourceName: `sps-usage-app-${env}`,
            }),
          ],
        }),
        new iam.PolicyStatement({
          sid: "GlueUsageTableRead",
          actions: [
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartition",
            "glue:GetPartitions",
          ],
          resources: [
            this.formatArn({ service: "glue", resource: "catalog" }),
            this.formatArn({
              service: "glue",
              resource: "database",
              resourceName: `sps_usage_${env}`,
            }),
            this.formatArn({
              service: "glue",
              resource: "table",
              resourceName: `sps_usage_${env}/daily_usage`,
            }),
          ],
        }),
        new iam.PolicyStatement({
          sid: "S3UsageSourceAndResults",
          actions: ["s3:GetBucketLocation", "s3:ListBucket"],
          resources: [this.analyticsBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: "S3UsageRollupRead",
          actions: ["s3:GetObject"],
          resources: [this.analyticsBucket.arnForObjects(`${rollupPrefix}/*`)],
        }),
        new iam.PolicyStatement({
          sid: "S3AthenaResultsReadWrite",
          actions: ["s3:GetObject", "s3:PutObject"],
          // Scoped to the app workgroup's OWN result prefix. Previously
          // `athena-results/*` — the shared root where operator ad-hoc queries
          // (over PII-bearing raw cf_access_logs) also write, which the app
          // task role could then read. The app now reads/writes only its own.
          resources: [
            this.analyticsBucket.arnForObjects(`${athenaResultsPrefix}/app/*`),
          ],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // Rollup Lambda. Mirrors observability-stack.ts OncallRelayFunction: an
    // explicit log group (NO logRetention prop -- that pulls in a CFN custom
    // resource Lambda+Role that would inflate the resource counts), NODEJS_22_X,
    // externalize every @aws-sdk/* client (they ship in the runtime),
    // sourceMap off, target node22. Athena polling is mostly idle wait so the
    // timeout is generous; memory stays modest.
    // ------------------------------------------------------------------
    const rollupLogGroup = new logs.LogGroup(this, "CfUsageRollupLogGroup", {
      logGroupName: `/aws/lambda/sps-cf-usage-rollup-${env}`,
      retention: logs.RetentionDays.THREE_MONTHS,
    });

    const rollupFn = new NodejsFunction(this, "CfUsageRollupFunction", {
      functionName: `sps-cf-usage-rollup-${env}`,
      entry: path.join(__dirname, "../lambda/cf-usage-rollup/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.minutes(10),
      logGroup: rollupLogGroup,
      environment: {
        ATHENA_DATABASE: usageDatabase.ref,
        // The rollup runs in the uncapped rollup workgroup, NOT the 1 GiB-capped
        // operator workgroup -- it must scan the full unpartitioned corpus.
        ATHENA_WORKGROUP: rollupWorkGroup.name,
        RAW_TABLE: "cf_access_logs",
        ROLLUP_TABLE: "daily_usage",
        ANALYTICS_BUCKET: this.analyticsBucket.bucketName,
        ROLLUP_PREFIX: rollupPrefix,
        RESULT_OUTPUT:
          this.analyticsBucket.s3UrlForObject(athenaResultsPrefix),
      },
      bundling: {
        // Both clients ship in the NODEJS_22_X runtime; bundling them inflates
        // cold start. Their typecheck/resolve from cdk root depends on the
        // workspace hoist (lambda/cf-usage-rollup is a workspace -- see
        // cdk/package.json).
        externalModules: ["@aws-sdk/client-athena", "@aws-sdk/client-s3"],
        sourceMap: false,
        target: "node22",
      },
    });
    this.rollupFunction = rollupFn;

    // ------------------------------------------------------------------
    // Least-privilege IAM for the rollup Lambda. Scoped to the workgroup ARN +
    // the catalog/db/tables + the two analytics-bucket prefixes and the raw
    // cf/<env>/ prefix. NEVER s3:* or athena:* (asserted at synth time).
    // ------------------------------------------------------------------
    const rawBucketArn = rawLogsBucket.bucketArn;
    const analyticsBucketArn = this.analyticsBucket.bucketArn;
    // The Lambda only ever runs queries in the rollup workgroup -- scope the
    // Athena grant to it (not the operator workgroup).
    const workGroupArn = `arn:${Aws.PARTITION}:athena:${this.region}:${this.account}:workgroup/${rollupWorkGroup.name}`;
    const catalogArn = `arn:${Aws.PARTITION}:glue:${this.region}:${this.account}:catalog`;
    const dbArn = `arn:${Aws.PARTITION}:glue:${this.region}:${this.account}:database/${usageDatabase.ref}`;
    const tableArn = `arn:${Aws.PARTITION}:glue:${this.region}:${this.account}:table/${usageDatabase.ref}/*`;

    // Athena: start/poll/stop/read a query confined to our workgroup.
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:StopQueryExecution",
          "athena:GetQueryResults",
        ],
        resources: [workGroupArn],
      }),
    );

    // Glue: Athena's query planner reads table + partition metadata, and the
    // INSERT writes new partitions to the catalog.
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "glue:GetDatabase",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartition",
          "glue:GetPartitions",
          "glue:BatchCreatePartition",
          "glue:CreatePartition",
        ],
        resources: [catalogArn, dbArn, tableArn],
      }),
    );

    // S3 bucket-level: GetBucketLocation MUST be a separate, UNCONDITIONED
    // statement. It is a bucket-level call that carries no `s3:prefix` request
    // context, so gating it with the `s3:prefix` condition below silently voids
    // the grant -- Athena calls GetBucketLocation on both the source and result
    // buckets at StartQueryExecution, and the denial surfaces at runtime as
    // "Unable to verify/create output bucket" (deploy-only bug; cdk synth +
    // assertions cannot catch the IAM-condition semantics). Region lookup only,
    // low sensitivity.
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetBucketLocation"],
        resources: [rawBucketArn, analyticsBucketArn],
      }),
    );
    // S3 list: scope each bucket's object listing to the exact prefixes the
    // rollup touches (raw cf/<env>/*, and the rollup + athena-results prefixes).
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [rawBucketArn],
        conditions: { StringLike: { "s3:prefix": [`cf/${env}/*`] } },
      }),
    );
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [analyticsBucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [`${rollupPrefix}/*`, `${athenaResultsPrefix}/*`],
          },
        },
      }),
    );
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`${rawBucketArn}/cf/${env}/*`],
      }),
    );
    rollupFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [
          `${analyticsBucketArn}/${rollupPrefix}/*`,
          `${analyticsBucketArn}/${athenaResultsPrefix}/*`,
        ],
      }),
    );

    // ------------------------------------------------------------------
    // EventBridge nightly schedule. Mirrors etl-stack.ts: a cron via
    // Schedule.expression + an eventsTargets.LambdaFunction, `enabled` gated on
    // a config flag so an env can ship the rollup paused without a code change.
    // Runs 08:00 UTC -- one hour after the nightly ETL cron(0 7 * * ? *) so it
    // never races the index rebuild, and well after CloudFront flushes the
    // prior day's logs (which can lag hours; the handler defaults to a trailing
    // 2-day window to absorb late arrivals).
    // ------------------------------------------------------------------
    const rollupRule = new events.Rule(this, "CfUsageRollupScheduleRule", {
      ruleName: `sps-cf-usage-rollup-${env}`,
      description: `SPS CloudFront usage daily rollup (${env}). Runs 08:00 UTC.`,
      schedule: events.Schedule.expression("cron(0 8 * * ? *)"),
      enabled: envConfig.usageRollupScheduleEnabled,
    });
    rollupRule.addTarget(
      new eventsTargets.LambdaFunction(rollupFn, {
        // Empty input -> handler defaults to a trailing 2-day UTC window.
        event: events.RuleTargetInput.fromObject({}),
        retryAttempts: 2,
      }),
    );
  }
}
