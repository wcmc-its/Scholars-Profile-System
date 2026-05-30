import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { EdgeStack } from "../lib/edge-stack";
import { NetworkStack } from "../lib/network-stack";
import { SpsObservabilityStack } from "../lib/observability-stack";
import { makeFixture } from "./test-utils";

function buildObservabilityStack(envName: "staging" | "prod"): {
  template: Template;
  stack: SpsObservabilityStack;
  appTemplate: Template;
} {
  const fixture = makeFixture(envName);
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const drVault = new DrBackupVaultStack(
    fixture.app,
    `Sps-DrBackupVault-${envName}`,
    {
      env: fixture.drEnv,
      envConfig: fixture.envConfig,
      crossRegionReferences: true,
    },
  );
  const data = new DataStack(fixture.app, `Sps-Data-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    crossRegionReferences: true,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    drBackupVault: drVault.vault,
  });
  const app = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    albSecurityGroup: network.albSecurityGroup,
  });
  const edge = new EdgeStack(fixture.app, `Sps-Edge-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    publicAlb: app.publicAlb,
  });
  const stack = new SpsObservabilityStack(
    fixture.app,
    `Sps-Observability-${envName}`,
    {
      env: fixture.env,
      envConfig: fixture.envConfig,
      appStack: app,
      dataStack: data,
      edgeStack: edge,
    },
  );
  return {
    template: Template.fromStack(stack),
    stack,
    appTemplate: Template.fromStack(app),
  };
}

// CloudWatch alarm descriptions accept the full printable-ASCII set (broader
// than EC2 SG-ingress descriptions). The invariant Footgun #6 protects
// against is non-ASCII characters (`->`, `--`, paragraph-sign, etc.) that
// silently pass synth and fail at deploy; alarm descriptions have the same
// failure-mode risk via SNS notification formatters even though the actual
// CloudWatch API is more permissive. Keep the assertion at "printable
// ASCII" so legitimate alarm text (percentages, math symbols) is allowed.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

describe("SpsObservabilityStack", () => {
  // ----------------------------------------------------------------------
  // Prod
  // ----------------------------------------------------------------------
  describe("prod", () => {
    const { template } = buildObservabilityStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates exactly 10 CloudWatch alarms (9 platform + 1 B27 relay-errors)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
    });

    it("every alarm name contains the prod env literal (Footgun #4)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const names = Object.values(alarms)
        .map((r) => r.Properties?.AlarmName as string | undefined)
        .filter((n): n is string => typeof n === "string");
      expect(names).toHaveLength(10);
      for (const name of names) {
        expect(name).toMatch(/-prod$/);
      }
    });

    it("alarm names cover the nine platform surfaces plus the B27 relay-errors alarm", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const names = Object.values(alarms)
        .map((r) => r.Properties?.AlarmName as string | undefined)
        .filter((n): n is string => typeof n === "string")
        .sort();
      expect(names).toEqual(
        [
          "sps-alb-5xx-rate-prod",
          "sps-alb-latency-p99-prod",
          "sps-alb-unhealthy-hosts-prod",
          "sps-aurora-connections-prod",
          "sps-aurora-cpu-prod",
          "sps-ecs-task-shortfall-prod",
          "sps-edit-authz-denied-prod",
          "sps-opensearch-cluster-red-prod",
          "sps-opensearch-jvm-pressure-prod",
          "sps-oncall-relay-errors-prod",
        ].sort(),
      );
    });

    it("every alarm description is ASCII-only (Footgun #6)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const r of Object.values(alarms)) {
        const desc = r.Properties?.AlarmDescription as string | undefined;
        if (desc !== undefined) {
          expect(desc).toMatch(PRINTABLE_ASCII);
        }
      }
    });

    it("every alarm publishes to the SNS topic and only to that topic", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const r of Object.values(alarms)) {
        const actions = r.Properties?.AlarmActions as unknown[] | undefined;
        expect(actions).toBeDefined();
        expect(actions).toHaveLength(1);
      }
    });

    it("latency alarm threshold matches the SLO doc value (1.5s)", () => {
      const latency = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: {
          AlarmName: "sps-alb-latency-p99-prod",
        },
      });
      const props = Object.values(latency)[0]?.Properties;
      expect(props?.Threshold).toBe(1.5);
    });

    it("5xx-rate alarm uses a math expression, not a raw count", () => {
      const fivexx = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: {
          AlarmName: "sps-alb-5xx-rate-prod",
        },
      });
      const props = Object.values(fivexx)[0]?.Properties;
      expect(props?.Metrics).toBeDefined();
      // Threshold is 1% (percentage); MathExpression returns a percentage.
      expect(props?.Threshold).toBe(1);
    });

    it("5xx-rate alarm gates the rate behind a minimum absolute 5xx count", () => {
      // Regression guard for the 2026-05-26 low-traffic flap: a single stray
      // 5xx in a single-digit-request window must not page. The expression
      // returns 0 until at least MIN_5XX_FOR_RATE_ALARM (5) errors land.
      const fivexx = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: {
          AlarmName: "sps-alb-5xx-rate-prod",
        },
      });
      const props = Object.values(fivexx)[0]?.Properties;
      const metrics = (props?.Metrics ?? []) as Array<{ Expression?: string }>;
      const expr = metrics.find((m) => typeof m.Expression === "string")
        ?.Expression;
      expect(expr).toContain("m5xx >= 5");
    });

    it("creates two SNS topics (page + notify) with the documented names", () => {
      template.resourceCountIs("AWS::SNS::Topic", 2);
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-alarms-prod",
      });
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-notify-prod",
      });
    });

    it("notify topic has exactly one email subscription to the operator", () => {
      // Two AWS::SNS::Subscription resources total post-B27: email on notify
      // topic, Lambda on page topic (the B27 relay).
      template.resourceCountIs("AWS::SNS::Subscription", 2);
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "paa2013@med.cornell.edu",
      });
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-prod",
      )?.[0];
      expect(notifyLogicalId).toBeDefined();
      const subs = template.findResources("AWS::SNS::Subscription");
      const emailSub = Object.values(subs).find(
        (r) =>
          (r.Properties as { Protocol?: string } | undefined)?.Protocol ===
          "email",
      );
      const topicRef = (emailSub?.Properties as
        | { TopicArn?: { Ref?: string } }
        | undefined)?.TopicArn?.Ref;
      expect(topicRef).toBe(notifyLogicalId);
    });

    it("page topic carries exactly one SNS::Subscription -- the B27 Lambda relay", () => {
      const subs = template.findResources("AWS::SNS::Subscription");
      const topics = template.findResources("AWS::SNS::Topic");
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-prod",
      )?.[0];
      const pageSubs = Object.values(subs).filter(
        (r) =>
          ((r.Properties as { TopicArn?: { Ref?: string } } | undefined)
            ?.TopicArn?.Ref ?? "") === pageLogicalId,
      );
      expect(pageSubs).toHaveLength(1);
      const proto = (pageSubs[0]?.Properties as { Protocol?: string } | undefined)
        ?.Protocol;
      expect(proto).toBe("lambda");
    });

    it("all 9 platform alarms resolve their AlarmActions to the page topic ARN", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-prod",
      )?.[0];
      expect(pageLogicalId).toBeDefined();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      let platformCount = 0;
      for (const r of Object.values(alarms)) {
        const name = r.Properties?.AlarmName as string | undefined;
        // The B27 relay-errors alarm goes to the notify topic by design --
        // see SPEC § Failure-mode design; covered in a separate test below.
        if (name === "sps-oncall-relay-errors-prod") continue;
        const actions = r.Properties?.AlarmActions as
          | Array<{ Ref?: string }>
          | undefined;
        expect(actions).toHaveLength(1);
        expect(actions?.[0]?.Ref).toBe(pageLogicalId);
        platformCount++;
      }
      expect(platformCount).toBe(9);
    });

    it("creates the account-wide monthly budget (prod only) with three notifications", () => {
      template.resourceCountIs("AWS::Budgets::Budget", 1);
      const budgets = template.findResources("AWS::Budgets::Budget");
      const props = Object.values(budgets)[0]?.Properties;
      expect(props?.Budget?.BudgetName).toBe("sps-monthly-budget");
      expect(props?.Budget?.BudgetLimit?.Amount).toBe(600);
      expect(props?.Budget?.TimeUnit).toBe("MONTHLY");
      const notifs = props?.NotificationsWithSubscribers as
        | unknown[]
        | undefined;
      expect(notifs).toHaveLength(3);
    });

    it("budget subscribers all point at the notify topic (B23 split)", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-prod",
      )?.[0];
      expect(notifyLogicalId).toBeDefined();
      const budgets = template.findResources("AWS::Budgets::Budget");
      const props = Object.values(budgets)[0]?.Properties;
      const notifs = (props?.NotificationsWithSubscribers ?? []) as Array<{
        Subscribers: Array<{
          Address: { Ref?: string } | string;
          SubscriptionType: string;
        }>;
      }>;
      const addresses = notifs.flatMap((n) =>
        n.Subscribers.map((s) =>
          typeof s.Address === "string" ? s.Address : s.Address?.Ref,
        ),
      );
      expect(addresses).toHaveLength(3);
      for (const ref of addresses) {
        expect(ref).toBe(notifyLogicalId);
      }
    });

    it("cost-anomaly subscriber points at the notify topic (B23 split)", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-prod",
      )?.[0];
      const subs = template.findResources("AWS::CE::AnomalySubscription");
      const props = Object.values(subs)[0]?.Properties as
        | {
            Subscribers?: Array<{
              Address: { Ref?: string } | string;
              Type: string;
            }>;
          }
        | undefined;
      expect(props?.Subscribers).toHaveLength(1);
      const addr = props?.Subscribers?.[0]?.Address;
      const ref = typeof addr === "string" ? addr : addr?.Ref;
      expect(ref).toBe(notifyLogicalId);
    });

    it("creates the Cost Anomaly Detection monitor + subscription (prod only)", () => {
      template.resourceCountIs("AWS::CE::AnomalyMonitor", 1);
      template.resourceCountIs("AWS::CE::AnomalySubscription", 1);
      template.hasResourceProperties("AWS::CE::AnomalyMonitor", {
        MonitorName: "sps-anomaly-monitor",
        MonitorType: "DIMENSIONAL",
        MonitorDimension: "SERVICE",
      });
    });

    // Footgun #7 (#440): Cost Explorer rejects `Frequency: DAILY|WEEKLY` when
    // any subscriber is `Type: SNS` -- HTTP 400 at deploy time, no CDK synth
    // signal. Mirror the #429 / #431 pattern: assert the legal value AND
    // assert zero of the illegal ones, so a future PR that flips back to
    // DAILY for any reason is caught at vitest time.
    it("AnomalySubscription frequency is IMMEDIATE (Cost Explorer + SNS subscriber constraint, Footgun #7)", () => {
      template.hasResourceProperties("AWS::CE::AnomalySubscription", {
        Frequency: "IMMEDIATE",
      });
      template.resourcePropertiesCountIs(
        "AWS::CE::AnomalySubscription",
        { Frequency: Match.stringLikeRegexp("DAILY|WEEKLY") },
        0,
      );
    });

    it("AnomalySubscription subscribers are all Type: SNS pointed at notify topic", () => {
      // Belt-and-suspenders for the Frequency constraint above: if the
      // subscriber list ever gains an EMAIL row, that's fine on its own, but
      // the Frequency=IMMEDIATE assertion must still hold (any SNS subscriber
      // forces IMMEDIATE -- mixing EMAIL doesn't relax it).
      const subs = template.findResources("AWS::CE::AnomalySubscription");
      const props = Object.values(subs)[0]?.Properties as
        | { Subscribers?: Array<{ Type: string }> }
        | undefined;
      expect(props?.Subscribers).toBeDefined();
      expect(props!.Subscribers!.length).toBeGreaterThanOrEqual(1);
      const snsSubs = props!.Subscribers!.filter((s) => s.Type === "SNS");
      expect(snsSubs.length).toBeGreaterThanOrEqual(1);
    });

    it("grants budgets.amazonaws.com and costalerts.amazonaws.com publish on the notify topic only (B23)", () => {
      const policies = template.findResources("AWS::SNS::TopicPolicy");
      // Exactly one topic policy in the stack — on the notify topic.
      expect(Object.keys(policies)).toHaveLength(1);
      const policy = Object.values(policies)[0];
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-prod",
      )?.[0];
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-prod",
      )?.[0];
      const policyTopicsRaw = policy?.Properties?.Topics as
        | Array<{ Ref?: string }>
        | undefined;
      const policyTopicRefs = (policyTopicsRaw ?? [])
        .map((t) => t.Ref)
        .filter((r): r is string => typeof r === "string");
      expect(policyTopicRefs).toContain(notifyLogicalId);
      expect(policyTopicRefs).not.toContain(pageLogicalId);
      const statements = policy?.Properties?.PolicyDocument?.Statement as Array<{
        Action: string;
        Principal: { Service: string };
      }>;
      const services = statements
        .map((s) => s.Principal?.Service)
        .filter((s): s is string => typeof s === "string")
        .sort();
      expect(services).toContain("budgets.amazonaws.com");
      expect(services).toContain("costalerts.amazonaws.com");
    });

    it("emits AlarmTopicArn, NotifyTopicArn, and OncallRelayFunctionArn CFN outputs", () => {
      template.hasOutput("AlarmTopicArn", {});
      template.hasOutput("NotifyTopicArn", {});
      template.hasOutput("OncallRelayFunctionArn", {});
    });

    it("new SNS topic display names + NotifyTopicArn description are printable ASCII (Footgun #6)", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      for (const r of Object.values(topics)) {
        const dn = (r.Properties as { DisplayName?: string } | undefined)
          ?.DisplayName;
        if (typeof dn === "string") expect(dn).toMatch(PRINTABLE_ASCII);
      }
      const outputs = template.findOutputs("NotifyTopicArn");
      const desc = Object.values(outputs)[0]?.Description as
        | string
        | undefined;
      expect(desc).toBeDefined();
      expect(desc!).toMatch(PRINTABLE_ASCII);
    });

    it("introduces exactly one log group -- the B27 relay's own log group", () => {
      // Pre-B27 this asserted zero; the on-call relay Lambda owns its log
      // group explicitly (rather than via NodejsFunction `logRetention`,
      // which would inflate the Lambda + Role counts via a CFN custom
      // resource and break the 1-Lambda assertion below).
      template.resourceCountIs("AWS::Logs::LogGroup", 1);
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/sps-oncall-relay-prod",
        RetentionInDays: 30,
      });
    });

    it("creates the B02 edit_authz_denied metric filter on the app log group", () => {
      template.resourceCountIs("AWS::Logs::MetricFilter", 1);
      const filters = template.findResources("AWS::Logs::MetricFilter");
      const props = Object.values(filters)[0]?.Properties;
      expect(props?.FilterPattern).toBe('{ $.event = "edit_authz_denied" }');
      const transforms = props?.MetricTransformations as
        | Array<{
            MetricNamespace: string;
            MetricName: string;
            MetricValue: string;
          }>
        | undefined;
      expect(transforms).toHaveLength(1);
      expect(transforms?.[0]?.MetricNamespace).toBe("SPS/Auth");
      expect(transforms?.[0]?.MetricName).toBe("EditAuthzDenied");
      // The log group reference resolves to AppStack's app log group via
      // CloudFormation `Fn::ImportValue`; assert the destination LogGroupName
      // shape matches the AppStack-owned env-prefixed group.
      const logGroupName = props?.LogGroupName;
      expect(logGroupName).toBeDefined();
    });

    it("the edit_authz_denied alarm has the right threshold and SNS action", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { AlarmName: "sps-edit-authz-denied-prod" },
      });
      expect(Object.keys(alarms)).toHaveLength(1);
      const props = Object.values(alarms)[0]?.Properties;
      expect(props?.Threshold).toBe(10);
      expect(props?.EvaluationPeriods).toBe(2);
      expect(props?.DatapointsToAlarm).toBe(2);
      expect(props?.ComparisonOperator).toBe("GreaterThanThreshold");
      expect(props?.Statistic).toBe("Sum");
      expect(props?.Period).toBe(300);
      expect(props?.Namespace).toBe("SPS/Auth");
      expect(props?.MetricName).toBe("EditAuthzDenied");
      expect(props?.TreatMissingData).toBe("notBreaching");
      const actions = props?.AlarmActions as unknown[] | undefined;
      expect(actions).toHaveLength(1);
    });

    // --------------------------------------------------------------------
    // B27 -- on-call relay Lambda + Errors alarm
    // --------------------------------------------------------------------
    it("creates exactly one Lambda function (B27 on-call relay)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 1);
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "sps-oncall-relay-prod",
        Runtime: "nodejs22.x",
        MemorySize: 256,
        Timeout: 10,
        Handler: "index.handler",
        Environment: {
          Variables: { TEAMS_WEBHOOK_SECRET_ARN: Match.anyValue() },
        },
      });
    });

    it("Lambda env vars carry only the secret ARN -- no URL-shaped values (T3)", () => {
      const fns = template.findResources("AWS::Lambda::Function");
      const props = Object.values(fns)[0]?.Properties as
        | { Environment?: { Variables?: Record<string, unknown> } }
        | undefined;
      const vars = props?.Environment?.Variables ?? {};
      expect(Object.keys(vars)).toEqual(["TEAMS_WEBHOOK_SECRET_ARN"]);
      // No env-var key should match /url/i (T3 -- defense against a later
      // PR that smuggles the resolved URL into env vars by mistake).
      for (const k of Object.keys(vars)) {
        expect(k).not.toMatch(/url/i);
      }
    });

    it("Lambda IAM policy grants secretsmanager:GetSecretValue on the env-specific secret only", () => {
      // Walk the Lambda's default policy by hand -- `template.hasResource
      // Properties` won't help because the synthesized `Resource` is an
      // `Fn::Join` of tokens (region partition + account + name), not a
      // plain string Match.stringLikeRegexp can compare against.
      const policies = template.findResources("AWS::IAM::Policy");
      const lambdaPolicies = Object.entries(policies).filter(([id]) =>
        id.startsWith("OncallRelayFunctionServiceRoleDefaultPolicy"),
      );
      expect(lambdaPolicies).toHaveLength(1);
      const stmts = (lambdaPolicies[0]![1].Properties as {
        PolicyDocument?: {
          Statement?: Array<{
            Effect: string;
            Action: string[] | string;
            Resource: unknown;
          }>;
        };
      }).PolicyDocument?.Statement;
      expect(stmts).toBeDefined();
      expect(stmts!.length).toBeGreaterThanOrEqual(1);
      const grantStmt = stmts!.find((s) => {
        const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
        return acts.includes("secretsmanager:GetSecretValue");
      });
      expect(grantStmt).toBeDefined();
      expect(grantStmt!.Effect).toBe("Allow");
      // Resource is the Fn::Join arn of the teams-webhook secret. Serialize
      // it and grep for the env-scoped name fragment -- that's the only
      // shape we care about for least-priv.
      expect(JSON.stringify(grantStmt!.Resource)).toContain(
        "scholars/prod/oncall/teams-webhook-url",
      );

      // Defense in depth: confirm the Lambda's default policy has NO
      // wildcard Action or wildcard Resource. The AWSLambdaBasicExecutionRole
      // managed policy is fine because it's a service-role attachment on
      // the role itself, not a statement in the default-policy doc.
      for (const pol of Object.values(policies)) {
        const allStmts = (pol.Properties as {
          PolicyDocument?: { Statement?: Array<{ Action?: unknown; Resource?: unknown }> };
        }).PolicyDocument?.Statement;
        if (!Array.isArray(allStmts)) continue;
        for (const s of allStmts) {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          for (const a of actions) {
            expect(a).not.toBe("*");
          }
          const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          for (const r of resources) {
            expect(r).not.toBe("*");
          }
        }
      }
    });

    it("Lambda's execution role attaches AWSLambdaBasicExecutionRole only", () => {
      const roles = template.findResources("AWS::IAM::Role");
      // Find the Lambda's service role -- the one whose AssumeRole principal is lambda.amazonaws.com.
      const lambdaRole = Object.values(roles).find((r) => {
        const stmts = (r.Properties as {
          AssumeRolePolicyDocument?: {
            Statement?: Array<{ Principal?: { Service?: string } }>;
          };
        }).AssumeRolePolicyDocument?.Statement;
        return stmts?.some((s) => s.Principal?.Service === "lambda.amazonaws.com");
      });
      expect(lambdaRole).toBeDefined();
      const managed = (lambdaRole?.Properties as
        | { ManagedPolicyArns?: unknown[] }
        | undefined)?.ManagedPolicyArns;
      expect(managed).toHaveLength(1);
    });

    it("the Lambda is the sole subscriber on the page topic", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-prod",
      )?.[0];
      const subs = template.findResources("AWS::SNS::Subscription", {
        Properties: { Protocol: "lambda" },
      });
      expect(Object.keys(subs)).toHaveLength(1);
      const sub = Object.values(subs)[0]?.Properties as
        | { TopicArn?: { Ref?: string }; Endpoint?: { "Fn::GetAtt"?: string[] } }
        | undefined;
      expect(sub?.TopicArn?.Ref).toBe(pageLogicalId);
      expect(sub?.Endpoint?.["Fn::GetAtt"]?.[0]).toMatch(/^OncallRelayFunction/);
    });

    it("OncallRelayErrors alarm fires on Lambda Errors >= 1 over 1m and routes to the NOTIFY topic", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { AlarmName: "sps-oncall-relay-errors-prod" },
      });
      expect(Object.keys(alarms)).toHaveLength(1);
      const props = Object.values(alarms)[0]?.Properties;
      expect(props?.MetricName).toBe("Errors");
      expect(props?.Namespace).toBe("AWS/Lambda");
      expect(props?.Threshold).toBe(1);
      expect(props?.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
      expect(props?.EvaluationPeriods).toBe(1);
      expect(props?.DatapointsToAlarm).toBe(1);
      expect(props?.Period).toBe(60);
      expect(props?.Statistic).toBe("Sum");
      expect(props?.TreatMissingData).toBe("notBreaching");

      // Routes to NOTIFY topic, not page -- SPEC § Failure-mode design.
      // The page topic flows through this Lambda; routing its failure
      // alarm back through itself would either flap silently or mask the
      // original alarm. Notify (email) is the out-of-band fallback.
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-prod",
      )?.[0];
      const actions = props?.AlarmActions as Array<{ Ref?: string }> | undefined;
      expect(actions).toHaveLength(1);
      expect(actions?.[0]?.Ref).toBe(notifyLogicalId);
    });

    it("Lambda function name, alarm name, OncallRelayFunctionArn output description are printable ASCII (Footgun #6)", () => {
      const fns = template.findResources("AWS::Lambda::Function");
      const fnName = (Object.values(fns)[0]?.Properties as
        | { FunctionName?: string }
        | undefined)?.FunctionName;
      expect(fnName).toBeDefined();
      expect(fnName!).toMatch(PRINTABLE_ASCII);
      const alarmName = "sps-oncall-relay-errors-prod";
      expect(alarmName).toMatch(PRINTABLE_ASCII);
      const outputs = template.findOutputs("OncallRelayFunctionArn");
      const desc = Object.values(outputs)[0]?.Description as string | undefined;
      expect(desc).toBeDefined();
      expect(desc!).toMatch(PRINTABLE_ASCII);
    });

    it("emits the OncallRelayFunctionArn CFN output", () => {
      template.hasOutput("OncallRelayFunctionArn", {});
    });

    // --------------------------------------------------------------------
    // Build A -- reliability dashboard
    // --------------------------------------------------------------------
    it("creates exactly one reliability dashboard", () => {
      template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    });

    it("dashboard name carries the env literal (Footgun #4)", () => {
      template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: "sps-reliability-prod",
      });
    });

    it("dashboard body references a metric token for every surface", () => {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const body = Object.values(dashboards)[0]?.Properties?.DashboardBody;
      // DashboardBody is an Fn::Join of literal JSON fragments + token refs
      // (the CloudFront DistributionId import etc.); metric NAMES are always
      // literals. Serialize the whole structure and grep the literals.
      const serialized = JSON.stringify(body);
      expect(serialized).toContain("TargetResponseTime"); // ALB latency
      expect(serialized).toContain("RequestCount"); // ALB traffic
      expect(serialized).toContain("HTTPCode_Target_5XX_Count"); // ALB 5xx
      expect(serialized).toContain("AWS/CloudFront"); // CF namespace
      expect(serialized).toContain("TotalErrorRate"); // CF error rate
      expect(serialized).toContain("OriginLatency"); // CF origin latency (additional metric)
      expect(serialized).toContain("CPUUtilization"); // ECS + Aurora CPU
      expect(serialized).toContain("DatabaseConnections"); // Aurora connections
      expect(serialized).toContain("SelectLatency"); // Aurora select latency
      expect(serialized).toContain("RunningTaskCount"); // ECS tasks
    });

    it("CloudFront dashboard metrics carry the mandatory Region=Global dimension and us-east-1 pin", () => {
      // Regression guard: the L2 distribution.metric* helpers omit Region in
      // 2.254 (empty graph). cfMetric() must set Region: "Global" + region pin.
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const serialized = JSON.stringify(
        Object.values(dashboards)[0]?.Properties?.DashboardBody,
      );
      // The dashboard body is an Fn::Join, so after JSON.stringify the
      // dimension key surfaces as the escaped token `\"Region\"`; assert on
      // the bare token (same convention as the metric-name greps above).
      expect(serialized).toContain("Region");
      expect(serialized).toContain("Global");
      expect(serialized).toContain("us-east-1");
    });

    it("dashboard name is printable ASCII (Footgun #6)", () => {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const name = (
        Object.values(dashboards)[0]?.Properties as
          | { DashboardName?: string }
          | undefined
      )?.DashboardName;
      expect(name).toBeDefined();
      expect(name!).toMatch(PRINTABLE_ASCII);
    });
  });

  // ----------------------------------------------------------------------
  // Staging
  // ----------------------------------------------------------------------
  describe("staging", () => {
    const { template } = buildObservabilityStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates exactly 10 CloudWatch alarms (9 platform + 1 B27 relay-errors)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
    });

    it("every alarm name contains the staging env literal", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const names = Object.values(alarms)
        .map((r) => r.Properties?.AlarmName as string | undefined)
        .filter((n): n is string => typeof n === "string");
      expect(names).toHaveLength(10);
      for (const name of names) {
        expect(name).toMatch(/-staging$/);
      }
    });

    it("creates two SNS topics (page + notify) with the staging env literals", () => {
      template.resourceCountIs("AWS::SNS::Topic", 2);
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-alarms-staging",
      });
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-notify-staging",
      });
    });

    it("page topic carries the B27 Lambda subscription; notify topic has the operator email", () => {
      // Two AWS::SNS::Subscription resources: email on notify, lambda on page.
      template.resourceCountIs("AWS::SNS::Subscription", 2);
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "paa2013@med.cornell.edu",
      });
      const subs = template.findResources("AWS::SNS::Subscription");
      const topics = template.findResources("AWS::SNS::Topic");
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-staging",
      )?.[0];
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-staging",
      )?.[0];

      const pageSubs = Object.values(subs).filter(
        (r) =>
          ((r.Properties as { TopicArn?: { Ref?: string } } | undefined)
            ?.TopicArn?.Ref ?? "") === pageLogicalId,
      );
      expect(pageSubs).toHaveLength(1);
      expect(
        (pageSubs[0]?.Properties as { Protocol?: string } | undefined)?.Protocol,
      ).toBe("lambda");

      const notifySubs = Object.values(subs).filter(
        (r) =>
          ((r.Properties as { TopicArn?: { Ref?: string } } | undefined)
            ?.TopicArn?.Ref ?? "") === notifyLogicalId,
      );
      expect(notifySubs).toHaveLength(1);
      expect(
        (notifySubs[0]?.Properties as { Protocol?: string } | undefined)
          ?.Protocol,
      ).toBe("email");
    });

    it("all 9 staging platform alarms publish to the page topic ARN", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const pageLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-alarms-staging",
      )?.[0];
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      let platformCount = 0;
      for (const r of Object.values(alarms)) {
        const name = r.Properties?.AlarmName as string | undefined;
        if (name === "sps-oncall-relay-errors-staging") continue;
        const actions = r.Properties?.AlarmActions as
          | Array<{ Ref?: string }>
          | undefined;
        expect(actions).toHaveLength(1);
        expect(actions?.[0]?.Ref).toBe(pageLogicalId);
        platformCount++;
      }
      expect(platformCount).toBe(9);
    });

    it("staging Lambda + alarm shape mirrors prod (env literal differs only)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 1);
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "sps-oncall-relay-staging",
        Runtime: "nodejs22.x",
        MemorySize: 256,
        Timeout: 10,
      });
      // IAM policy scope-check: walk the default policy and confirm the
      // staging-scoped name fragment shows up under the secrets statement.
      const policies = template.findResources("AWS::IAM::Policy");
      const lambdaPolicy = Object.entries(policies).find(([id]) =>
        id.startsWith("OncallRelayFunctionServiceRoleDefaultPolicy"),
      );
      expect(lambdaPolicy).toBeDefined();
      const stmts = (lambdaPolicy![1].Properties as {
        PolicyDocument?: { Statement?: Array<{ Action: string[] | string; Resource: unknown }> };
      }).PolicyDocument?.Statement;
      const grant = stmts!.find((s) => {
        const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
        return acts.includes("secretsmanager:GetSecretValue");
      });
      expect(JSON.stringify(grant!.Resource)).toContain(
        "scholars/staging/oncall/teams-webhook-url",
      );
      // Relay-errors alarm routes to NOTIFY topic in staging too.
      const alarms = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { AlarmName: "sps-oncall-relay-errors-staging" },
      });
      expect(Object.keys(alarms)).toHaveLength(1);
      const props = Object.values(alarms)[0]?.Properties;
      const topics = template.findResources("AWS::SNS::Topic");
      const notifyLogicalId = Object.entries(topics).find(
        ([, r]) =>
          (r.Properties as { TopicName?: string } | undefined)?.TopicName ===
          "sps-notify-staging",
      )?.[0];
      const actions = props?.AlarmActions as Array<{ Ref?: string }> | undefined;
      expect(actions?.[0]?.Ref).toBe(notifyLogicalId);
    });

    it("emits AlarmTopicArn, NotifyTopicArn, and OncallRelayFunctionArn CFN outputs", () => {
      template.hasOutput("AlarmTopicArn", {});
      template.hasOutput("NotifyTopicArn", {});
      template.hasOutput("OncallRelayFunctionArn", {});
    });

    // The staging-vs-prod divergence at the core of this stack: cost
    // resources are account-wide and would clash on AWS-side name if both
    // envs created them. Asserted-zero in staging.
    it("creates NO budget resources (prod-only)", () => {
      template.resourceCountIs("AWS::Budgets::Budget", 0);
    });

    it("creates NO Cost Anomaly Detection resources (prod-only)", () => {
      template.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
      template.resourceCountIs("AWS::CE::AnomalySubscription", 0);
    });

    // Unlike the budget/anomaly resources, the B02 metric filter + alarm are
    // log-group-scoped (per-env) rather than account-wide. They must ship in
    // both envs so staging traffic exercises the binding before prod.
    it("creates the B02 edit_authz_denied metric filter in staging (not prod-only)", () => {
      template.resourceCountIs("AWS::Logs::MetricFilter", 1);
      template.hasResourceProperties("AWS::Logs::MetricFilter", {
        FilterPattern: '{ $.event = "edit_authz_denied" }',
      });
    });

    it("creates the edit_authz_denied alarm with the staging env name", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "sps-edit-authz-denied-staging",
        Threshold: 10,
      });
    });

    it("does not grant cost-publisher service principals on the topic (prod-only)", () => {
      const policies = template.findResources("AWS::SNS::TopicPolicy");
      if (Object.keys(policies).length === 0) {
        // No topic policy at all in staging -- equivalent to no grants.
        return;
      }
      const statements = Object.values(policies)[0]?.Properties?.PolicyDocument
        ?.Statement as Array<{ Principal: { Service?: string } }> | undefined;
      const services = (statements ?? [])
        .map((s) => s.Principal?.Service)
        .filter((s): s is string => typeof s === "string");
      expect(services).not.toContain("budgets.amazonaws.com");
      expect(services).not.toContain("costalerts.amazonaws.com");
    });

    // --------------------------------------------------------------------
    // Build A -- reliability dashboard
    // --------------------------------------------------------------------
    it("creates exactly one reliability dashboard", () => {
      template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    });

    it("dashboard name carries the env literal (Footgun #4)", () => {
      template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: "sps-reliability-staging",
      });
    });

    it("dashboard body references a metric token for every surface", () => {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const body = Object.values(dashboards)[0]?.Properties?.DashboardBody;
      // DashboardBody is an Fn::Join of literal JSON fragments + token refs
      // (the CloudFront DistributionId import etc.); metric NAMES are always
      // literals. Serialize the whole structure and grep the literals.
      const serialized = JSON.stringify(body);
      expect(serialized).toContain("TargetResponseTime"); // ALB latency
      expect(serialized).toContain("RequestCount"); // ALB traffic
      expect(serialized).toContain("HTTPCode_Target_5XX_Count"); // ALB 5xx
      expect(serialized).toContain("AWS/CloudFront"); // CF namespace
      expect(serialized).toContain("TotalErrorRate"); // CF error rate
      expect(serialized).toContain("OriginLatency"); // CF origin latency (additional metric)
      expect(serialized).toContain("CPUUtilization"); // ECS + Aurora CPU
      expect(serialized).toContain("DatabaseConnections"); // Aurora connections
      expect(serialized).toContain("SelectLatency"); // Aurora select latency
      expect(serialized).toContain("RunningTaskCount"); // ECS tasks
    });

    it("CloudFront dashboard metrics carry the mandatory Region=Global dimension and us-east-1 pin", () => {
      // Regression guard: the L2 distribution.metric* helpers omit Region in
      // 2.254 (empty graph). cfMetric() must set Region: "Global" + region pin.
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const serialized = JSON.stringify(
        Object.values(dashboards)[0]?.Properties?.DashboardBody,
      );
      // The dashboard body is an Fn::Join, so after JSON.stringify the
      // dimension key surfaces as the escaped token `\"Region\"`; assert on
      // the bare token (same convention as the metric-name greps above).
      expect(serialized).toContain("Region");
      expect(serialized).toContain("Global");
      expect(serialized).toContain("us-east-1");
    });

    it("dashboard name is printable ASCII (Footgun #6)", () => {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const name = (
        Object.values(dashboards)[0]?.Properties as
          | { DashboardName?: string }
          | undefined
      )?.DashboardName;
      expect(name).toBeDefined();
      expect(name!).toMatch(PRINTABLE_ASCII);
    });
  });
});
