import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import type { SpsEnvConfig } from "../lib/config";
import { EtlStack } from "../lib/etl-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

function buildEtlStack(
  envName: "staging" | "prod",
  envConfigOverride: Partial<SpsEnvConfig> = {},
): {
  template: Template;
  stack: EtlStack;
} {
  const fixture = makeFixture(envName);
  const envConfig = { ...fixture.envConfig, ...envConfigOverride };
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig,
  });
  const appStack = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig,
    vpc: network.vpc,
  });
  const stack = new EtlStack(fixture.app, `Sps-Etl-${envName}`, {
    env: fixture.env,
    envConfig,
    vpc: network.vpc,
    ecsCluster: appStack.ecsCluster,
    etlEcrRepository: appStack.etlEcrRepository,
  });
  return { template: Template.fromStack(stack), stack };
}

/**
 * Read an alarm's metric shape regardless of HOW the alarm expresses it.
 *
 * A single-metric alarm carries `MetricName`/`Statistic`/`Period` at the top
 * level. A metric-math alarm carries NONE of those: it has a `Metrics` array
 * whose entries each nest a `MetricStat`, plus one entry holding the
 * `Expression`. So an assertion written against the top-level properties does
 * not fail when an alarm is converted to an expression -- it silently matches
 * nothing and stops checking. That is a live hazard for the <=604800s
 * evaluation-window guard below, which reads `Period` and would have gone
 * blind on all six status alarms the moment they started summing
 * failed + timedOut + aborted.
 */
function alarmMetricShape(props: Record<string, unknown> | undefined): {
  names: string[];
  stats: string[];
  periods: number[];
  expression: string | undefined;
} {
  const metrics: unknown[] = Array.isArray(props?.Metrics) ? (props.Metrics as unknown[]) : [];
  if (metrics.length === 0) {
    const name = props?.MetricName;
    const stat = props?.Statistic;
    const period = props?.Period;
    return {
      names: typeof name === "string" ? [name] : [],
      stats: typeof stat === "string" ? [stat] : [],
      periods: typeof period === "number" ? [period] : [],
      expression: undefined,
    };
  }
  const entries = metrics as ReadonlyArray<{
    Expression?: unknown;
    MetricStat?: { Period?: unknown; Stat?: unknown; Metric?: { MetricName?: unknown } };
  }>;
  const stats = entries.map((m) => m.MetricStat?.Stat);
  return {
    names: entries
      .map((m) => m.MetricStat?.Metric?.MetricName)
      .filter((n): n is string => typeof n === "string")
      .sort(),
    stats: stats.filter((s): s is string => typeof s === "string"),
    periods: entries
      .map((m) => m.MetricStat?.Period)
      .filter((p): p is number => typeof p === "number"),
    expression: entries.map((m) => m.Expression).find((e): e is string => typeof e === "string"),
  };
}

/**
 * The three ways a Step Functions execution can end without succeeding.
 *
 * ExecutionsFailed alone -- what these alarms watched before -- is the only
 * one of the three that ALREADY notifies by another route (a Catch publishes
 * to etl-failures before the Fail state). TIMED_OUT runs no Catch at all, and
 * ABORTED is an operator StopExecution; both were entirely silent.
 */
const UNSUCCESSFUL_METRICS = [
  "ExecutionsAborted",
  "ExecutionsFailed",
  "ExecutionsTimedOut",
] as const;

/**
 * Every state machine in the template, vs. the ones a status alarm actually
 * watches -- both as CloudFormation logical ids, so a mismatch names the
 * offender.
 *
 * The gap this closes: three short-lived machines (curated-tables backup,
 * opportunity projection, ED email-visibility bridge) shipped with ONLY a
 * cadence alarm. A cadence alarm watches `ExecutionsStarted < 1`, and a
 * TIMED_OUT execution STARTED -- so it stays green. The machine's own Catch
 * does not run on a timeout either, so nothing publishes to etl-failures.
 * Those runs failed in complete silence. Comparing the two SETS rather than
 * asserting a count means the next short-lived machine cannot ship without a
 * status alarm: it shows up in `machines` and not in `covered`.
 *
 * The dimension value on a state-machine metric is `{ Ref: <logical id> }` --
 * Ref on AWS::StepFunctions::StateMachine returns the ARN.
 */
function statusAlarmCoverage(template: Template): {
  machines: string[];
  covered: string[];
} {
  const machines = Object.keys(
    template.findResources("AWS::StepFunctions::StateMachine"),
  ).sort();
  const covered = new Set<string>();
  for (const a of Object.values(template.findResources("AWS::CloudWatch::Alarm"))) {
    // Only the status alarms: duration and cadence alarms are single-metric and
    // legitimately watch something else.
    if (alarmMetricShape(a.Properties).expression !== "failed + timedOut + aborted") continue;
    // An alarm that notifies nobody is the same silence in a different costume,
    // so coverage requires a wired action, not merely a defined alarm.
    if (!Array.isArray(a.Properties?.AlarmActions) || a.Properties.AlarmActions.length === 0) {
      continue;
    }
    const metrics = (Array.isArray(a.Properties?.Metrics) ? a.Properties.Metrics : []) as
      ReadonlyArray<{
        MetricStat?: {
          Metric?: { Dimensions?: ReadonlyArray<{ Name?: unknown; Value?: unknown }> };
        };
      }>;
    for (const m of metrics) {
      for (const d of m.MetricStat?.Metric?.Dimensions ?? []) {
        const ref = (d.Value as { Ref?: unknown } | undefined)?.Ref;
        if (d.Name === "StateMachineArn" && typeof ref === "string") covered.add(ref);
      }
    }
  }
  return { machines, covered: [...covered].sort() };
}

// Re-asserted per Footgun #6 / feedback_ec2_descriptions_ascii_only.
// The allow-set matches the regex documented in app-stack.test.ts.
const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

// EventBridge cron expressions confirmed in plan D7.
const EXPECTED_CRONS: Readonly<Record<string, string>> = {
  nightly: "cron(0 7 * * ? *)",
  weekly: "cron(0 12 ? * SUN *)",
  annual: "cron(0 9 1 7 ? *)",
};

// #442 -- the task container injects each credentialed source's granular
// SCHOLARS_* keys (plus the three shared secrets), NOT a blob ETL_*_SECRET.
// #1508 -- grouped by the task def that injects them. The three base secrets
// ride EVERY def; each per-source group rides ONLY its own def so no step gets
// a credential it doesn't use.
const BASE_SECRET_ENV_VARS = [
  "DATABASE_URL",
  "OPENSEARCH_USER",
  "OPENSEARCH_PASS",
  // #447 -- renamed from REVALIDATE_TOKEN; etl/orchestrate.ts reads
  // SCHOLARS_REVALIDATE_TOKEN.
  "SCHOLARS_REVALIDATE_TOKEN",
] as const;
// sources def -- the five WCM-DB sources (asms/infoed/coi/reciter/jenzabar).
const SOURCES_SECRET_ENV_VARS = [
  "SCHOLARS_ASMS_HOST",
  "SCHOLARS_ASMS_PORT",
  "SCHOLARS_ASMS_DATABASE",
  "SCHOLARS_ASMS_USERNAME",
  "SCHOLARS_ASMS_PASSWORD",
  "SCHOLARS_INFOED_DB_URL",
  "SCHOLARS_INFOED_USERNAME",
  "SCHOLARS_INFOED_PASSWORD",
  "SCHOLARS_COI_URL",
  "SCHOLARS_COI_PORT",
  "SCHOLARS_COI_DATABASE",
  "SCHOLARS_COI_USERNAME",
  "SCHOLARS_COI_PASSWORD",
  "SCHOLARS_RECITERDB_HOST",
  "SCHOLARS_RECITERDB_PORT",
  "SCHOLARS_RECITERDB_DATABASE",
  "SCHOLARS_RECITERDB_USERNAME",
  "SCHOLARS_RECITERDB_PASSWORD",
  "SCHOLARS_JENZABAR_SERVER",
  "SCHOLARS_JENZABAR_PORT",
  "SCHOLARS_JENZABAR_DATABASE",
  "SCHOLARS_JENZABAR_USERNAME",
  "SCHOLARS_JENZABAR_PASSWORD",
] as const;
// ldap def -- the LDAP simple bind (only etl:ed + the ed-export bridge).
const LDAP_SECRET_ENV_VARS = [
  "SCHOLARS_LDAP_URL",
  "SCHOLARS_LDAP_BIND_DN",
  "SCHOLARS_LDAP_BIND_PASSWORD",
] as const;
// reciter-api def -- the #746 ADMIN api-key, used ONLY by the operator-run
// etl:reciter-refresh (no cadence step), kept off every other def.
const RECITER_API_SECRET_ENV_VARS = [
  "RECITER_API_BASE_URL",
  "RECITER_API_KEY",
] as const;
// Which prod task-def family carries which secret group (#1508).
const SECRETS_BY_TASK_DEF: ReadonlyArray<{
  label: string;
  family: string;
  vars: readonly string[];
}> = [
  { label: "base", family: "sps-etl-prod", vars: BASE_SECRET_ENV_VARS },
  { label: "sources", family: "sps-etl-sources-prod", vars: SOURCES_SECRET_ENV_VARS },
  { label: "ldap", family: "sps-etl-ldap-prod", vars: LDAP_SECRET_ENV_VARS },
  {
    label: "reciter-api",
    family: "sps-etl-reciter-api-prod",
    vars: RECITER_API_SECRET_ENV_VARS,
  },
];
// Every per-source var (the three non-base defs' secrets) -- none of these may
// appear on the base def's container.
const NON_BASE_SECRET_ENV_VARS = [
  ...SOURCES_SECRET_ENV_VARS,
  ...LDAP_SECRET_ENV_VARS,
  ...RECITER_API_SECRET_ENV_VARS,
];

// IAM-based sources read these as plaintext config from the environment
// block (values mirror the source-script defaults).
const EXPECTED_ENV_CONFIG: Readonly<Record<string, string>> = {
  SCHOLARS_DYNAMODB_TABLE: "reciterai",
  ARTIFACTS_BUCKET: "wcmc-reciterai-artifacts",
  ARTIFACT_PREFIX: "spotlight",
  HIERARCHY_BUCKET: "wcmc-reciterai-hierarchy",
  // #794 — A2 tools taxonomy (etl:scholar-tool) + the reversible producer switch.
  TOOLS_BUCKET: "wcmc-reciterai-artifacts",
  TOOLS_PREFIX: "tools",
  // #794 cutover complete for BOTH envs (prod signed off 2026-07-06). Asserted
  // against the prod template below; guards that prod now reads "s3" (A2 tools
  // taxonomy via etl:scholar-tool populates scholar_tool + scholar_family).
  // Rollback = "ddb".
  SCHOLAR_TOOL_SOURCE: "s3",
  // #1258 — env-conditional like SCHOLAR_TOOL_SOURCE (staging "0.9", covered by
  // the staging snapshot). Asserted against prod here to guard that the derived
  // MeSH-anchor producer stays gated off (">1" kill-switch) until sign-off.
  MESH_ANCHOR_SCORE_MIN: "2",
};

function getStateMachineDefinitionText(
  template: Template,
  stateMachineName: string,
): string {
  const sms = template.findResources("AWS::StepFunctions::StateMachine");
  const match = Object.values(sms).find(
    (r) => r.Properties?.StateMachineName === stateMachineName,
  );
  expect(match).toBeDefined();
  // DefinitionString materialises as Fn::Join over alternating literal +
  // intrinsic chunks; flatten to a single string so we can grep for tokens.
  const def = match?.Properties?.DefinitionString as
    | { "Fn::Join"?: [string, unknown[]] }
    | string
    | undefined;
  if (typeof def === "string") {
    return def;
  }
  const parts = def?.["Fn::Join"]?.[1] ?? [];
  return parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join("");
}

describe("EtlStack", () => {
  // Cutover de-coupling (§8.4): both the ETL container and the reconcile task
  // move OPENSEARCH_NODE off the Data→Etl cross-stack export onto the opensearch
  // secret's `node` key, so the OpenSearch-domain replace at cutover isn't
  // blocked by the export-lock. The internal-ALB DNS is a separate edge (SSM).
  describe("OPENSEARCH_NODE de-coupling (openSearchNodeFromSecret)", () => {
    it("off (explicit): node is baked from the DataStack export, not a secret", () => {
      const json = JSON.stringify(
        buildEtlStack("staging", { openSearchNodeFromSecret: false }).template.toJSON(),
      );
      expect(json).toContain("Sps-Data-staging-OpenSearchDomainEndpoint");
      expect(json).not.toContain(":node::");
    });

    it("on: node comes from the opensearch secret `node` key; the OpenSearch export is gone but SCHOLARS_BASE_URL still resolves", () => {
      const json = JSON.stringify(
        buildEtlStack("staging", { openSearchNodeFromSecret: true }).template.toJSON(),
      );
      expect(json).not.toContain("Sps-Data-staging-OpenSearchDomainEndpoint");
      expect(json).toContain(":node::");
      // SCHOLARS_BASE_URL rides the App internal-ALB DNS SSM param (item-3 pass 2b),
      // a separate edge unaffected by openSearchNodeFromSecret.
      expect(json).toContain("/sps/staging/app/internal-alb-dns");
    });
  });

  // Estate consolidation (plan §4.4): with useSharedVpc on, every ETL task ENI
  // lands in the app2 subnets (the cross-VPC relocation branch is gone — §8.8).
  describe("shared VPC placement (useSharedVpc on)", () => {
    const { template } = buildEtlStack("staging", { useSharedVpc: true });
    const APP2 = ["subnet-0c6593fb9c9a165c3", "subnet-070cbc242efbddc3c"];

    it("routes ETL task ENIs into the app2 subnets", () => {
      const sms = Object.values(
        template.findResources("AWS::StepFunctions::StateMachine"),
      );
      const allDefs = sms
        .map((s) => JSON.stringify(s.Properties?.DefinitionString ?? ""))
        .join("");
      for (const subnet of APP2) expect(allDefs).toContain(subnet);
    });
  });

  describe("prod", () => {
    const { template } = buildEtlStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    describe("Resource counts (B08 / B20 acceptance)", () => {
      it("creates six state machines (3 cadence + #595 heartbeat + #393 reconciler + #353 cdn reconciler), six EventBridge rules, two SNS topics", () => {
        // 3 cadence machines + the #595 heartbeat + the #393 reconciler +
        // the #353 cdn reconciler (PR-2).
        template.resourceCountIs("AWS::StepFunctions::StateMachine", 6);
        template.resourceCountIs("AWS::Events::Rule", 6);
        // The heartbeat + both reconcilers reuse the cadence failure topic; PR-7
        // adds the etl-page P1 topic, so two total: etl-failures + etl-page.
        template.resourceCountIs("AWS::SNS::Topic", 2);
        template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "etl-failures-prod" });
        template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "etl-page-prod" });
      });

      it("creates fourteen CloudWatch alarms (4 status + 3 cadence + 3 duration + reconciler status/cadence + cdn reconciler status/cadence)", () => {
        // 10 cadence-machine alarms (4 status + 3 cadence: nightly/weekly/heartbeat
        // + 3 duration: nightly/weekly/heartbeat, #2190 -- annual is excluded, its
        // ExecutionTime is approval-gate wait) + 2 reconciler alarms (#393)
        // + 2 cdn reconciler alarms (#353).
        template.resourceCountIs("AWS::CloudWatch::Alarm", 14);
      });

      it("creates six ECS task definitions (4 ETL credential-split defs + lean reconciler + lean cdn reconciler) and one SG-to-SG ingress rule on the internal ALB SG", () => {
        // #1508 split the single ETL task def into four by credential need:
        // base / sources / ldap / reciter-api. Plus the lean #393 reconcile
        // task def + the lean #353 cdn reconcile task def.
        template.resourceCountIs("AWS::ECS::TaskDefinition", 6);
        template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 1);
      });

      it("the SG-to-SG ingress admits :80 from the ETL SG (no CIDR)", () => {
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        expect(Object.keys(ingress)).toHaveLength(1);
        const rule = Object.values(ingress)[0];
        expect(rule.Properties?.IpProtocol).toBe("tcp");
        expect(rule.Properties?.FromPort).toBe(80);
        expect(rule.Properties?.ToPort).toBe(80);
        expect(rule.Properties?.CidrIp).toBeUndefined();
        expect(rule.Properties?.SourceSecurityGroupId).toBeDefined();
      });

      it("prod does NOT create the curated-tables backup schedule (curationBackupScheduleEnabled=false until prod is activated; #1032)", () => {
        const rules = template.findResources("AWS::Events::Rule");
        expect(
          Object.values(rules).some(
            (r) => r.Properties?.Name === "sps-curation-backup-prod",
          ),
        ).toBe(false);
        const sms = template.findResources("AWS::StepFunctions::StateMachine");
        expect(
          Object.values(sms).some(
            (s) =>
              s.Properties?.StateMachineName === "scholars-curation-backup-prod",
          ),
        ).toBe(false);
      });

      it("prod does NOT create the opportunity-projection schedule (opportunityProjectionScheduleEnabled=false until the prod corpus is published; #1218)", () => {
        const rules = template.findResources("AWS::Events::Rule");
        expect(
          Object.values(rules).some(
            (r) => r.Properties?.Name === "sps-opportunity-projection-prod",
          ),
        ).toBe(false);
        const sms = template.findResources("AWS::StepFunctions::StateMachine");
        expect(
          Object.values(sms).some(
            (s) =>
              s.Properties?.StateMachineName === "scholars-opportunity-projection-prod",
          ),
        ).toBe(false);
      });

      it("prod does NOT create the ED email-visibility bridge (edEmailVisibilityBridgeEnabled=false until scholars-prod is verified; #443)", () => {
        const rules = template.findResources("AWS::Events::Rule");
        expect(
          Object.values(rules).some(
            (r) => r.Properties?.Name === "sps-ed-email-visibility-prod",
          ),
        ).toBe(false);
        const sms = template.findResources("AWS::StepFunctions::StateMachine");
        expect(
          Object.values(sms).some(
            (s) =>
              s.Properties?.StateMachineName ===
              "scholars-ed-email-visibility-prod",
          ),
        ).toBe(false);
        // No imported-VPC export SG leaks into prod.
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        expect(
          Object.values(sgs).some((s) =>
            String(s.Properties?.GroupDescription ?? "").includes(
              "ED email-visibility export",
            ),
          ),
        ).toBe(false);
        // The ed/* GetObject grant (the import-side read) already exists in
        // prod; assert the WRITE half -- s3:PutObject on ed/* -- does NOT, since
        // the export is not created here.
        const policies = template.findResources("AWS::IAM::Policy");
        const hasEdPut = Object.values(policies).some((p) => {
          const stmts =
            (p.Properties?.PolicyDocument?.Statement as
              | Array<{ Action?: unknown; Resource?: unknown }>
              | undefined) ?? [];
          return stmts.some((s) => {
            const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
            const act = Array.isArray(s.Action) ? s.Action : [s.Action];
            return (
              res.includes("arn:aws:s3:::wcmc-reciterai-artifacts/ed/*") &&
              act.includes("s3:PutObject")
            );
          });
        });
        expect(hasEdPut).toBe(false);
      });
    });

    describe("State machines (D2 -- Choice on $.startFrom)", () => {
      it.each(Object.keys(EXPECTED_CRONS))(
        "%s state-machine definition routes on $.startFrom",
        (cadence) => {
          const text = getStateMachineDefinitionText(
            template,
            `scholars-${cadence}-prod`,
          );
          expect(text).toMatch(/startFrom/);
        },
      );

      // Regression: the EventBridge schedules invoke with `{}` (no startFrom).
      // Without an isPresent guard the top-level Choice raises
      // `States.Runtime: Invalid path '$.startFrom'` and every scheduled
      // execution fails before the first step. Assert the value test is
      // guarded so an absent key falls through to step[0] instead of erroring.
      it.each(Object.keys(EXPECTED_CRONS))(
        "%s Choice guards $.startFrom with isPresent (empty {} schedule input falls through, never errors)",
        (cadence) => {
          const text = getStateMachineDefinitionText(
            template,
            `scholars-${cadence}-prod`,
          );
          // The guarded branch synthesises as an And pairing IsPresent with
          // StringEquals on the same $.startFrom path.
          expect(text).toMatch(/"IsPresent":\s*true/);
          expect(text).toMatch(/"And":/);
          expect(text).toMatch(/"Variable":\s*"\$\.startFrom"/);
        },
      );

      it.each(Object.keys(EXPECTED_CRONS))(
        "%s state machine has per-step retry (MaxAttempts=2, BackoffRate=2)",
        (cadence) => {
          const text = getStateMachineDefinitionText(
            template,
            `scholars-${cadence}-prod`,
          );
          // Both numbers should appear in every Retry block.
          expect(text).toMatch(/"MaxAttempts":\s*2/);
          expect(text).toMatch(/"BackoffRate":\s*2/);
        },
      );

      it.each(Object.keys(EXPECTED_CRONS))(
        "%s state machine has Catch blocks (failure paths publish to SNS)",
        (cadence) => {
          const text = getStateMachineDefinitionText(
            template,
            `scholars-${cadence}-prod`,
          );
          expect(text).toMatch(/"Catch"/);
          // Per-step failure handler is an SNS publish task. CDK
          // synthesizes the ARN as arn:{Partition}:states:::sns:publish
          // (Fn::Join over AWS::Partition); match the partition-agnostic
          // tail.
          expect(text).toMatch(/states:::sns:publish/);
        },
      );

      it("annual state machine has a waitForTaskToken approval gate", () => {
        const text = getStateMachineDefinitionText(
          template,
          "scholars-annual-prod",
        );
        expect(text).toMatch(/states:::sns:publish\.waitForTaskToken/);
      });

      // #451 -- the cadence steps once labelled "SearchIndex"/"Revalidate"
      // ran etl:mesh-coverage / etl:vivo-redirect, so the OpenSearch index
      // was never rebuilt by any machine and vivo-redirect (a manual
      // cutover-prep file generator) ran as a no-op Fargate task. Lock in
      // the corrected command overrides.
      describe("#451 -- cadences run search:index, never vivo-redirect", () => {
        it("nightly rebuilds the index (search:index) and keeps mesh-coverage", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-nightly-prod",
          );
          expect(text).toMatch(/"search:index"/);
          expect(text).toMatch(/"etl:mesh-coverage"/);
        });

        it("weekly rebuilds the index (search:index); mesh-coverage dropped (nightly-only)", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          expect(text).toMatch(/"search:index"/);
          expect(text).not.toMatch(/"etl:mesh-coverage"/);
        });

        it.each(["nightly", "weekly"])(
          "%s machine no longer wires the vivo-redirect cutover tool",
          (cadence) => {
            const text = getStateMachineDefinitionText(
              template,
              `scholars-${cadence}-prod`,
            );
            expect(text).not.toMatch(/vivo-redirect/);
          },
        );
      });

      describe("#479 -- cadences POST /api/revalidate after search:index", () => {
        it.each(["nightly", "weekly"])(
          "%s machine closes with `etl:revalidate` after `search:index`",
          (cadence) => {
            const text = getStateMachineDefinitionText(
              template,
              `scholars-${cadence}-prod`,
            );
            expect(text).toMatch(/"etl:revalidate"/);
            const lastSearchIndex = text.lastIndexOf("search:index");
            const lastRevalidate = text.lastIndexOf("etl:revalidate");
            expect(lastSearchIndex).toBeGreaterThan(-1);
            expect(lastRevalidate).toBeGreaterThan(lastSearchIndex);
          },
        );
      });

      // #608 -- RePORTER / NSF are wired onto the WEEKLY machine ahead of its
      // closing search:index/revalidate tail. Jenzabar moved to the NIGHTLY
      // machine (operator request) so grad-school mentoring chips refresh daily.
      describe("#608 -- weekly runs RePORTER/NSF; Jenzabar runs nightly", () => {
        it("weekly runs etl:reporter and etl:nsf", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          expect(text).toMatch(/"etl:reporter"/);
          expect(text).toMatch(/"etl:nsf"/);
        });

        it("RePORTER + NSF precede the weekly search:index (funding index carries the refreshed abstracts/keywords)", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          const idxSearch = text.indexOf("search:index");
          expect(idxSearch).toBeGreaterThan(-1);
          expect(text.indexOf("etl:reporter")).toBeGreaterThan(-1);
          expect(text.indexOf("etl:reporter")).toBeLessThan(idxSearch);
          expect(text.indexOf("etl:nsf")).toBeLessThan(idxSearch);
        });

        it("Jenzabar runs on the nightly machine, not the weekly one", () => {
          const nightly = getStateMachineDefinitionText(
            template,
            "scholars-nightly-prod",
          );
          const weekly = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          expect(nightly).toMatch(/"etl:jenzabar"/);
          expect(weekly).not.toMatch(/"etl:jenzabar"/);
        });

        it("RePORTER + NSF do not leak onto the nightly machine", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-nightly-prod",
          );
          expect(text).not.toMatch(/"etl:reporter"/);
          expect(text).not.toMatch(/"etl:nsf"/);
        });
      });

      // #658 -- gates + nih-profile complete the grant/PI enrichment set on the
      // weekly machine. Both read public sources (no credential), external: false.
      describe("#658 -- weekly machine runs gates + nih-profile", () => {
        it("weekly runs etl:gates and etl:nih-profile", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          expect(text).toMatch(/"etl:gates"/);
          expect(text).toMatch(/"etl:nih-profile"/);
        });

        it("Gates abstracts precede the weekly search:index", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-weekly-prod",
          );
          const idxSearch = text.indexOf("search:index");
          expect(idxSearch).toBeGreaterThan(-1);
          expect(text.indexOf("etl:gates")).toBeGreaterThan(-1);
          expect(text.indexOf("etl:gates")).toBeLessThan(idxSearch);
        });

        it("gates + nih-profile do not leak onto the nightly machine", () => {
          const text = getStateMachineDefinitionText(
            template,
            "scholars-nightly-prod",
          );
          expect(text).not.toMatch(/"etl:gates"/);
          expect(text).not.toMatch(/"etl:nih-profile"/);
        });
      });
    });

    describe("EventBridge schedules (D7)", () => {
      it.each(Object.entries(EXPECTED_CRONS))(
        "%s rule uses cron expression %s",
        (cadence, expression) => {
          template.hasResourceProperties("AWS::Events::Rule", {
            Name: `sps-etl-${cadence}-prod`,
            ScheduleExpression: expression,
          });
        },
      );

      it("prod CADENCE schedules ship ENABLED (etlSchedulesEnabled=true)", () => {
        const rules = template.findResources("AWS::Events::Rule");
        // The #393 reconciler runs on its own flag (reconcileScheduleEnabled),
        // enabled in prod -- so scope this to the four sps-etl-* rules
        // (3 cadence + the #595 heartbeat), all gated on etlSchedulesEnabled.
        const cadenceRules = Object.entries(rules).filter(([, rule]) => {
          const name = rule.Properties?.Name as string | undefined;
          return typeof name === "string" && name.startsWith("sps-etl-");
        });
        expect(cadenceRules).toHaveLength(4);
        for (const [id, rule] of cadenceRules) {
          const state = rule.Properties?.State as string | undefined;
          // Prod cadences went live 2026-07-07. This asserts the TEMPLATE says so
          // too: while it said DISABLED, the first deploy whose changeset touched
          // these rules would have silently switched the prod ETL off (#1512).
          expect({ id, state }).toEqual({ id, state: "ENABLED" });
        }
      });

      it("the #393 reconciler schedule ships ENABLED in prod (continuous backstop, not runbook-gated)", () => {
        template.hasResourceProperties("AWS::Events::Rule", {
          Name: "sps-reconcile-prod",
          ScheduleExpression: "rate(5 minutes)",
          State: "ENABLED",
        });
      });
    });

    describe("Alarms (D4 -- ExecutionsFailed sum>0 + ExecutionsStarted sum<1)", () => {
      it("every alarm publishes to the etl-failures-${env} SNS topic", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        // 10 cadence-machine alarms (4 status + 3 cadence + 3 duration, #2190)
        // + 2 reconciler alarms (#393) + 2 cdn reconciler alarms (#353); all
        // share the topic -- a duration alarm that routed elsewhere would be
        // invisible, so it is covered by the same loop below.
        expect(Object.keys(alarms)).toHaveLength(14);
        for (const [id, alarm] of Object.entries(alarms)) {
          const actions = (alarm.Properties?.AlarmActions ?? []) as unknown[];
          expect({ id, hasAction: actions.length > 0 }).toEqual({
            id,
            hasAction: true,
          });
        }
      });

      // The test ABOVE asserts an alarm has an action. That is not the same as
      // the action being deliverable, and the difference was a real prod outage:
      // `grantPublish` materializes an explicit AWS::SNS::TopicPolicy which
      // REPLACES SNS's implicit default policy, so granting only `states` revoked
      // CloudWatch's ability to publish. Every alarm still had an action and
      // every send returned "Failed to execute action" — 30 alarms mute, six real
      // prod transitions dropped 07-13..08-04, and `hasAction: true` stayed green
      // throughout. Assert the principal, not the wiring.
      it("both alarm topics let cloudwatch.amazonaws.com publish, or every alarm action fails", () => {
        const policies = template.findResources("AWS::SNS::TopicPolicy");
        expect(Object.keys(policies).length).toBeGreaterThan(0);

        const principalsOf = (policy: Record<string, unknown>): string[] => {
          const doc = (policy.Properties as Record<string, unknown> | undefined)
            ?.PolicyDocument as { Statement?: unknown[] } | undefined;
          return (doc?.Statement ?? []).flatMap((raw) => {
            const st = raw as { Principal?: { Service?: unknown } };
            const svc = st.Principal?.Service;
            return typeof svc === "string" ? [svc] : Array.isArray(svc) ? (svc as string[]) : [];
          });
        };

        for (const [id, policy] of Object.entries(policies)) {
          const services = principalsOf(policy as Record<string, unknown>);
          expect({ id, cloudwatch: services.includes("cloudwatch.amazonaws.com") }).toEqual({
            id,
            cloudwatch: true,
          });
          // states must survive the fix — it is what publishes step-failure
          // notifications from the state machines themselves.
          expect({ id, states: services.includes("states.amazonaws.com") }).toEqual({
            id,
            states: true,
          });
        }
      });

      it("cadence status alarms watch failed + timed-out + aborted, sum > 0", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        // Scope to the cadence machines (sps-etl-*); the #393 reconciler's
        // status alarm has its own focused test below.
        const statusAlarms = Object.entries(alarms).filter(([, a]) => {
          const name = a.Properties?.AlarmName as string | undefined;
          return (
            typeof name === "string" &&
            name.startsWith("sps-etl-") &&
            name.includes("-status-")
          );
        });
        expect(statusAlarms).toHaveLength(4);
        for (const [, a] of statusAlarms) {
          const shape = alarmMetricShape(a.Properties);
          // Dropping any one of the three re-opens a silent terminal state:
          // a machine that hits its own `timeout:` is killed as TIMED_OUT
          // with no Catch and no SNS publish, so ExecutionsFailed stays 0 and
          // the run disappears entirely.
          expect({
            alarm: a.Properties?.AlarmName as string,
            watches: shape.names,
          }).toEqual({
            alarm: a.Properties?.AlarmName as string,
            watches: [...UNSUCCESSFUL_METRICS],
          });
          expect(shape.expression).toBe("failed + timedOut + aborted");
          expect(shape.stats).toEqual(["Sum", "Sum", "Sum"]);
          expect(a.Properties?.ComparisonOperator).toBe(
            "GreaterThanThreshold",
          );
          expect(a.Properties?.Threshold).toBe(0);
        }
      });

      it("cadence alarms watch ExecutionsStarted sum < 1 with treatMissingData=breaching (nightly + weekly + heartbeat)", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        // Scope to the cadence machines (sps-etl-*); the #393 reconciler's
        // cadence alarm has its own focused test below.
        const cadenceAlarms = Object.entries(alarms).filter(([, a]) => {
          const name = a.Properties?.AlarmName as string | undefined;
          return (
            typeof name === "string" &&
            name.startsWith("sps-etl-") &&
            name.includes("-cadence-")
          );
        });
        // Annual has no cadence alarm -- CloudWatch can't express a yearly
        // no-execution window (see EtlStack alarm note + the guard below).
        // Nightly + weekly + the #595 daily heartbeat each get one.
        expect(cadenceAlarms).toHaveLength(3);
        const labels = cadenceAlarms
          .map(([, a]) => a.Properties?.AlarmName as string)
          .sort();
        expect(labels).toEqual([
          "sps-etl-heartbeat-cadence-prod",
          "sps-etl-nightly-cadence-prod",
          "sps-etl-weekly-cadence-prod",
        ]);
        for (const [, a] of cadenceAlarms) {
          expect(a.Properties?.MetricName).toBe("ExecutionsStarted");
          expect(a.Properties?.Statistic).toBe("Sum");
          expect(a.Properties?.ComparisonOperator).toBe("LessThanThreshold");
          expect(a.Properties?.Threshold).toBe(1);
          expect(a.Properties?.TreatMissingData).toBe("breaching");
        }
      });

      // Synth-time guard for the CloudWatch deploy-only constraint that
      // rolled staging back: for any alarm whose Period >= 3600s,
      // EvaluationPeriods * Period must be <= 604800s (one week). cdk synth
      // and snapshots don't enforce this -- only the CFN create does.
      it("no alarm violates the CloudWatch <=604800s evaluation-window cap (period>=3600)", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        const violations: string[] = [];
        for (const [id, a] of Object.entries(alarms)) {
          const evals = a.Properties?.EvaluationPeriods as number | undefined;
          // Every period the alarm actually evaluates on -- top-level for a
          // single-metric alarm, per-MetricStat for a metric-math one. Reading
          // only `Properties.Period` would skip all six status alarms, which
          // includes the heartbeat's 86400s one, and this guard exists because
          // a violation rolled staging back once.
          for (const period of new Set(alarmMetricShape(a.Properties).periods)) {
            if (period < 3600) continue;
            const window = period * (evals ?? 1);
            if (window > 604800) {
              violations.push(
                `${id}: ${a.Properties?.AlarmName} -- ${evals ?? 1} * ${period}s = ${window}s > 604800s`,
              );
            }
          }
        }
        expect(violations).toEqual([]);
      });

      // One shared description served all four cadences, and on the heartbeat
      // every clause of it misled: the heartbeat is a SINGLE-step machine so
      // "find the step marked red" points at the only step; it goes red because
      // a data source is past its SLA, not because a run failed to finish; and
      // "started by hand" invites re-running a check that will report exactly
      // the same thing. It is also the status alarm most likely to fire first.
      it("the heartbeat status alarm does not reuse the cadence machines' description", () => {
        const descriptionOf = (name: string): string =>
          String(
            Object.values(template.findResources("AWS::CloudWatch::Alarm")).find(
              (a) => a.Properties?.AlarmName === name,
            )?.Properties?.AlarmDescription ?? "",
          );
        const nightly = descriptionOf("sps-etl-nightly-status-prod");
        const heartbeat = descriptionOf("sps-etl-heartbeat-status-prod");
        // Non-vacuity: the shared string is still in use where it reads well.
        expect(nightly).toMatch(/find the step marked red/);
        expect(heartbeat).not.toBe(nightly);
        expect(heartbeat).not.toMatch(/find the step marked red/);
        expect(heartbeat).not.toMatch(/started by hand/);
        // ...and says what is actually wrong, plus where to read the detail.
        expect(heartbeat).toMatch(/have not refreshed within their deadline/);
        expect(heartbeat).toMatch(/\[freshness\] FAIL/);
      });

      // No state machine may ship with only a cadence alarm: a TIMED_OUT run
      // STARTED, so ExecutionsStarted stays >= 1 and the cadence alarm never
      // fires, while the timeout skips the Catch so nothing publishes either.
      it("every state machine is watched by a failed+timedOut+aborted status alarm", () => {
        const { machines, covered } = statusAlarmCoverage(template);
        expect(machines.length).toBeGreaterThan(0);
        expect(covered).toEqual(machines);
      });

      // The guard above is only as good as its reach. If a future change
      // converts an alarm to a shape neither branch of alarmMetricShape
      // understands, the loop reads zero periods and passes vacuously.
      it("the <=604800s guard can read a period for every alarm", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        const unreadable = Object.entries(alarms)
          .filter(([, a]) => alarmMetricShape(a.Properties).periods.length === 0)
          .map(([id, a]) => `${id}: ${a.Properties?.AlarmName}`);
        expect(unreadable).toEqual([]);
      });
    });

    describe("#393 reconciler (PR-2 -- schedule + lean task + alarms)", () => {
      it("fires the reconciler on a rate(5 minutes) EventBridge rule", () => {
        template.hasResourceProperties("AWS::Events::Rule", {
          Name: "sps-reconcile-prod",
          ScheduleExpression: "rate(5 minutes)",
        });
      });

      it("the reconcile state machine runs `npm run search:reconcile`", () => {
        const text = getStateMachineDefinitionText(
          template,
          "scholars-reconcile-prod",
        );
        expect(text).toMatch(/"search:reconcile"/);
        // Single-step machine: no $.startFrom Choice, no cadence steps.
        expect(text).not.toMatch(/"etl:ed"/);
        expect(text).not.toMatch(/search:index/);
      });

      function reconcileTaskDef() {
        const tds = template.findResources("AWS::ECS::TaskDefinition");
        const td = Object.values(tds).find(
          (t) => t.Properties?.Family === "sps-reconcile-prod",
        );
        expect(td).toBeDefined();
        return td!;
      }

      it("uses a lean 256/512 task def (not the 8 GB ETL task def)", () => {
        const td = reconcileTaskDef();
        expect(td.Properties?.Cpu).toBe("256");
        expect(td.Properties?.Memory).toBe("512");
      });

      it("injects exactly the four secrets the worker reads (incl OPENSEARCH_NODE from secret), and no SCHOLARS_* / ETL_*_SECRET", () => {
        const td = reconcileTaskDef();
        const container = (
          td.Properties?.ContainerDefinitions as
            | Array<Record<string, unknown>>
            | undefined
        )?.find((c) => c.Name === "reconcile");
        expect(container).toBeDefined();
        const secretNames = (
          container?.Secrets as Array<{ Name?: string }> | undefined
        )?.map((s) => s.Name);
        expect((secretNames ?? []).sort()).toEqual([
          "DATABASE_URL",
          "OPENSEARCH_NODE",
          "OPENSEARCH_PASS",
          "OPENSEARCH_USER",
        ]);
        // No per-source ETL credentials leak onto the reconcile task.
        const leaked = (secretNames ?? []).filter(
          (n) => /^SCHOLARS_/.test(n ?? "") || /^ETL_.*_SECRET$/.test(n ?? ""),
        );
        expect(leaked).toEqual([]);
        // Cutover (openSearchNodeFromSecret on): OPENSEARCH_NODE rides in the
        // Secrets block (opensearch/etl `node` key), not the plaintext env.
        const envNames = (
          container?.Environment as Array<{ Name?: string }> | undefined
        )?.map((e) => e.Name);
        expect(envNames ?? []).not.toContain("OPENSEARCH_NODE");
      });

      it("the reconcile exec role lists exactly the 2 consumer ARNs (db/etl + opensearch/etl; no *)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              // Exclude the #353 CdnReconcileTaskExecutionRole, whose Ref also
              // contains the "ReconcileTaskExecutionRole" substring.
              !r.Ref.includes("CdnReconcile") &&
              r.Ref.includes("ReconcileTaskExecutionRole"),
          );
        });
        expect(execPolicy).toBeDefined();
        const statements = execPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const secretsStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("secretsmanager:GetSecretValue")
            : action === "secretsmanager:GetSecretValue";
        });
        expect(secretsStmt).toBeDefined();
        const resourceList = Array.isArray(secretsStmt?.Resource)
          ? (secretsStmt?.Resource as unknown[])
          : [secretsStmt?.Resource];
        expect(resourceList).toHaveLength(2);
        for (const r of resourceList) {
          expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
        }
      });

      it("the reconcile task role has zero secretsmanager:* actions", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const taskRolePolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              // Exclude the #353 CdnReconcileTaskRole, whose Ref also contains
              // the "ReconcileTaskRole" substring.
              !r.Ref.includes("CdnReconcile") &&
              r.Ref.includes("ReconcileTaskRole") &&
              !r.Ref.includes("ReconcileTaskExecutionRole"),
          );
        });
        if (taskRolePolicy !== undefined) {
          const serialized = JSON.stringify(
            taskRolePolicy.Properties?.PolicyDocument,
          );
          expect(serialized).not.toMatch(/secretsmanager:/);
        }
      });

      it("the status alarm watches failed + timed-out + aborted sum > 0 (idle window not breaching)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-reconcile-status-prod",
          ComparisonOperator: "GreaterThanThreshold",
          Threshold: 0,
          TreatMissingData: "notBreaching",
        });
        // The timeout arm matters most on THIS machine: its per-task retry
        // budget (3 attempts x 14 min + backoff) outlives the 15 min machine
        // timeout, so a hung run is killed as TIMED_OUT mid-retry -- no Catch,
        // no SNS publish, and ExecutionsFailed never moves.
        const alarm = Object.values(template.findResources("AWS::CloudWatch::Alarm")).find(
          (a) => a.Properties?.AlarmName === "sps-reconcile-status-prod",
        );
        const shape = alarmMetricShape(alarm?.Properties);
        expect(shape.names).toEqual([...UNSUCCESSFUL_METRICS]);
        expect(shape.stats).toEqual(["Sum", "Sum", "Sum"]);
        expect(shape.periods).toEqual([900, 900, 900]);
      });

      it("the cadence alarm watches ExecutionsStarted sum < 1 with treatMissingData=breaching (silent schedule death)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-reconcile-cadence-prod",
          MetricName: "ExecutionsStarted",
          Statistic: "Sum",
          ComparisonOperator: "LessThanThreshold",
          Threshold: 1,
          TreatMissingData: "breaching",
          Period: 900,
        });
      });
    });

    describe("#353 cdn reconciler (PR-2 -- schedule + lean task + alarms)", () => {
      it("fires the cdn reconciler on a rate(5 minutes) EventBridge rule, ENABLED in prod (continuous backstop, not runbook-gated)", () => {
        template.hasResourceProperties("AWS::Events::Rule", {
          Name: "sps-cdn-reconcile-prod",
          ScheduleExpression: "rate(5 minutes)",
          State: "ENABLED",
        });
      });

      it("the cdn reconcile state machine runs `npm run cdn:reconcile` (single-step, no cadence/search steps)", () => {
        const text = getStateMachineDefinitionText(
          template,
          "scholars-cdn-reconcile-prod",
        );
        expect(text).toMatch(/"cdn:reconcile"/);
        // Single-step machine: no $.startFrom Choice, no cadence/search steps.
        expect(text).not.toMatch(/"etl:ed"/);
        expect(text).not.toMatch(/search:index/);
        expect(text).not.toMatch(/"search:reconcile"/);
      });

      function cdnReconcileTaskDef() {
        const tds = template.findResources("AWS::ECS::TaskDefinition");
        const td = Object.values(tds).find(
          (t) => t.Properties?.Family === "sps-cdn-reconcile-prod",
        );
        expect(td).toBeDefined();
        return td!;
      }

      it("uses a lean 256/512 task def (not the 8 GB ETL task def)", () => {
        const td = cdnReconcileTaskDef();
        expect(td.Properties?.Cpu).toBe("256");
        expect(td.Properties?.Memory).toBe("512");
      });

      it("injects ONLY the DATABASE_URL secret (no OPENSEARCH_*, no SCHOLARS_*) and omits SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID (dormant-safe)", () => {
        const td = cdnReconcileTaskDef();
        const container = (
          td.Properties?.ContainerDefinitions as
            | Array<Record<string, unknown>>
            | undefined
        )?.find((c) => c.Name === "cdn-reconcile");
        expect(container).toBeDefined();
        const secretNames = (
          container?.Secrets as Array<{ Name?: string }> | undefined
        )?.map((s) => s.Name);
        // The cdn worker reads only DATABASE_URL -- never OpenSearch.
        expect((secretNames ?? []).sort()).toEqual(["DATABASE_URL"]);
        // No per-source ETL credentials, and no OpenSearch creds leak on.
        const leaked = (secretNames ?? []).filter(
          (n) =>
            /^SCHOLARS_/.test(n ?? "") ||
            /^ETL_.*_SECRET$/.test(n ?? "") ||
            /^OPENSEARCH_/.test(n ?? ""),
        );
        expect(leaked).toEqual([]);
        // Dormant-safe: no distribution id is hardcoded onto the task; the
        // worker no-ops until the operator supplies it at enable time.
        const envNames = (
          container?.Environment as Array<{ Name?: string }> | undefined
        )?.map((e) => e.Name);
        expect(envNames ?? []).not.toContain(
          "SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID",
        );
        // No OpenSearch endpoint either.
        expect(envNames ?? []).not.toContain("OPENSEARCH_NODE");
      });

      it("the cdn reconcile exec role lists EXACTLY ONE secret ARN (db/etl; no opensearch, no *)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("CdnReconcileTaskExecutionRole"),
          );
        });
        expect(execPolicy).toBeDefined();
        const statements = execPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const secretsStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("secretsmanager:GetSecretValue")
            : action === "secretsmanager:GetSecretValue";
        });
        expect(secretsStmt).toBeDefined();
        const resourceList = Array.isArray(secretsStmt?.Resource)
          ? (secretsStmt?.Resource as unknown[])
          : [secretsStmt?.Resource];
        // Exactly one ARN (db/etl) -- tighter than #393's two.
        expect(resourceList).toHaveLength(1);
        for (const r of resourceList) {
          expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
        }
      });

      it("the cdn reconcile TASK role grants cloudfront:CreateInvalidation scoped to a distribution ARN (NOT *), and zero secretsmanager", () => {
        // Synth-time guard for the deploy-only grant: this is the one permission
        // #393 lacked. CreateInvalidation only, distribution-scoped, never *.
        const policies = template.findResources("AWS::IAM::Policy");
        const taskRolePolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("CdnReconcileTaskRole") &&
              !r.Ref.includes("CdnReconcileTaskExecutionRole"),
          );
        });
        expect(taskRolePolicy).toBeDefined();
        const statements = taskRolePolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        expect(statements).toHaveLength(1);
        const stmt = statements![0];
        expect(stmt.Action).toBe("cloudfront:CreateInvalidation");
        const resource = stmt.Resource as string;
        expect(JSON.stringify(resource)).not.toMatch(/^"\*"$/);
        expect(JSON.stringify(resource)).toContain(":distribution/");
        // The runtime identity carries no secret-reading grant.
        const serialized = JSON.stringify(taskRolePolicy?.Properties?.PolicyDocument);
        expect(serialized).not.toMatch(/secretsmanager:/);
      });

      it("the status alarm watches failed + timed-out + aborted sum > 0 (idle window not breaching)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-cdn-reconcile-status-prod",
          ComparisonOperator: "GreaterThanThreshold",
          Threshold: 0,
          TreatMissingData: "notBreaching",
        });
        // Same retry-budget-outlives-machine-timeout shape as the #393
        // reconciler above: 3 x 14 min of attempts under a 15 min cap.
        const alarm = Object.values(template.findResources("AWS::CloudWatch::Alarm")).find(
          (a) => a.Properties?.AlarmName === "sps-cdn-reconcile-status-prod",
        );
        const shape = alarmMetricShape(alarm?.Properties);
        expect(shape.names).toEqual([...UNSUCCESSFUL_METRICS]);
        expect(shape.stats).toEqual(["Sum", "Sum", "Sum"]);
        expect(shape.periods).toEqual([900, 900, 900]);
      });

      it("the cadence alarm watches ExecutionsStarted sum < 1 with treatMissingData=breaching (silent schedule death)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-cdn-reconcile-cadence-prod",
          MetricName: "ExecutionsStarted",
          Statistic: "Sum",
          ComparisonOperator: "LessThanThreshold",
          Threshold: 1,
          TreatMissingData: "breaching",
          Period: 900,
        });
      });
    });

    describe("IAM least-privilege guards", () => {
      // #1508 -- return the GetSecretValue Resource list on the exec role whose
      // logical id contains `refSubstring` (its inline default policy).
      function execRoleSecretArns(refSubstring: string): unknown[] {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) => typeof r.Ref === "string" && r.Ref.includes(refSubstring),
          );
        });
        expect(execPolicy).toBeDefined();
        const statements = execPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const secretsStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("secretsmanager:GetSecretValue")
            : action === "secretsmanager:GetSecretValue";
        });
        expect(secretsStmt).toBeDefined();
        return Array.isArray(secretsStmt?.Resource)
          ? (secretsStmt?.Resource as unknown[])
          : [secretsStmt?.Resource];
      }

      it("the BASE ETL exec role lists the 3 base secret ARNs + the app-ro probe DSN -- never a per-source cred, never * (#1508)", () => {
        // The dynamodb/spotlight/hierarchy sources are IAM-based (task role) and
        // read no injected secret. After the #1508 split the base role no longer
        // reads ANY of the 7 per-source secrets -- that is the whole point. The
        // one addition is the SELECT-only app-ro DSN (DATABASE_URL_RO) injected
        // into the main sps-etl def for run-staging-probe.sh -- a DB DSN, not a
        // per-source WCM credential.
        const arns = execRoleSecretArns("EtlTaskExecutionRole");
        expect(arns).toHaveLength(4);
        for (const r of arns) {
          expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
        }
        const joined = JSON.stringify(arns);
        expect(joined).toMatch(/db\/app-ro/);
        // Still no per-source WCM-DB credential on the base role.
        expect(joined).not.toMatch(/asms|infoed|coi|jenzabar/i);
      });

      it.each([
        // base(3) + group; sources = 5 WCM-DB secrets, ldap/reciter-api = 1 each.
        ["EtlSourcesTaskExecutionRole", 8],
        ["EtlLdapTaskExecutionRole", 4],
        ["EtlReciterApiTaskExecutionRole", 4],
      ] as const)(
        "the %s scopes GetSecretValue to base + its group (%i ARNs, no *)",
        (refSubstring, expectedCount) => {
          const arns = execRoleSecretArns(refSubstring);
          expect(arns).toHaveLength(expectedCount);
          for (const r of arns) {
            expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
          }
        },
      );

      it("the ETL task role has zero secretsmanager:* actions", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const taskRolePolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("EtlTaskRole") &&
              !r.Ref.includes("EtlTaskExecutionRole"),
          );
        });
        if (taskRolePolicy !== undefined) {
          const serialized = JSON.stringify(
            taskRolePolicy.Properties?.PolicyDocument,
          );
          expect(serialized).not.toMatch(/secretsmanager:/);
        }
      });

      // #443/#742 -- the EtlTaskRole shipped with zero grants, so the three
      // IAM-based source steps (dynamodb nightly, spotlight weekly, hierarchy
      // annual) failed closed (AccessDenied -> exit 1) every cadence. These
      // guards pin EtlTaskRoleReciterAiPolicy to exactly what each step reads.
      // The read-only external-source policy (dynamodb Scan + ReciterAI
      // artifact GetObject). The task role now carries a SECOND policy — the
      // curation-backup-bucket write grant added by grantPut — so these
      // read-only intent assertions target the ReciterAI policy specifically
      // (selected by its explicit `-reciterai` PolicyName). The write grant has
      // its own dedicated test below.
      const etlTaskRolePolicy = () =>
        Object.values(template.findResources("AWS::IAM::Policy")).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          const onTaskRole = roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("EtlTaskRole") &&
              !r.Ref.includes("EtlTaskExecutionRole"),
          );
          const name = p.Properties?.PolicyName;
          return (
            onTaskRole && typeof name === "string" && name.includes("reciterai")
          );
        });

      it("the ETL task role grants dynamodb:Scan scoped to the reciterai + Identity tables (exactly Scan, no bare *)", () => {
        const policy = etlTaskRolePolicy();
        expect(policy).toBeDefined();
        const statements = policy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const dynamoStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("dynamodb:Scan")
            : action === "dynamodb:Scan";
        });
        expect(dynamoStmt).toBeDefined();
        // exactly dynamodb:Scan -- never dynamodb:* or any item/write action
        const action = dynamoStmt?.Action;
        expect(Array.isArray(action) ? action : [action]).toEqual([
          "dynamodb:Scan",
        ]);
        // resources are the reciterai table + the #918 Identity table (ORCID
        // backfill), each named exactly, never a bare *
        const serialized = JSON.stringify(dynamoStmt?.Resource);
        expect(serialized).toMatch(/table\/reciterai/);
        expect(serialized).toMatch(/table\/Identity/);
        expect(serialized).not.toMatch(/\*/);
      });

      it("the ETL task role grants s3:GetObject scoped to exactly the spotlight + tools + ed + mentoring + citations + clinical-trials prefixes + hierarchy bucket (no bare *, no ListBucket)", () => {
        const policy = etlTaskRolePolicy();
        expect(policy).toBeDefined();
        const statements = policy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const s3Stmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("s3:GetObject")
            : action === "s3:GetObject";
        });
        expect(s3Stmt).toBeDefined();
        // exactly s3:GetObject -- never s3:*, PutObject, or ListBucket
        const action = s3Stmt?.Action;
        expect(Array.isArray(action) ? action : [action]).toEqual([
          "s3:GetObject",
        ]);
        // object-scoped: the spotlight + tools + ed + mentoring + citations +
        // clinical-trials prefixes in the shared artifacts bucket + the whole
        // dedicated hierarchy bucket. ed/* is the email-visibility bridge artifact;
        // mentoring/* is the mentee co-pub bridge (#443, etl:mentoring:import-copubs);
        // citations/* is the publication cited-by bridge (#928/#938);
        // clinical-trials/* is the clinical-trials bridge (etl:clinical-trials:import).
        // Order matches the policy.
        const resources = Array.isArray(s3Stmt?.Resource)
          ? (s3Stmt?.Resource as string[])
          : [s3Stmt?.Resource as string];
        expect(resources).toEqual([
          "arn:aws:s3:::wcmc-reciterai-artifacts/spotlight/*",
          "arn:aws:s3:::wcmc-reciterai-artifacts/tools/*",
          "arn:aws:s3:::wcmc-reciterai-artifacts/ed/*",
          "arn:aws:s3:::wcmc-reciterai-artifacts/mentoring/*",
          "arn:aws:s3:::wcmc-reciterai-artifacts/citations/*",
          "arn:aws:s3:::wcmc-reciterai-artifacts/clinical-trials/*",
          "arn:aws:s3:::wcmc-reciterai-hierarchy/*",
        ]);
      });

      it("the ETL task role ReciterAI source policy is read-only -- only Scan/GetObject, never a bare * resource", () => {
        const policy = etlTaskRolePolicy();
        expect(policy).toBeDefined();
        const statements = policy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        expect(statements?.length).toBeGreaterThan(0);
        for (const stmt of statements ?? []) {
          const actions = Array.isArray(stmt.Action)
            ? (stmt.Action as string[])
            : [stmt.Action as string];
          for (const a of actions) {
            expect(a).toMatch(/^(dynamodb:Scan|s3:GetObject)$/);
          }
          const resources = Array.isArray(stmt.Resource)
            ? (stmt.Resource as unknown[])
            : [stmt.Resource];
          for (const r of resources) {
            expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
          }
        }
      });

      it("the ETL task role's only write grants are PutObject scoped to the curation backup bucket and the grants export bucket (no bare *, no other bucket, no delete)", () => {
        // The backup step (scripts/backups/export-curated-tables.ts) writes
        // CurationBackupBucket; the grants bulk export step
        // (scripts/exports/grants-bulk-export.ts) writes GrantsExportBucket.
        // grantPut emits Put*/Abort* on exactly those two buckets -- no other
        // S3 write grant should exist on the task role.
        const policies = Object.values(
          template.findResources("AWS::IAM::Policy"),
        ).filter((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("EtlTaskRole") &&
              !r.Ref.includes("EtlTaskExecutionRole"),
          );
        });
        // Find every statement (across the task role's policies) that grants
        // any S3 write action.
        const writeStmts = policies.flatMap((p) => {
          const statements = (p.Properties?.PolicyDocument?.Statement ??
            []) as Array<Record<string, unknown>>;
          return statements.filter((s) => {
            const action = s.Action;
            const actions = Array.isArray(action) ? action : [action];
            return actions.some(
              (a) => typeof a === "string" && /^s3:(Put|Abort)/.test(a),
            );
          });
        });
        // One write statement per bucket: CurationBackupBucket, GrantsExportBucket.
        expect(writeStmts).toHaveLength(2);
        const serializedResources = writeStmts.map((s) =>
          JSON.stringify(s.Resource),
        );
        expect(serializedResources.some((r) => /CurationBackupBucket/.test(r))).toBe(true);
        expect(serializedResources.some((r) => /GrantsExportBucket/.test(r))).toBe(true);
        for (const stmt of writeStmts) {
          const actions = (
            Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]
          ) as string[];
          // Put/Abort only — never GetObject, DeleteObject, or s3:*.
          for (const a of actions) {
            expect(a).toMatch(/^s3:(PutObject|Abort)/);
          }
          expect(actions).not.toContain("s3:DeleteObject");
          expect(actions).not.toContain("s3:*");
          // Resource is never a bare * or a ReciterAI artifact bucket (those
          // stay read-only).
          const serialized = JSON.stringify(stmt.Resource);
          expect(serialized).not.toMatch(/wcmc-reciterai/);
          expect(serialized).not.toMatch(/^"\*"$/);
        }
      });

      it("every EventBridge-rule role has states:StartExecution scoped to a single state-machine ARN (no *)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const ebPolicies = Object.values(policies).filter((p) => {
          const statements = p.Properties?.PolicyDocument?.Statement as
            | Array<Record<string, unknown>>
            | undefined;
          return statements?.some((s) => {
            const action = s.Action;
            return Array.isArray(action)
              ? action.includes("states:StartExecution")
              : action === "states:StartExecution";
          });
        });
        // One per EventBridge rule.
        expect(ebPolicies.length).toBeGreaterThanOrEqual(3);
        for (const p of ebPolicies) {
          const statements = p.Properties?.PolicyDocument?.Statement as
            | Array<Record<string, unknown>>
            | undefined;
          const startExecStmt = statements?.find((s) => {
            const action = s.Action;
            return Array.isArray(action)
              ? action.includes("states:StartExecution")
              : action === "states:StartExecution";
          });
          expect(JSON.stringify(startExecStmt?.Resource)).not.toMatch(
            /^"\*"$/,
          );
        }
      });
    });

    describe("ETL var injection (#442 -- granular SCHOLARS_*, not blob ETL_*_SECRET)", () => {
      // #1508 -- select the `etl` container of a given task-def family.
      function containerDefForFamily(family: string): Record<string, unknown> {
        const tds = template.findResources("AWS::ECS::TaskDefinition");
        const td = Object.values(tds).find(
          (t) => t.Properties?.Family === family,
        );
        expect(td).toBeDefined();
        const container = (
          td?.Properties?.ContainerDefinitions as
            | Array<Record<string, unknown>>
            | undefined
        )?.find((c) => c.Name === "etl");
        expect(container).toBeDefined();
        return container as Record<string, unknown>;
      }
      // The base def carries the shared secrets + the shared env block.
      function etlContainerDef(): Record<string, unknown> {
        return containerDefForFamily("sps-etl-prod");
      }
      const secretNamesOf = (family: string): string[] =>
        (
          (containerDefForFamily(family).Secrets as
            | Array<{ Name?: string }>
            | undefined) ?? []
        ).map((s) => s.Name ?? "");

      // Each secret group is injected into ITS def -- and only its def (#1508).
      it.each(SECRETS_BY_TASK_DEF)(
        "the $label task def ($family) injects its secret group",
        ({ family, vars }) => {
          const names = secretNamesOf(family);
          for (const v of vars) expect(names).toContain(v);
        },
      );

      it("the base def carries NONE of the per-source creds (LDAP bind pw, DB creds, ReCiter admin key) -- #1508", () => {
        const baseNames = secretNamesOf("sps-etl-prod");
        for (const v of NON_BASE_SECRET_ENV_VARS) {
          expect(baseNames).not.toContain(v);
        }
      });

      it("no ETL task def injects a blob ETL_*_SECRET env var", () => {
        for (const { family } of SECRETS_BY_TASK_DEF) {
          const blobs = secretNamesOf(family).filter((n) =>
            /^ETL_.*_SECRET$/.test(n),
          );
          expect(blobs).toEqual([]);
        }
      });

      it("binds SCHOLARS_LDAP_URL to that JSON key of the ed secret on the ldap def (ValueFrom carries the key)", () => {
        const ldapUrl = (
          containerDefForFamily("sps-etl-ldap-prod").Secrets as
            | Array<{ Name?: string; ValueFrom?: unknown }>
            | undefined
        )?.find((s) => s.Name === "SCHOLARS_LDAP_URL");
        expect(ldapUrl).toBeDefined();
        // CDK serialises a JSON-keyed secret ValueFrom as a Fn::Join whose
        // tail is `:<key>::`; the key segment must be the granular var name.
        expect(JSON.stringify(ldapUrl?.ValueFrom)).toContain(
          "SCHOLARS_LDAP_URL",
        );
      });

      it.each(Object.entries(EXPECTED_ENV_CONFIG))(
        "sets %s=%s in the plaintext environment block",
        (name, value) => {
          const envEntries = (etlContainerDef().Environment ?? []) as Array<{
            Name?: string;
            Value?: string;
          }>;
          const match = envEntries.find((e) => e.Name === name);
          expect(match?.Value).toBe(value);
        },
      );

      it("keeps no IAM-source config (table/buckets/prefix) in the secrets block", () => {
        const secretNames = (
          etlContainerDef().Secrets as Array<{ Name?: string }> | undefined
        )?.map((s) => s.Name);
        for (const name of Object.keys(EXPECTED_ENV_CONFIG)) {
          expect(secretNames).not.toContain(name);
        }
      });

      it("injects OPENSEARCH_NODE from the opensearch secret `node` key (openSearchNodeFromSecret on), not the env block", () => {
        const secretEntries = (etlContainerDef().Secrets ?? []) as Array<{
          Name?: string;
        }>;
        expect(secretEntries.map((s) => s.Name)).toContain("OPENSEARCH_NODE");
        const envEntries = (etlContainerDef().Environment ?? []) as Array<{
          Name?: string;
        }>;
        expect(envEntries.map((e) => e.Name)).not.toContain("OPENSEARCH_NODE");
      });

      it("sets SCHOLARS_BASE_URL pointing at the internal ALB (#479)", () => {
        // The cadence revalidate step calls /api/revalidate on the VPC-private
        // ALB. The value is an Fn::Join that interpolates the internal-ALB DNS
        // SSM param (item-3 pass 2b); assert by string-matching the JSON shape
        // rather than the resolved value (which is a CloudFormation token).
        const envEntries = (etlContainerDef().Environment ?? []) as Array<{
          Name?: string;
          Value?: unknown;
        }>;
        const baseUrl = envEntries.find((e) => e.Name === "SCHOLARS_BASE_URL");
        expect(baseUrl).toBeDefined();
        const valueJson = JSON.stringify(baseUrl?.Value ?? {});
        expect(valueJson).toContain("http://");
        // Value is `http://` + a Ref to the internal-alb-dns SSM CfnParameter
        // (the `/sps/.../internal-alb-dns` path lives in the param's Default, not
        // the env value); match the param's normalized logical-id fragment.
        expect(valueJson).toContain("internalalbdns");
      });
    });

    describe("Footgun #5 -- EC2 property character-set safety", () => {
      it("every SecurityGroupIngress Description is ASCII-safe", () => {
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(ingress)) {
          const desc = resource.Properties?.Description as string | undefined;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            violations.push(
              `${id}: ${JSON.stringify(desc)} -- contains non-ASCII chars banned by EC2`,
            );
          }
        }
        expect(violations).toEqual([]);
      });

      it("every standalone SecurityGroup GroupDescription is ASCII-safe", () => {
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(sgs)) {
          const desc = resource.Properties?.GroupDescription as
            | string
            | undefined;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            violations.push(
              `${id}: ${JSON.stringify(desc)} -- contains non-ASCII chars banned by EC2`,
            );
          }
        }
        expect(violations).toEqual([]);
      });
    });

    describe("Footgun #4 -- env-prefix guard", () => {
      const ENV = "prod";
      const NAME_KEYS: ReadonlyArray<{ type: string; prop: string }> = [
        { type: "AWS::ECS::TaskDefinition", prop: "Family" },
        { type: "AWS::Logs::LogGroup", prop: "LogGroupName" },
        { type: "AWS::IAM::Role", prop: "RoleName" },
        { type: "AWS::StepFunctions::StateMachine", prop: "StateMachineName" },
        { type: "AWS::Events::Rule", prop: "Name" },
        { type: "AWS::SNS::Topic", prop: "TopicName" },
        { type: "AWS::CloudWatch::Alarm", prop: "AlarmName" },
      ];
      it.each(NAME_KEYS)(
        "every $type carries the env literal in $prop",
        ({ type, prop }) => {
          const resources = template.findResources(type);
          const violations: string[] = [];
          for (const [id, resource] of Object.entries(resources)) {
            const name = resource.Properties?.[prop] as string | undefined;
            if (typeof name !== "string") {
              continue;
            }
            if (!name.includes(ENV)) {
              violations.push(
                `${id}: ${type}.${prop}=${JSON.stringify(name)}`,
              );
            }
          }
          expect(violations).toEqual([]);
        },
      );
    });

    describe("Region pinning", () => {
      // Stacks must synthesize to us-east-1 (per ADR-008). The synthesized
      // template doesn't carry the region in its body -- regional pinning
      // sits on the producing Stack object. We assert through the fixture.
      it("EtlStack synthesises in us-east-1", () => {
        const { stack } = buildEtlStack("prod");
        expect(stack.region).toBe("us-east-1");
      });
    });
  });

  describe("staging", () => {
    const { template } = buildEtlStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("excludes etl:infoed from the staging nightly cadence (on-prem CIDR overlap; docs/etl-vpc-migration-handoff.md), while prod keeps it", () => {
      const stagingNightly = getStateMachineDefinitionText(
        template,
        "scholars-nightly-staging",
      );
      expect(stagingNightly).not.toMatch(/etl:infoed/);
      // The exclusion is staging-only — prod's nightly still runs InfoEd.
      const prodNightly = getStateMachineDefinitionText(
        buildEtlStack("prod").template,
        "scholars-nightly-prod",
      );
      expect(prodNightly).toMatch(/etl:infoed/);
    });

    it("includes etl:mesh-anchors in BOTH nightly cadences (#1258, promoted to prod in #2016)", () => {
      const stagingNightly = getStateMachineDefinitionText(
        template,
        "scholars-nightly-staging",
      );
      expect(stagingNightly).toMatch(/etl:mesh-anchors/);
      // #2016 — prod no longer excludes it. The curated anchors soaked in staging
      // from 2026-06-25; the SECOND gate (MESH_ANCHOR_SCORE_MIN) is what still
      // holds derived rows back in prod, and it is asserted separately below.
      const prodNightly = getStateMachineDefinitionText(
        buildEtlStack("prod").template,
        "scholars-nightly-prod",
      );
      expect(prodNightly).toMatch(/etl:mesh-anchors/);
    });

    it("includes etl:mesh-aliases in BOTH nightly cadences (#2093 part A)", () => {
      // mesh_curated_alias previously only refreshed on an on-demand run, per
      // env, with nothing keeping them in sync — same failure class as #2051.
      const stagingNightly = getStateMachineDefinitionText(
        template,
        "scholars-nightly-staging",
      );
      expect(stagingNightly).toMatch(/etl:mesh-aliases/);
      const prodNightly = getStateMachineDefinitionText(
        buildEtlStack("prod").template,
        "scholars-nightly-prod",
      );
      expect(prodNightly).toMatch(/etl:mesh-aliases/);
    });

    it("includes etl:family-sensitivity and etl:family-suppression in BOTH nightly cadences (#2051 part B)", () => {
      // family_sensitivity_overlay / family_suppression_overlay previously only
      // refreshed on an on-demand run, per env, with nothing keeping staging and
      // prod in sync — prod's suppression overlay sat empty for an unknown period.
      const stagingNightly = getStateMachineDefinitionText(
        template,
        "scholars-nightly-staging",
      );
      expect(stagingNightly).toMatch(/etl:family-sensitivity/);
      expect(stagingNightly).toMatch(/etl:family-suppression/);
      const prodNightly = getStateMachineDefinitionText(
        buildEtlStack("prod").template,
        "scholars-nightly-prod",
      );
      expect(prodNightly).toMatch(/etl:family-sensitivity/);
      expect(prodNightly).toMatch(/etl:family-suppression/);
    });

    it("keeps prod's derived-anchor kill-switch ON — promoting the step must not promote derived rows", () => {
      // The two gates are independent and this pins that. If a future change drops
      // MESH_ANCHOR_SCORE_MIN to 0.9 for prod it should be a deliberate, separately
      // reviewed decision, not a side effect of the #2016 step promotion. A value
      // > 1 is the documented kill-switch: curated rows still load, derived is zero.
      const prodEnv = JSON.stringify(buildEtlStack("prod").template.toJSON());
      expect(prodEnv).toMatch(/"MESH_ANCHOR_SCORE_MIN"[^}]*"2"/);
      const stagingEnv = JSON.stringify(template.toJSON());
      expect(stagingEnv).toMatch(/"MESH_ANCHOR_SCORE_MIN"[^}]*"0\.9"/);
    });

    it("staging EventBridge rules ship enabled (etlSchedulesEnabled + reconcileScheduleEnabled + cdnReconcileScheduleEnabled + curationBackupScheduleEnabled + grantsExportScheduleEnabled + edEmailVisibilityBridgeEnabled all true)", () => {
      const rules = template.findResources("AWS::Events::Rule");
      // 3 cadence rules + the #595 heartbeat rule + the #393 reconciler rule +
      // the #353 cdn reconciler rule + the #1032 curated-tables backup rule +
      // the grants bulk export rule + the #443 ED email-visibility bridge
      // rule; all enabled in staging.
      // The #1218 opportunity-projection rule was RETIRED in staging on
      // 2026-07-20 (the nightly now covers the work), so 9 rather than 10.
      expect(Object.keys(rules)).toHaveLength(9);
      for (const [id, rule] of Object.entries(rules)) {
        const state = rule.Properties?.State as string | undefined;
        expect({ id, state }).toEqual({ id, state: "ENABLED" });
      }
    });

    it("staging ships NO standalone opportunity projection (#1218 retired 2026-07-20): no rule, no state machine, no cadence alarm", () => {
      // #1218 was a stopgap for a nightly that aborted at etl:ed (#443). The
      // nightly now completes and runs TaskDynamodb itself, so the standalone
      // daily is redundant and was retired via opportunityProjectionScheduleEnabled.
      //
      // This test is the guard against silent RESURRECTION, which is the failure
      // that actually happened: an operator disabled the live EventBridge rule by
      // hand on 2026-06-23, but the template still declared State=ENABLED, so the
      // next cdk deploy would have turned a deliberately-stopped job back on.
      // Config is now the single source of truth; assert the template agrees.
      const ruleNames = Object.values(template.findResources("AWS::Events::Rule"))
        .map((r) => r.Properties?.Name as string | undefined);
      expect(ruleNames).not.toContain("sps-opportunity-projection-staging");

      const smNames = Object.values(
        template.findResources("AWS::StepFunctions::StateMachine"),
      ).map((s) => s.Properties?.StateMachineName as string | undefined);
      expect(smNames).not.toContain("scholars-opportunity-projection-staging");

      const alarmNames = Object.values(
        template.findResources("AWS::CloudWatch::Alarm"),
      ).map((a) => a.Properties?.AlarmName as string | undefined);
      expect(alarmNames).not.toContain(
        "sps-opportunity-projection-cadence-staging",
      );
      // The status alarm lives in the same creation-gated block, so it must be
      // absent for the same reason -- an alarm on a state machine that does not
      // exist would sit INSUFFICIENT_DATA forever.
      expect(alarmNames).not.toContain(
        "sps-opportunity-projection-status-staging",
      );
    });

    it("staging schedules the daily curated-tables backup (#1032): daily rule → state machine running backup:curated on the ETL task def", () => {
      // The rule fires daily at 06:00 UTC and is enabled in staging.
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "sps-curation-backup-staging",
        ScheduleExpression: "cron(0 6 * * ? *)",
        State: "ENABLED",
      });
      // Its own state machine exists (Catch → SNS failure notification).
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "scholars-curation-backup-staging",
      });
      // The step overrides the ETL container to run the backup script.
      const sms = template.findResources("AWS::StepFunctions::StateMachine");
      const backupSm = Object.values(sms).find(
        (s) =>
          s.Properties?.StateMachineName === "scholars-curation-backup-staging",
      );
      expect(backupSm).toBeDefined();
      const def = JSON.stringify(backupSm?.Properties?.DefinitionString ?? "");
      expect(def).toMatch(/backup:curated/);
      // A cadence alarm guards against silent schedule death.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "sps-curation-backup-cadence-staging",
      });
      // ...and a status alarm guards the run itself. The cadence alarm cannot:
      // a TIMED_OUT execution STARTED, so ExecutionsStarted is 1, and the
      // machine's Catch never runs on a timeout so nothing publishes to
      // etl-failures either. Without this the backup fails in total silence,
      // which is the failure you discover when you go to restore.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "sps-curation-backup-status-staging",
      });
    });

    it("the grants-export cross-account read grant is scoped to the one object key, GetObject only, principal from SSM (never a bare bucket/wildcard)", () => {
      // This is the stack's first EXTERNAL-account resource policy (every
      // other cross-account-shaped grant here is same-account). Asserted
      // separately from the opaque full-stack snapshot so a scope-widening
      // refactor (e.g. object-key ARN -> bucket ARN, or GetObject -> s3:*)
      // fails a targeted test, not just a snapshot diff nobody reads closely.
      const json = template.toJSON();

      // `valueForStringParameter` lowers to an `AWS::SSM::Parameter::Value<String>`
      // template Parameter (NOT a `{{resolve:ssm:...}}` dynamic reference) --
      // CloudFormation looks this up for the WHOLE template up front, before
      // touching any resource, which is exactly why a missing SSM param aborts
      // the entire stack update rather than just the new resources (finding #1).
      const params = json.Parameters as Record<string, Record<string, unknown>>;
      const ssmParamLogicalId = Object.entries(params).find(
        ([, p]) =>
          p.Type === "AWS::SSM::Parameter::Value<String>" &&
          p.Default === "/scholars/staging/grants-export/consumer-role-arn",
      )?.[0];
      expect(ssmParamLogicalId).toBeDefined();

      const bucketPolicies = Object.values(
        template.findResources("AWS::S3::BucketPolicy"),
      ).map((r) => (r.Properties as Record<string, unknown>).PolicyDocument as Record<string, unknown>);
      const grantsPolicy = bucketPolicies.find((doc) =>
        JSON.stringify(doc).includes(ssmParamLogicalId as string),
      );
      expect(grantsPolicy).toBeDefined();
      const statements = grantsPolicy?.Statement as Array<Record<string, unknown>>;
      // The bucket's default enforceSSL deny statement, plus this one grant.
      const stmt = statements.find((s) => s.Effect === "Allow");
      expect(stmt).toBeDefined();

      // Action: GetObject only -- never ListBucket, never a wildcard.
      const actions = Array.isArray(stmt!.Action) ? stmt!.Action : [stmt!.Action];
      expect(actions).toEqual(["s3:GetObject"]);

      // Resource: the single persistent key, never the bucket itself or "*".
      const resource = JSON.stringify(stmt!.Resource);
      expect(resource).toContain("grants.ndjson");
      expect(resource).not.toMatch(/^"\*"$/);

      // Principal: Ref to the SSM-sourced parameter (resolved at deploy time,
      // never a hardcoded account ID/role ARN -- this repo is public), not a
      // bare "*".
      expect(stmt!.Principal).toEqual({ AWS: { Ref: ssmParamLogicalId } });
    });

    it("prod ships the grants-export bucket (unconditional) but NO cross-account read grant while the flag is off", () => {
      // Mirrors the opportunity-projection resurrection guard above: the
      // bucket + write grant are unconditional in both envs (an operator can
      // run the export by hand via run-task before go-live), but the
      // cross-account READ policy must stay absent from prod until
      // grantsExportScheduleEnabled flips -- an SSM param that does not exist
      // in prod yet would otherwise fail the next `cdk deploy Sps-Etl-prod`.
      const prodTemplate = buildEtlStack("prod").template;
      const prodPolicies = JSON.stringify(
        prodTemplate.findResources("AWS::S3::BucketPolicy"),
      );
      expect(prodPolicies).not.toMatch(/grants-export\/consumer-role-arn/);
    });

    // The prod template asserts the same invariant, but staging is where the
    // three short-lived machines actually synthesize -- so this is the case
    // that would have caught the gap.
    it("every state machine is watched by a failed+timedOut+aborted status alarm", () => {
      const { machines, covered } = statusAlarmCoverage(template);
      expect(machines.length).toBeGreaterThan(0);
      expect(covered).toEqual(machines);
    });

    it("staging schedules the ED email-visibility bridge (#443): weekly rule → 2-step SM (export@scholars-dev → import@Sps-VPC), export SG in the on-prem VPC, scoped ed/* PutObject grant", () => {
      // Weekly rule, Sunday 05:00 UTC, enabled in staging.
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "sps-ed-email-visibility-staging",
        ScheduleExpression: "cron(0 5 ? * SUN *)",
        State: "ENABLED",
      });
      // The bridge state machine exists.
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "scholars-ed-email-visibility-staging",
      });
      // Its definition runs BOTH halves of the bridge.
      const def = getStateMachineDefinitionText(
        template,
        "scholars-ed-email-visibility-staging",
      );
      expect(def).toMatch(/etl:ed:export-email-visibility/);
      expect(def).toMatch(/etl:ed:import-email-visibility/);
      // The export step's ENI is placed in scholars-dev's two private app
      // subnets (the on-prem-reachable VPC), with the dedicated EdExportSg --
      // NOT the Sps etl SG. (The import half runs in the Sps VPC.)
      expect(def).toMatch(/subnet-08cab06d3084fba41/);
      expect(def).toMatch(/subnet-07ffed73356c01f6c/);
      expect(def).toMatch(/EdExportSg/);
      // The export SG lives in the imported scholars-dev VPC, egress-only.
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        VpcId: "vpc-02c4dd698f3e3869c",
        GroupDescription:
          "SPS ED email-visibility export task egress (staging).",
      });
      // A cadence alarm guards against silent schedule death.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "sps-ed-email-visibility-cadence-staging",
      });
      // ...and a status alarm guards the run itself -- the export half alone
      // can outlive the machine timeout on a hung LDAP bind, and a TIMED_OUT
      // machine runs no Catch, so neither the per-step SNS publish nor the
      // cadence alarm (the execution DID start) would say anything.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "sps-ed-email-visibility-status-staging",
      });
      // The export writes via the task role: a PutObject grant scoped to exactly
      // the ed/* prefix is present (narrow -- s3:PutObject only, no wildcard).
      const policies = template.findResources("AWS::IAM::Policy");
      const hasScopedEdPut = Object.values(policies).some((p) => {
        const stmts =
          (p.Properties?.PolicyDocument?.Statement as
            | Array<{ Action?: unknown; Resource?: unknown }>
            | undefined) ?? [];
        return stmts.some((s) => {
          const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          const act = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            res.includes("arn:aws:s3:::wcmc-reciterai-artifacts/ed/*") &&
            act.includes("s3:PutObject")
          );
        });
      });
      expect(hasScopedEdPut).toBe(true);
    });

    it("staging ETL task definition uses 2048 cpu / 8192 MiB (#485 search:index OOM)", () => {
      const tds = template.findResources("AWS::ECS::TaskDefinition");
      // Three task defs now (ETL + lean #393 reconcile + lean #353 cdn
      // reconcile); select the ETL one.
      const td = Object.values(tds).find(
        (t) => t.Properties?.Family === "sps-etl-staging",
      );
      expect(td).toBeDefined();
      expect(td?.Properties?.Cpu).toBe("2048");
      expect(td?.Properties?.Memory).toBe("8192");
    });

    it("staging lean reconcile task definition uses 256 cpu / 512 MiB and ships its rule enabled", () => {
      const tds = template.findResources("AWS::ECS::TaskDefinition");
      const td = Object.values(tds).find(
        (t) => t.Properties?.Family === "sps-reconcile-staging",
      );
      expect(td).toBeDefined();
      expect(td?.Properties?.Cpu).toBe("256");
      expect(td?.Properties?.Memory).toBe("512");
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "sps-reconcile-staging",
        ScheduleExpression: "rate(5 minutes)",
        State: "ENABLED",
      });
    });

    it("staging lean cdn reconcile task definition uses 256 cpu / 512 MiB and ships its rule enabled", () => {
      const tds = template.findResources("AWS::ECS::TaskDefinition");
      const td = Object.values(tds).find(
        (t) => t.Properties?.Family === "sps-cdn-reconcile-staging",
      );
      expect(td).toBeDefined();
      expect(td?.Properties?.Cpu).toBe("256");
      expect(td?.Properties?.Memory).toBe("512");
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "sps-cdn-reconcile-staging",
        ScheduleExpression: "rate(5 minutes)",
        State: "ENABLED",
      });
    });

    it("uses 30-day log retention for staging", () => {
      const groups = template.findResources("AWS::Logs::LogGroup");
      for (const resource of Object.values(groups)) {
        expect(resource.Properties?.RetentionInDays).toBe(30);
      }
    });
  });

  // #2191 -- a continue-tier step that fails all its retries notifies and hands
  // on to its successor, so every remaining step runs; the execution used to
  // then report SUCCEEDED with the step dead inside it. Measured on prod: 2 of
  // the 20 nightlies from 2026-07-17 to 08-05 ended green with a dead step.
  //
  // The whole mechanism is `$.error` (written by every Catch) surviving to a
  // terminal Choice. It survives ONLY because the states in between discard
  // their results -- the ASL default ResultPath of `$` would overwrite it. That
  // is the fragile part, so it is what these tests pin.
  describe("degraded-run detection (#2191)", () => {
    const { template } = buildEtlStack("staging");
    // Parse a definition into real ASL rather than grepping the text, so these
    // assert on structure (which state points where) instead of substrings.
    // DefinitionString is an Fn::Join whose intrinsic chunks sit INSIDE JSON
    // string values -- rendering them as JSON would inject quotes and break the
    // parse, so each collapses to an opaque literal.
    // Throws rather than expect()s: this also runs at describe time, where a
    // failed expectation would not be attributed to any test.
    const aslOf = (name: string): { States: Record<string, Record<string, unknown>> } => {
      const sms = template.findResources("AWS::StepFunctions::StateMachine");
      const match = Object.values(sms).find((r) => r.Properties?.StateMachineName === name);
      if (match === undefined) {
        throw new Error(`no state machine named ${name}`);
      }
      const def = match.Properties?.DefinitionString as
        | { "Fn::Join"?: [string, unknown[]] }
        | string;
      const parts = typeof def === "string" ? [def] : (def?.["Fn::Join"]?.[1] ?? []);
      const text = parts.map((p) => (typeof p === "string" ? p : "REF")).join("");
      return JSON.parse(text) as { States: Record<string, Record<string, unknown>> };
    };

    const isTask = (s: Record<string, unknown>, kind: string): boolean =>
      s.Type === "Task" && String(s.Resource ?? "").includes(kind);

    // DISCOVER the graded machines instead of listing them. A fifth cadence
    // added later is then covered automatically -- a hardcoded list would stop
    // applying at exactly the moment someone is most able to reintroduce this
    // bug. An `*Outcome` state is buildStateMachine's signature; the reconcile
    // and backup machines are built separately and legitimately lack one.
    const gradedMachines = Object.values(
      template.findResources("AWS::StepFunctions::StateMachine"),
    )
      .map((r) => String(r.Properties?.StateMachineName ?? ""))
      .filter((n) => n !== "")
      .filter((n) => Object.keys(aslOf(n).States).some((s) => s.endsWith("Outcome")))
      .sort();

    // Without this, a discovery bug that returned [] would make every it.each
    // below vacuous -- zero tests, all green. Adding a real fifth machine is
    // meant to fail here once, deliberately.
    it("discovers exactly the machines buildStateMachine produces", () => {
      expect(gradedMachines).toEqual([
        "scholars-annual-staging",
        "scholars-heartbeat-staging",
        "scholars-nightly-staging",
        "scholars-weekly-staging",
      ]);
    });

    it.each(gradedMachines)(
      "%s ends in a Choice that fails the run when $.error is present",
      (name) => {
        const states = aslOf(name).States;
        const outcome = Object.entries(states).find(([n]) => n.endsWith("Outcome"));
        expect(outcome).toBeDefined();
        const [, choice] = outcome!;
        expect(choice.Type).toBe("Choice");
        const choices = choice.Choices as Array<Record<string, unknown>>;
        expect(choices).toHaveLength(1);
        expect(choices[0].Variable).toBe("$.error");
        expect(choices[0].IsPresent).toBe(true);

        // The degraded branch must FAIL -- a Pass or a Succeed here would keep
        // the lie this exists to remove.
        const degraded = states[String(choices[0].Next)];
        expect(degraded.Type).toBe("Fail");
        expect(degraded.Error).toBe("DegradedRun");
        // ...and the clean branch must still succeed, or every run goes red.
        expect(states[String(choice.Default)].Type).toBe("Succeed");
      },
    );

    it.each(gradedMachines)(
      "%s: no Task state overwrites `$`, so the $.error a Catch writes survives to the Outcome",
      (name) => {
        const states = aslOf(name).States;
        // ASL default ResultPath is `$`: any Task that does not explicitly
        // discard would overwrite the whole state -- and the marker with it.
        const clobbering = Object.entries(states)
          .filter(([, s]) => isTask(s, "ecs:runTask") || isTask(s, "sns:publish"))
          .filter(([, s]) => s.ResultPath !== null)
          .map(([n]) => n);
        expect(clobbering).toEqual([]);
      },
    );

    it("duration alarms exist per cadence, in MILLISECONDS, and skip the annual machine", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const byName = new Map(
        Object.values(alarms).map((a) => [String(a.Properties?.AlarmName ?? ""), a.Properties]),
      );
      // ExecutionTime is emitted in ms. A threshold written in SECONDS would be
      // ~3.6M times too small and every run would alarm -- and a threshold in
      // MINUTES would never alarm at all. Pin the real numbers.
      const expected: Record<string, number> = {
        [`sps-etl-nightly-duration-staging`]: 150 * 60 * 1000,
        [`sps-etl-weekly-duration-staging`]: 3 * 60 * 60 * 1000,
        [`sps-etl-heartbeat-duration-staging`]: 30 * 60 * 1000,
      };
      for (const [name, threshold] of Object.entries(expected)) {
        const p = byName.get(name);
        expect(p).toBeDefined();
        expect(p?.Threshold).toBe(threshold);
        expect(p?.MetricName).toBe("ExecutionTime");
        expect(p?.Statistic).toBe("Maximum");
        expect(p?.ComparisonOperator).toBe("GreaterThanThreshold");
        // Missing data means "no execution ended this hour", not "healthy for
        // 0ms" -- breaching here would alarm continuously between runs.
        expect(p?.TreatMissingData).toBe("notBreaching");
      }
      // Annual is excluded on purpose: its ExecutionTime is dominated by the
      // manual approval gate's wait, so this would page for a slow human.
      expect(byName.has("sps-etl-annual-duration-staging")).toBe(false);
    });

    it("every duration threshold sits above the observed prod p90 for that cadence", () => {
      // Guards against a threshold tightened to the point of chronic noise --
      // the failure mode this whole area exists to avoid. Observed prod maxima
      // over 120d: nightly p90 1.55h, weekly p90 1.89h, heartbeat max 0.10h.
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const thresholdOf = (n: string): number =>
        Number(
          Object.values(alarms).find((a) => a.Properties?.AlarmName === n)?.Properties?.Threshold,
        );
      const H = 60 * 60 * 1000;
      expect(thresholdOf("sps-etl-nightly-duration-staging")).toBeGreaterThan(1.55 * H);
      expect(thresholdOf("sps-etl-weekly-duration-staging")).toBeGreaterThan(1.89 * H);
      expect(thresholdOf("sps-etl-heartbeat-duration-staging")).toBeGreaterThan(0.1 * H);
    });

    it("nightly: a continue-tier failure still runs the remaining steps", () => {
      const states = aslOf("scholars-nightly-staging").States;
      // Asms is continue-tier: its Catch goes to NotifyAsms, which must hand on
      // to the NEXT STEP rather than jumping to the Outcome. Losing this turns
      // "warn and carry on" into "abort", which is a much worse regression than
      // the one being fixed.
      const catches = states.TaskAsms.Catch as Array<Record<string, unknown>>;
      expect(catches[0].Next).toBe("NotifyAsms");
      expect(catches[0].ResultPath).toBe("$.error");
      const next = String(states.NotifyAsms.Next);
      expect(next).not.toMatch(/Outcome$/);
      expect(states[next].Type).toBe("Task");
    });

    it("nightly: only the last step feeds the Outcome, and abort-tier steps still stop at their own Fail", () => {
      const states = aslOf("scholars-nightly-staging").States;
      const feeders = Object.entries(states)
        .filter(([, s]) => String(s.Next ?? "").endsWith("Outcome"))
        .map(([n]) => n);
      expect(feeders).toEqual(["TaskIntegrityNightly"]);
      // IntegrityNightly is abort-tier: its own failure must still terminate at
      // FailIntegrityNightly, never fall through to the degraded-but-complete
      // branch, which would understate a volume-gate breach.
      const catches = states.TaskIntegrityNightly.Catch as Array<Record<string, unknown>>;
      expect(states[String(catches[0].Next)].Next).toBe("FailIntegrityNightly");
      expect(states.FailIntegrityNightly.Type).toBe("Fail");
    });
  });
});
