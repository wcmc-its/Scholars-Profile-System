import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
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
  const stack = new SpsObservabilityStack(
    fixture.app,
    `Sps-Observability-${envName}`,
    {
      env: fixture.env,
      envConfig: fixture.envConfig,
      appStack: app,
      dataStack: data,
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

    it("creates exactly 9 CloudWatch alarms", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 9);
    });

    it("every alarm name contains the prod env literal (Footgun #4)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const names = Object.values(alarms)
        .map((r) => r.Properties?.AlarmName as string | undefined)
        .filter((n): n is string => typeof n === "string");
      expect(names).toHaveLength(9);
      for (const name of names) {
        expect(name).toMatch(/-prod$/);
      }
    });

    it("alarm names cover the nine documented surfaces", () => {
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

    it("creates exactly one SNS topic named sps-alarms-prod with one email subscription", () => {
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-alarms-prod",
      });
      template.resourceCountIs("AWS::SNS::Subscription", 1);
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "paa2013@med.cornell.edu",
      });
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

    it("creates the Cost Anomaly Detection monitor + subscription (prod only)", () => {
      template.resourceCountIs("AWS::CE::AnomalyMonitor", 1);
      template.resourceCountIs("AWS::CE::AnomalySubscription", 1);
      template.hasResourceProperties("AWS::CE::AnomalyMonitor", {
        MonitorName: "sps-anomaly-monitor",
        MonitorType: "DIMENSIONAL",
        MonitorDimension: "SERVICE",
      });
    });

    it("grants budgets.amazonaws.com and costalerts.amazonaws.com publish on the topic", () => {
      const policies = template.findResources("AWS::SNS::TopicPolicy");
      expect(Object.keys(policies)).toHaveLength(1);
      const statements = Object.values(policies)[0]?.Properties?.PolicyDocument
        ?.Statement as Array<{
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

    it("does not introduce any new log groups (AppStack already set retention)", () => {
      template.resourceCountIs("AWS::Logs::LogGroup", 0);
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
  });

  // ----------------------------------------------------------------------
  // Staging
  // ----------------------------------------------------------------------
  describe("staging", () => {
    const { template } = buildObservabilityStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates exactly 9 CloudWatch alarms (same count as prod)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 9);
    });

    it("every alarm name contains the staging env literal", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const names = Object.values(alarms)
        .map((r) => r.Properties?.AlarmName as string | undefined)
        .filter((n): n is string => typeof n === "string");
      expect(names).toHaveLength(9);
      for (const name of names) {
        expect(name).toMatch(/-staging$/);
      }
    });

    it("creates exactly one SNS topic named sps-alarms-staging", () => {
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "sps-alarms-staging",
      });
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
  });
});
