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
] as const;

// IAM-based sources read these as plaintext config from the environment
// block (values mirror the source-script defaults).
const EXPECTED_ENV_CONFIG: Readonly<Record<string, string>> = {
  SCHOLARS_DYNAMODB_TABLE: "reciterai",
  ARTIFACTS_BUCKET: "wcmc-reciterai-artifacts",
  ARTIFACT_PREFIX: "spotlight",
  HIERARCHY_BUCKET: "wcmc-reciterai-hierarchy",
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
      it("creates three state machines, three EventBridge rules, one SNS topic", () => {
        template.resourceCountIs("AWS::StepFunctions::StateMachine", 3);
        template.resourceCountIs("AWS::Events::Rule", 3);
        template.resourceCountIs("AWS::SNS::Topic", 1);
      });

      it("creates exactly five CloudWatch alarms (3 status + nightly/weekly cadence; annual has no cadence alarm)", () => {
        template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
      });

      it("creates one ECS task definition and one SG-to-SG ingress rule on the internal ALB SG", () => {
        template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
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

      it("prod schedules ship disabled (etlSchedulesEnabled=false)", () => {
        const rules = template.findResources("AWS::Events::Rule");
        for (const [id, rule] of Object.entries(rules)) {
          const state = rule.Properties?.State as string | undefined;
          // CDK serializes enabled=false as State=DISABLED.
          expect({ id, state }).toEqual({ id, state: "DISABLED" });
        }
      });
    });

    describe("Alarms (D4 -- ExecutionsFailed sum>0 + ExecutionsStarted sum<1)", () => {
      it("every alarm publishes to the etl-failures-${env} SNS topic", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        expect(Object.keys(alarms)).toHaveLength(5);
        for (const [id, alarm] of Object.entries(alarms)) {
          const actions = (alarm.Properties?.AlarmActions ?? []) as unknown[];
          expect({ id, hasAction: actions.length > 0 }).toEqual({
            id,
            hasAction: true,
          });
        }
      });

      it("status alarms watch ExecutionsFailed sum > 0", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        const statusAlarms = Object.values(alarms).filter((a) => {
          const name = a.Properties?.AlarmName as string | undefined;
          return typeof name === "string" && name.includes("-status-");
        });
        expect(statusAlarms).toHaveLength(3);
        for (const a of statusAlarms) {
          expect(a.Properties?.MetricName).toBe("ExecutionsFailed");
          expect(a.Properties?.Statistic).toBe("Sum");
          expect(a.Properties?.ComparisonOperator).toBe(
            "GreaterThanThreshold",
          );
          expect(a.Properties?.Threshold).toBe(0);
        }
      });

      it("cadence alarms watch ExecutionsStarted sum < 1 with treatMissingData=breaching (nightly + weekly only)", () => {
        const alarms = template.findResources("AWS::CloudWatch::Alarm");
        const cadenceAlarms = Object.entries(alarms).filter(([, a]) => {
          const name = a.Properties?.AlarmName as string | undefined;
          return typeof name === "string" && name.includes("-cadence-");
        });
        // Annual has no cadence alarm -- CloudWatch can't express a yearly
        // no-execution window (see EtlStack alarm note + the guard below).
        expect(cadenceAlarms).toHaveLength(2);
        const labels = cadenceAlarms
          .map(([, a]) => a.Properties?.AlarmName as string)
          .sort();
        expect(labels).toEqual([
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

    describe("IAM least-privilege guards", () => {
      it("the task-execution role's secretsmanager:GetSecretValue lists exactly the 8 consumer ARNs (no *)", () => {
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
        // 5 credentialed sources + db/etl + opensearch/etl + revalidate-token
        // = 8. The dynamodb/spotlight/hierarchy sources are IAM-based (task
        // role) and read no injected secret, so they are absent (#442).
        expect(resourceList).toHaveLength(8);
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
        const tds = template.findResources("AWS::ECS::TaskDefinition");
        expect(Object.keys(tds)).toHaveLength(1);
        const td = Object.values(tds)[0];
        const container = (
          td.Properties?.ContainerDefinitions as
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

    it("staging EventBridge rules ship enabled (etlSchedulesEnabled=true)", () => {
      const rules = template.findResources("AWS::Events::Rule");
      expect(Object.keys(rules)).toHaveLength(3);
      for (const [id, rule] of Object.entries(rules)) {
        const state = rule.Properties?.State as string | undefined;
        expect({ id, state }).toEqual({ id, state: "ENABLED" });
      }
    });

    it("staging task definition uses 1024 cpu / 2048 MiB", () => {
      const tds = template.findResources("AWS::ECS::TaskDefinition");
      expect(Object.keys(tds)).toHaveLength(1);
      const td = Object.values(tds)[0];
      expect(td.Properties?.Cpu).toBe("1024");
      expect(td.Properties?.Memory).toBe("2048");
    });

    it("uses 30-day log retention for staging", () => {
      const groups = template.findResources("AWS::Logs::LogGroup");
      for (const resource of Object.values(groups)) {
        expect(resource.Properties?.RetentionInDays).toBe(30);
      }
    });
  });
});
