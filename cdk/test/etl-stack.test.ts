import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { EtlStack } from "../lib/etl-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

function buildEtlStack(envName: "staging" | "prod"): {
  template: Template;
  stack: EtlStack;
} {
  const fixture = makeFixture(envName);
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const appStack = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    albSecurityGroup: network.albSecurityGroup,
  });
  const stack = new EtlStack(fixture.app, `Sps-Etl-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
    etlSecurityGroup: network.etlSecurityGroup,
    ecsCluster: appStack.ecsCluster,
    etlEcrRepository: appStack.etlEcrRepository,
  });
  return { template: Template.fromStack(stack), stack };
}

// Re-asserted per Footgun #6 / feedback_ec2_descriptions_ascii_only.
// The allow-set matches the regex documented in app-stack.test.ts.
const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

// EventBridge cron expressions confirmed in plan D7.
const EXPECTED_CRONS: Readonly<Record<string, string>> = {
  nightly: "cron(0 7 * * ? *)",
  weekly: "cron(0 8 ? * SUN *)",
  annual: "cron(0 9 1 7 ? *)",
};

// #442 -- the task container injects each credentialed source's granular
// SCHOLARS_* keys (plus the three shared secrets), NOT a blob ETL_*_SECRET.
const EXPECTED_SECRET_ENV_VARS = [
  // shared
  "DATABASE_URL",
  "OPENSEARCH_USER",
  "OPENSEARCH_PASS",
  // #447 -- renamed from REVALIDATE_TOKEN; etl/orchestrate.ts reads
  // SCHOLARS_REVALIDATE_TOKEN.
  "SCHOLARS_REVALIDATE_TOKEN",
  // ed (LDAP simple bind)
  "SCHOLARS_LDAP_URL",
  "SCHOLARS_LDAP_BIND_DN",
  "SCHOLARS_LDAP_BIND_PASSWORD",
  // asms
  "SCHOLARS_ASMS_HOST",
  "SCHOLARS_ASMS_PORT",
  "SCHOLARS_ASMS_DATABASE",
  "SCHOLARS_ASMS_USERNAME",
  "SCHOLARS_ASMS_PASSWORD",
  // infoed
  "SCHOLARS_INFOED_DB_URL",
  "SCHOLARS_INFOED_USERNAME",
  "SCHOLARS_INFOED_PASSWORD",
  // coi
  "SCHOLARS_COI_URL",
  "SCHOLARS_COI_PORT",
  "SCHOLARS_COI_DATABASE",
  "SCHOLARS_COI_USERNAME",
  "SCHOLARS_COI_PASSWORD",
  // reciter (ReciterDB MySQL)
  "SCHOLARS_RECITERDB_HOST",
  "SCHOLARS_RECITERDB_PORT",
  "SCHOLARS_RECITERDB_DATABASE",
  "SCHOLARS_RECITERDB_USERNAME",
  "SCHOLARS_RECITERDB_PASSWORD",
  // jenzabar (PhD-mentor MSSQL -- #608)
  "SCHOLARS_JENZABAR_SERVER",
  "SCHOLARS_JENZABAR_PORT",
  "SCHOLARS_JENZABAR_DATABASE",
  "SCHOLARS_JENZABAR_USERNAME",
  "SCHOLARS_JENZABAR_PASSWORD",
  // reciter REST API (#746 -- the "Not mine" reject scanner; ADMIN api-key kept
  // out of the public web app, injected ONLY into this ETL task)
  "RECITER_API_BASE_URL",
  "RECITER_API_KEY",
] as const;

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
  // Env-conditional since the staging-first cutover (staging flips to "s3",
  // covered by the staging snapshot). EXPECTED_ENV_CONFIG is asserted only
  // against the prod template below, so this entry now guards that prod stays
  // "ddb" until the prod cutover is signed off.
  SCHOLAR_TOOL_SOURCE: "ddb",
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
  describe("prod", () => {
    const { template } = buildEtlStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    describe("Resource counts (B08 / B20 acceptance)", () => {
      it("creates six state machines (3 cadence + #595 heartbeat + #393 reconciler + #353 cdn reconciler), six EventBridge rules, one SNS topic", () => {
        // 3 cadence machines + the #595 heartbeat + the #393 reconciler +
        // the #353 cdn reconciler (PR-2).
        template.resourceCountIs("AWS::StepFunctions::StateMachine", 6);
        template.resourceCountIs("AWS::Events::Rule", 6);
        // The heartbeat + both reconcilers reuse the cadence failure topic -- still one.
        template.resourceCountIs("AWS::SNS::Topic", 1);
      });

      it("creates eleven CloudWatch alarms (4 status + nightly/weekly/heartbeat cadence + reconciler status/cadence + cdn reconciler status/cadence)", () => {
        // 7 cadence-machine alarms (4 status + 3 cadence: nightly/weekly/heartbeat)
        // + 2 reconciler alarms (#393) + 2 cdn reconciler alarms (#353).
        template.resourceCountIs("AWS::CloudWatch::Alarm", 11);
      });

      it("creates three ECS task definitions (ETL + lean reconciler + lean cdn reconciler) and one SG-to-SG ingress rule on the internal ALB SG", () => {
        // The fat ETL task def + the lean #393 reconcile task def + the lean
        // #353 cdn reconcile task def.
        template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
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

      it("prod CADENCE schedules ship disabled (etlSchedulesEnabled=false)", () => {
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
          // CDK serializes enabled=false as State=DISABLED.
          expect({ id, state }).toEqual({ id, state: "DISABLED" });
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
        // 7 cadence-machine alarms (4 status + 3 cadence) + 2 reconciler alarms
        // (#393) + 2 cdn reconciler alarms (#353); all share the topic.
        expect(Object.keys(alarms)).toHaveLength(11);
        for (const [id, alarm] of Object.entries(alarms)) {
          const actions = (alarm.Properties?.AlarmActions ?? []) as unknown[];
          expect({ id, hasAction: actions.length > 0 }).toEqual({
            id,
            hasAction: true,
          });
        }
      });

      it("cadence status alarms watch ExecutionsFailed sum > 0", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        // Scope to the cadence machines (sps-etl-*); the #393 reconciler's
        // status alarm has its own focused test below.
        const statusAlarms = Object.values(alarms).filter((a) => {
          const name = a.Properties?.AlarmName as string | undefined;
          return (
            typeof name === "string" &&
            name.startsWith("sps-etl-") &&
            name.includes("-status-")
          );
        });
        expect(statusAlarms).toHaveLength(4);
        for (const a of statusAlarms) {
          expect(a.Properties?.MetricName).toBe("ExecutionsFailed");
          expect(a.Properties?.Statistic).toBe("Sum");
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
          const period = a.Properties?.Period as number | undefined;
          const evals = a.Properties?.EvaluationPeriods as number | undefined;
          if (typeof period === "number" && period >= 3600) {
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

      it("injects exactly the three secrets the worker reads, and no SCHOLARS_* / ETL_*_SECRET", () => {
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
          "OPENSEARCH_PASS",
          "OPENSEARCH_USER",
        ]);
        // No per-source ETL credentials leak onto the reconcile task.
        const leaked = (secretNames ?? []).filter(
          (n) => /^SCHOLARS_/.test(n ?? "") || /^ETL_.*_SECRET$/.test(n ?? ""),
        );
        expect(leaked).toEqual([]);
        // OPENSEARCH_NODE rides in the plaintext environment block.
        const envNames = (
          container?.Environment as Array<{ Name?: string }> | undefined
        )?.map((e) => e.Name);
        expect(envNames).toContain("OPENSEARCH_NODE");
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

      it("the status alarm watches ExecutionsFailed sum > 0 (idle window not breaching)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-reconcile-status-prod",
          MetricName: "ExecutionsFailed",
          Statistic: "Sum",
          ComparisonOperator: "GreaterThanThreshold",
          Threshold: 0,
          TreatMissingData: "notBreaching",
        });
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

      it("the status alarm watches ExecutionsFailed sum > 0 (idle window not breaching)", () => {
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "sps-cdn-reconcile-status-prod",
          MetricName: "ExecutionsFailed",
          Statistic: "Sum",
          ComparisonOperator: "GreaterThanThreshold",
          Threshold: 0,
          TreatMissingData: "notBreaching",
        });
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
      it("the task-execution role's secretsmanager:GetSecretValue lists exactly the 10 consumer ARNs (no *)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("EtlTaskExecutionRole"),
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
        // 7 credentialed sources (incl. reciter-api, #746) + db/etl +
        // opensearch/etl + revalidate-token = 10. The dynamodb/spotlight/
        // hierarchy sources are IAM-based (task role) and read no injected
        // secret, so they are absent (#442).
        expect(resourceList).toHaveLength(10);
        for (const r of resourceList) {
          expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
        }
      });

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

      it("the ETL task role's only write grant is PutObject scoped to the curation backup bucket (no bare *, no other bucket, no delete)", () => {
        // The backup step (scripts/backups/export-curated-tables.ts) is the sole
        // writer; grantPut emits Put*/Abort* on exactly the CurationBackupBucket.
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
        // Find the single statement (across the task role's policies) that
        // grants any S3 write action.
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
        expect(writeStmts).toHaveLength(1);
        const stmt = writeStmts[0];
        const actions = (
          Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]
        ) as string[];
        // Put/Abort only — never GetObject, DeleteObject, or s3:*.
        for (const a of actions) {
          expect(a).toMatch(/^s3:(PutObject|Abort)/);
        }
        expect(actions).not.toContain("s3:DeleteObject");
        expect(actions).not.toContain("s3:*");
        // Resource is the backup bucket's objects, never a bare * or any other
        // bucket (the ReciterAI artifact buckets stay read-only).
        const serialized = JSON.stringify(stmt.Resource);
        expect(serialized).toMatch(/CurationBackupBucket/);
        expect(serialized).not.toMatch(/wcmc-reciterai/);
        expect(serialized).not.toMatch(/^"\*"$/);
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
      function etlContainerDef(): Record<string, unknown> {
        // Two task defs now (fat ETL + lean #393 reconcile); select the ETL one
        // by its family, then its `etl` container.
        const tds = template.findResources("AWS::ECS::TaskDefinition");
        const etlTd = Object.values(tds).find(
          (td) => td.Properties?.Family === "sps-etl-prod",
        );
        expect(etlTd).toBeDefined();
        const container = (
          etlTd?.Properties?.ContainerDefinitions as
            | Array<Record<string, unknown>>
            | undefined
        )?.find((c) => c.Name === "etl");
        expect(container).toBeDefined();
        return container as Record<string, unknown>;
      }

      it.each(EXPECTED_SECRET_ENV_VARS)(
        "injects %s as a secret env var",
        (envVar) => {
          const secretNames = (
            etlContainerDef().Secrets as Array<{ Name?: string }> | undefined
          )?.map((s) => s.Name);
          expect(secretNames).toContain(envVar);
        },
      );

      it("injects no blob ETL_*_SECRET env var", () => {
        const secretNames = (
          etlContainerDef().Secrets as Array<{ Name?: string }> | undefined
        )?.map((s) => s.Name ?? "");
        const blobs = (secretNames ?? []).filter((n) =>
          /^ETL_.*_SECRET$/.test(n),
        );
        expect(blobs).toEqual([]);
      });

      it("binds SCHOLARS_LDAP_URL to that JSON key of the ed secret (ValueFrom carries the key)", () => {
        const ldapUrl = (
          etlContainerDef().Secrets as
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

      it("sets OPENSEARCH_NODE in the environment block (#447, imported from DataStack)", () => {
        const envEntries = (etlContainerDef().Environment ?? []) as Array<{
          Name?: string;
        }>;
        expect(envEntries.map((e) => e.Name)).toContain("OPENSEARCH_NODE");
      });

      it("sets SCHOLARS_BASE_URL pointing at the internal ALB (#479)", () => {
        // The cadence revalidate step calls /api/revalidate on the VPC-private
        // ALB. The value is an Fn::Join that interpolates the cross-stack
        // import of InternalAlbDns; assert by string-matching the JSON shape
        // rather than the resolved value (which is a CloudFormation token).
        const envEntries = (etlContainerDef().Environment ?? []) as Array<{
          Name?: string;
          Value?: unknown;
        }>;
        const baseUrl = envEntries.find((e) => e.Name === "SCHOLARS_BASE_URL");
        expect(baseUrl).toBeDefined();
        const valueJson = JSON.stringify(baseUrl?.Value ?? {});
        expect(valueJson).toContain("http://");
        expect(valueJson).toContain("Sps-App-prod-InternalAlbDns");
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

    it("excludes etl:infoed from the staging nightly cadence (10.20.91.8 CIDR overlap; docs/etl-vpc-migration-handoff.md), while prod keeps it", () => {
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

    it("staging EventBridge rules ship enabled (etlSchedulesEnabled + reconcileScheduleEnabled + cdnReconcileScheduleEnabled + curationBackupScheduleEnabled + edEmailVisibilityBridgeEnabled all true)", () => {
      const rules = template.findResources("AWS::Events::Rule");
      // 3 cadence rules + the #595 heartbeat rule + the #393 reconciler rule +
      // the #353 cdn reconciler rule + the #1032 curated-tables backup rule +
      // the #443 ED email-visibility bridge rule; all enabled in staging.
      expect(Object.keys(rules)).toHaveLength(8);
      for (const [id, rule] of Object.entries(rules)) {
        const state = rule.Properties?.State as string | undefined;
        expect({ id, state }).toEqual({ id, state: "ENABLED" });
      }
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
});
