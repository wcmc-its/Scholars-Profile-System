import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Template } from "aws-cdk-lib/assertions";
import { AnalyticsStack } from "../lib/analytics-stack";
import { makeFixture } from "./test-utils";

function buildAnalyticsStack(envName: "staging" | "prod"): {
  template: Template;
  stack: AnalyticsStack;
} {
  const fixture = makeFixture(envName);
  // AnalyticsStack references the raw CloudFront log bucket BY NAME
  // (envConfig.cloudFrontLogsBucketName) rather than via an EdgeStack handle,
  // so it stands alone with no prerequisite stacks (it deploys while EdgeStack
  // is frozen behind #502). Its only prop dependency is the AppStack task role
  // (for the in-app Usage dashboard grant) — stubbed here by ARN so the stack
  // still synthesizes standalone.
  const roleScope = new Stack(fixture.app, `AppStub-${envName}`);
  const appTaskRole = iam.Role.fromRoleArn(
    roleScope,
    "AppTaskRoleStub",
    `arn:aws:iam::123456789012:role/sps-task-${envName}`,
  );
  const stack = new AnalyticsStack(fixture.app, `Sps-Analytics-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    appTaskRole,
  });
  return { template: Template.fromStack(stack), stack };
}

// Reuse the observability-stack printable-ASCII invariant (Footgun #6): names
// + descriptions that become AWS properties must be plain ASCII, since non-
// ASCII passes synth and fails at deploy.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

describe("AnalyticsStack", () => {
  for (const env of ["prod", "staging"] as const) {
    describe(env, () => {
      const { template } = buildAnalyticsStack(env);

      it("matches the snapshot", () => {
        expect(template.toJSON()).toMatchSnapshot();
      });

      // ---- S3 durable bucket -----------------------------------------
      it("creates exactly one durable analytics bucket", () => {
        template.resourceCountIs("AWS::S3::Bucket", 1);
      });

      it("analytics bucket is RETAIN with no expiry lifecycle, SSE + block-public", () => {
        const buckets = template.findResources("AWS::S3::Bucket");
        const b = Object.values(buckets)[0];
        // RETAIN deletion policy (durable home for rollups).
        expect(b?.DeletionPolicy).toBe("Retain");
        const props = b?.Properties as {
          LifecycleConfiguration?: unknown;
          PublicAccessBlockConfiguration?: Record<string, boolean>;
          BucketEncryption?: unknown;
        };
        // NO lifecycle rule -- rollups must survive the 90-day raw-log expiry.
        expect(props?.LifecycleConfiguration).toBeUndefined();
        expect(props?.BucketEncryption).toBeDefined();
        const pab = props?.PublicAccessBlockConfiguration;
        expect(pab?.BlockPublicAcls).toBe(true);
        expect(pab?.BlockPublicPolicy).toBe(true);
        expect(pab?.IgnorePublicAcls).toBe(true);
        expect(pab?.RestrictPublicBuckets).toBe(true);
      });

      it("enforces SSL on the analytics bucket (deny non-TLS)", () => {
        // enforceSSL synthesizes a bucket policy with a denyInsecure statement.
        template.resourceCountIs("AWS::S3::BucketPolicy", 1);
      });

      // ---- Glue ------------------------------------------------------
      it("creates the env-suffixed Glue database", () => {
        template.resourceCountIs("AWS::Glue::Database", 1);
        template.hasResourceProperties("AWS::Glue::Database", {
          DatabaseInput: { Name: `sps_usage_${env}` },
        });
      });

      it("creates exactly two Glue tables (cf_access_logs + daily_usage)", () => {
        template.resourceCountIs("AWS::Glue::Table", 2);
        const tables = template.findResources("AWS::Glue::Table");
        const names = Object.values(tables)
          .map(
            (t) =>
              (t.Properties as { TableInput?: { Name?: string } })?.TableInput
                ?.Name,
          )
          .filter((n): n is string => typeof n === "string")
          .sort();
        expect(names).toEqual(["cf_access_logs", "daily_usage"]);
      });

      it("raw table skips 2 header lines + TAB delim + 33 CF columns", () => {
        const tables = template.findResources("AWS::Glue::Table");
        const raw = Object.values(tables).find(
          (t) =>
            (t.Properties as { TableInput?: { Name?: string } })?.TableInput
              ?.Name === "cf_access_logs",
        );
        const ti = (raw?.Properties as { TableInput?: Record<string, unknown> })
          ?.TableInput as {
          Parameters?: Record<string, string>;
          StorageDescriptor?: {
            Columns?: unknown[];
            SerdeInfo?: { Parameters?: Record<string, string> };
          };
        };
        expect(ti?.Parameters?.["skip.header.line.count"]).toBe("2");
        expect(
          ti?.StorageDescriptor?.SerdeInfo?.Parameters?.["field.delim"],
        ).toBe("\t");
        expect(ti?.StorageDescriptor?.Columns).toHaveLength(33);
      });

      it("daily_usage is partition-projected on dt with the literal dt template", () => {
        const tables = template.findResources("AWS::Glue::Table");
        const daily = Object.values(tables).find(
          (t) =>
            (t.Properties as { TableInput?: { Name?: string } })?.TableInput
              ?.Name === "daily_usage",
        );
        const ti = (
          daily?.Properties as { TableInput?: Record<string, unknown> }
        )?.TableInput as {
          Parameters?: Record<string, string>;
          PartitionKeys?: Array<{ Name: string; Type: string }>;
          StorageDescriptor?: { Columns?: Array<{ Name: string }> };
        };
        expect(ti?.Parameters?.["projection.enabled"]).toBe("true");
        // Regression guard: the ${dt} literal must NOT be interpolated away.
        // The template is an Fn::Join (the analytics bucket name is a
        // CFN-generated Ref), so serialize it and grep the literal fragment.
        expect(
          JSON.stringify(ti?.Parameters?.["storage.location.template"]),
        ).toContain("dt=${dt}/");
        expect(ti?.PartitionKeys).toEqual([{ Name: "dt", Type: "string" }]);
        const cols = (ti?.StorageDescriptor?.Columns ?? []).map((c) => c.Name);
        expect(cols).toEqual(["metric", "dimension", "cnt"]);
      });

      // ---- Athena ----------------------------------------------------
      it("creates three workgroups: operator (1 GiB cap) + rollup (uncapped) + app (isolated results)", () => {
        template.resourceCountIs("AWS::Athena::WorkGroup", 3);
        // Operator workgroup: enforced config, SSE-S3, 1 GiB scan cap (guards
        // an interactive no-predicate scan of the unpartitioned raw table).
        template.hasResourceProperties("AWS::Athena::WorkGroup", {
          Name: `sps-usage-${env}`,
          WorkGroupConfiguration: {
            EnforceWorkGroupConfiguration: true,
            PublishCloudWatchMetricsEnabled: true,
            BytesScannedCutoffPerQuery: 1073741824,
            ResultConfiguration: {
              EncryptionConfiguration: { EncryptionOption: "SSE_S3" },
            },
          },
        });
        // App workgroup: same enforced config + cap, but results land under a
        // DEDICATED athena-results/app/ prefix so the app role's scoped S3 read
        // can never reach an operator's ad-hoc results over the raw PII table.
        const appWg = Object.values(
          template.findResources("AWS::Athena::WorkGroup"),
        ).find(
          (w) =>
            (w.Properties as { Name?: string })?.Name === `sps-usage-app-${env}`,
        );
        expect(appWg).toBeDefined();
        const appCfg = (
          appWg!.Properties as {
            WorkGroupConfiguration?: {
              EnforceWorkGroupConfiguration?: boolean;
              BytesScannedCutoffPerQuery?: number;
              ResultConfiguration?: { OutputLocation?: unknown };
            };
          }
        ).WorkGroupConfiguration;
        expect(appCfg?.EnforceWorkGroupConfiguration).toBe(true);
        expect(appCfg?.BytesScannedCutoffPerQuery).toBe(1073741824);
        expect(JSON.stringify(appCfg?.ResultConfiguration?.OutputLocation)).toContain(
          "athena-results/app",
        );
        // Rollup workgroup: enforced config + SSE-S3 but NO scan cap -- the
        // nightly rollup must scan the full corpus, and a cap would silently
        // fail the job as traffic grows (finding #2).
        const wgs = template.findResources("AWS::Athena::WorkGroup");
        const rollup = Object.values(wgs).find(
          (w) =>
            (w.Properties as { Name?: string })?.Name ===
            `sps-usage-rollup-${env}`,
        );
        expect(rollup).toBeDefined();
        const cfg = (
          rollup!.Properties as {
            WorkGroupConfiguration?: {
              EnforceWorkGroupConfiguration?: boolean;
              BytesScannedCutoffPerQuery?: number;
              ResultConfiguration?: {
                EncryptionConfiguration?: { EncryptionOption?: string };
              };
            };
          }
        ).WorkGroupConfiguration;
        expect(cfg?.EnforceWorkGroupConfiguration).toBe(true);
        expect(
          cfg?.ResultConfiguration?.EncryptionConfiguration?.EncryptionOption,
        ).toBe("SSE_S3");
        expect(cfg?.BytesScannedCutoffPerQuery).toBeUndefined();
      });

      it("creates the six marketing + three perf saved named queries", () => {
        template.resourceCountIs("AWS::Athena::NamedQuery", 9);
        const qs = template.findResources("AWS::Athena::NamedQuery");
        const names = Object.values(qs)
          .map((q) => (q.Properties as { Name?: string })?.Name)
          .filter((n): n is string => typeof n === "string")
          .sort();
        expect(names).toEqual(
          [
            `sps-usage-daily-pageviews-${env}`,
            `sps-usage-device-${env}`,
            `sps-usage-geo-${env}`,
            `sps-usage-referrers-${env}`,
            `sps-usage-search-terms-${env}`,
            `sps-usage-top-profiles-${env}`,
            `sps-perf-slow-routes-${env}`,
            `sps-perf-errors-by-route-${env}`,
            `sps-perf-cache-hit-${env}`,
          ].sort(),
        );
      });

      // ---- In-app Usage dashboard grant (least privilege / PII boundary) ----
      it("grants the app task role workgroup-scoped Athena but NO raw-log access", () => {
        const policies = template.findResources("AWS::IAM::Policy", {
          Properties: { PolicyName: `sps-usage-app-query-${env}` },
        });
        const docs = Object.values(policies).map(
          (p) => (p.Properties as { PolicyDocument: unknown }).PolicyDocument,
        );
        expect(docs).toHaveLength(1);
        const json = JSON.stringify(docs[0]);
        // Query is on the app-only workgroup — NOT the operator workgroup (whose
        // ad-hoc results over the raw PII table share athena-results/ root) and
        // NOT the rollup workgroup.
        expect(json).toContain(`workgroup/sps-usage-app-${env}`);
        expect(json).not.toContain(`workgroup/sps-usage-${env}"`);
        expect(json).not.toContain(`workgroup/sps-usage-rollup-${env}`);
        // Glue read is scoped to daily_usage only — never the raw PII table.
        expect(json).toContain("daily_usage");
        expect(json).not.toContain("cf_access_logs");
        // S3 read on results is scoped to the app's OWN prefix (athena-results/app/),
        // never the shared athena-results/ root, and never the raw `cf/` log prefix.
        expect(json).toContain("rollup/daily-usage/*");
        expect(json).toContain("athena-results/app/*");
        expect(json).not.toMatch(/"[^"]*athena-results\/\*"/);
        expect(json).not.toMatch(/"[^"]*\/cf\/\*?"/);
      });

      // ---- Lambda ----------------------------------------------------
      it("creates exactly one rollup Lambda (no logRetention custom resource)", () => {
        template.resourceCountIs("AWS::Lambda::Function", 1);
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: `sps-cf-usage-rollup-${env}`,
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          MemorySize: 256,
          Timeout: 600,
        });
      });

      it("rollup Lambda targets the uncapped rollup workgroup (env var)", () => {
        const fns = template.findResources("AWS::Lambda::Function");
        const target = Object.values(fns)
          .map(
            (f) =>
              (
                f.Properties as {
                  Environment?: { Variables?: Record<string, unknown> };
                }
              )?.Environment?.Variables,
          )
          .find((v) => v?.ATHENA_WORKGROUP !== undefined);
        expect(target?.ATHENA_WORKGROUP).toBe(`sps-usage-rollup-${env}`);
      });

      it("Lambda owns one explicit log group (3-month retention)", () => {
        template.resourceCountIs("AWS::Logs::LogGroup", 1);
        template.hasResourceProperties("AWS::Logs::LogGroup", {
          LogGroupName: `/aws/lambda/sps-cf-usage-rollup-${env}`,
          RetentionInDays: 90,
        });
      });

      it("rollup IAM never grants s3:* or athena:* (least-priv)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        for (const p of Object.values(policies)) {
          const stmts = (
            p.Properties as {
              PolicyDocument?: { Statement?: Array<{ Action?: unknown }> };
            }
          ).PolicyDocument?.Statement;
          for (const stmt of stmts ?? []) {
            const actions = Array.isArray(stmt.Action)
              ? stmt.Action
              : [stmt.Action];
            expect(actions).not.toContain("s3:*");
            expect(actions).not.toContain("athena:*");
            expect(actions).not.toContain("*");
          }
        }
      });

      it("grants s3:GetBucketLocation UNCONDITIONED (Athena bucket verify)", () => {
        // Regression guard: GetBucketLocation has no s3:prefix request context,
        // so gating it with an s3:prefix condition silently voids it and Athena
        // fails StartQueryExecution with "Unable to verify/create output
        // bucket". It must be its own unconditioned statement.
        const policies = template.findResources("AWS::IAM::Policy");
        const stmts = Object.values(policies).flatMap(
          (p) =>
            (
              p.Properties as {
                PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
              }
            ).PolicyDocument?.Statement ?? [],
        );
        const gbl = stmts.find((s) => {
          const a = Array.isArray(s.Action) ? s.Action : [s.Action];
          return a.includes("s3:GetBucketLocation");
        });
        expect(gbl).toBeDefined();
        expect(gbl?.Condition).toBeUndefined();
      });

      // ---- EventBridge -----------------------------------------------
      it("creates the nightly rollup rule, enabled per env config", () => {
        template.resourceCountIs("AWS::Events::Rule", 1);
        template.hasResourceProperties("AWS::Events::Rule", {
          Name: `sps-cf-usage-rollup-${env}`,
          ScheduleExpression: "cron(0 8 * * ? *)",
          // staging usageRollupScheduleEnabled=true; prod=true (see config).
          State: "ENABLED",
        });
      });

      // ---- ASCII / descriptions --------------------------------------
      it("all descriptions + named-query names are printable ASCII (Footgun #6)", () => {
        const collect: string[] = [];
        for (const [type, key] of [
          ["AWS::Glue::Database", "DatabaseInput"],
        ] as const) {
          for (const r of Object.values(template.findResources(type))) {
            const d = (
              r.Properties as { [k: string]: { Description?: string } }
            )?.[key]?.Description;
            if (typeof d === "string") collect.push(d);
          }
        }
        for (const r of Object.values(
          template.findResources("AWS::Glue::Table"),
        )) {
          const d = (r.Properties as { TableInput?: { Description?: string } })
            ?.TableInput?.Description;
          if (typeof d === "string") collect.push(d);
        }
        for (const r of Object.values(
          template.findResources("AWS::Athena::WorkGroup"),
        )) {
          const d = (r.Properties as { Description?: string })?.Description;
          if (typeof d === "string") collect.push(d);
        }
        for (const r of Object.values(
          template.findResources("AWS::Events::Rule"),
        )) {
          const d = (r.Properties as { Description?: string })?.Description;
          if (typeof d === "string") collect.push(d);
        }
        for (const r of Object.values(
          template.findResources("AWS::Athena::NamedQuery"),
        )) {
          const n = (r.Properties as { Name?: string })?.Name;
          const d = (r.Properties as { Description?: string })?.Description;
          if (typeof n === "string") collect.push(n);
          if (typeof d === "string") collect.push(d);
        }
        expect(collect.length).toBeGreaterThan(0);
        for (const s of collect) expect(s).toMatch(PRINTABLE_ASCII);
      });
    });
  }
});
