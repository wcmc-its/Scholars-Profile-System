import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture, TEST_ACCOUNT } from "./test-utils";

function buildAppStack(envName: "staging" | "prod"): {
  template: Template;
  stack: AppStack;
} {
  const fixture = makeFixture(envName);
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const stack = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    albSecurityGroup: network.albSecurityGroup,
  });
  return { template: Template.fromStack(stack), stack };
}

// The EC2 description allow-set (matches the regex documented in
// data-stack.test.ts "EC2 property character-set safety"). Re-asserted in
// this stack because Footgun #6 (PRs #401/#402) only catches at deploy
// time; the synth-time guard generalizes to every stack with SGs.
const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

describe("AppStack", () => {
  describe("prod", () => {
    const { template } = buildAppStack("prod");

    /** Inline IAM policies attached to the app TASK role (not the exec role). */
    function findTaskRolePolicies() {
      return Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => {
        const roles = p.Properties?.Roles as Array<{ Ref?: string }> | undefined;
        return roles?.some(
          (r) =>
            typeof r.Ref === "string" &&
            r.Ref.includes("TaskRole") &&
            !r.Ref.includes("TaskExecutionRole"),
        );
      });
    }

    /** The `app` container's environment as a name -> value map. */
    function appContainerEnv(): Map<string, string | undefined> {
      const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
      const appTaskDef = Object.values(taskDefs).find(
        (r) => r.Properties?.Family === "sps-app-prod",
      );
      const appContainer = (
        appTaskDef?.Properties?.ContainerDefinitions as
          | Array<{ Name?: string; Environment?: Array<{ Name?: string; Value?: string }> }>
          | undefined
      )?.find((c) => c.Name === "app");
      return new Map(
        (appContainer?.Environment ?? []).map((e) => [e.Name as string, e.Value]),
      );
    }

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    describe("Resource counts (the plan's § Acceptance criteria)", () => {
      it("creates exactly two ECR repositories (app + ETL), one ECS cluster, three task definitions, one ECS service", () => {
        // App image repo + the dedicated ETL batch-image repo (#454).
        template.resourceCountIs("AWS::ECR::Repository", 2);
        template.resourceCountIs("AWS::ECS::Cluster", 1);
        // app + migrate + db-bootstrap (#493) + verify-grants (ADR-009).
        template.resourceCountIs("AWS::ECS::TaskDefinition", 4);
        template.resourceCountIs("AWS::ECS::Service", 1);
      });

      it("creates two ALBs (one internet-facing, one internal), two target groups (one per ALB, #431 blocker #6), two listeners", () => {
        template.resourceCountIs(
          "AWS::ElasticLoadBalancingV2::LoadBalancer",
          2,
        );
        template.resourceCountIs(
          "AWS::ElasticLoadBalancingV2::TargetGroup",
          2,
        );
        template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 2);

        const lbs = template.findResources(
          "AWS::ElasticLoadBalancingV2::LoadBalancer",
        );
        const schemes = Object.values(lbs)
          .map((r) => r.Properties?.Scheme as string | undefined)
          .sort();
        expect(schemes).toEqual(["internal", "internet-facing"]);
      });

      it("creates the two task-side IAM roles plus the GitHub Actions OIDC deploy role", () => {
        // Match by role name rather than raw count: in the owner env the OIDC
        // provider custom resource adds its own Lambda execution role, and any
        // env may carry other framework-generated roles. prod imports the
        // provider (issue #491) so has no such custom-resource role, but the
        // name-based assertion holds either way.
        const roles = template.findResources("AWS::IAM::Role");
        const roleNames = Object.values(roles)
          .map((r) => r.Properties?.RoleName as string | undefined)
          .filter((n): n is string => typeof n === "string")
          .sort();
        expect(roleNames).toEqual(
          ["sps-deploy-prod", "sps-task-exec-prod", "sps-task-prod"].sort(),
        );
      });

      it("imports the account-scoped OIDC provider rather than creating it (#491)", () => {
        // prod is not the provider owner (staging is), so it must NOT create a
        // second account-scoped provider -- that fails deploy with
        // EntityAlreadyExistsException. It imports the deterministic ARN, so no
        // Custom::AWSCDKOpenIdConnectProvider resource is synthesized and the
        // deploy role federates directly to the well-known provider ARN.
        template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
        const roles = template.findResources("AWS::IAM::Role");
        const deployRole = Object.values(roles).find(
          (r) => r.Properties?.RoleName === "sps-deploy-prod",
        );
        const federated = (
          deployRole?.Properties?.AssumeRolePolicyDocument as {
            Statement?: Array<{ Principal?: { Federated?: unknown } }>;
          }
        )?.Statement?.[0]?.Principal?.Federated;
        expect(federated).toBe(
          `arn:aws:iam::${TEST_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
        );
      });

      it("creates one VPC interface endpoint (secretsmanager) and one S3 gateway endpoint", () => {
        const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
        const types = Object.values(endpoints)
          .map((r) => r.Properties?.VpcEndpointType as string | undefined)
          .sort();
        // One Interface + one Gateway.
        expect(types.filter((t) => t === "Interface")).toHaveLength(1);
        expect(types.filter((t) => t === "Gateway")).toHaveLength(1);
      });

      it("the interface-endpoint SG admits :443 from the app + ETL SGs (load-bearing for the #493 seeder)", () => {
        // Private DNS routes every in-VPC Secrets Manager call to this endpoint,
        // so a Lambda can only reach SM if its SG is admitted here on 443. The
        // #493 db-bootstrap seeder (DataStack) reuses the ETL SG precisely
        // because of this ingress -- and it cannot be given a dedicated SG, as
        // this endpoint SG lives downstream of DataStack and could not bless it.
        // If either rule is dropped, the seeder silently hangs on master read.
        const descriptions: string[] = [];
        for (const sg of Object.values(
          template.findResources("AWS::EC2::SecurityGroup"),
        )) {
          for (const r of (sg.Properties?.SecurityGroupIngress ?? []) as Array<
            Record<string, unknown>
          >) {
            if (r.FromPort === 443 && r.ToPort === 443)
              descriptions.push(String(r.Description));
          }
        }
        for (const r of Object.values(
          template.findResources("AWS::EC2::SecurityGroupIngress"),
        )) {
          const p = r.Properties ?? {};
          if (p.FromPort === 443 && p.ToPort === 443)
            descriptions.push(String(p.Description));
        }
        expect(
          descriptions.some((d) => d.includes("App SG to interface endpoints")),
        ).toBe(true);
        expect(
          descriptions.some((d) => d.includes("ETL SG to interface endpoints")),
        ).toBe(true);
      });

      it("emits no VPC endpoint with a `.es` service name (deploy-only-validation guard, #429)", () => {
        // CFN only validates VPC endpoint ServiceName strings against the
        // regional service catalog at deploy time. `com.amazonaws.<region>.es`
        // does not exist (the managed OpenSearch control-plane service is
        // `aos`), so an `es` endpoint synths cleanly and then fails the
        // stack create. Asserted at synth time so the pattern can't recur.
        //
        // Interface endpoints emit ServiceName as a literal string
        // (`com.amazonaws.us-east-1.<svc>`) because the L2 helper resolves
        // it at synth time; the L1 gateway endpoint constructs ServiceName
        // via Fn::Join against `AWS::Region`, so its match has to walk the
        // serialized intrinsic instead of a bare regex.
        template.resourcePropertiesCountIs(
          "AWS::EC2::VPCEndpoint",
          { ServiceName: Match.stringLikeRegexp("\\.es$") },
          0,
        );
        template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
          ServiceName: Match.stringLikeRegexp("\\.secretsmanager$"),
        });
        const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
        const gatewayEndpoints = Object.values(endpoints).filter(
          (r) => r.Properties?.VpcEndpointType === "Gateway",
        );
        expect(gatewayEndpoints).toHaveLength(1);
        expect(JSON.stringify(gatewayEndpoints[0]?.Properties?.ServiceName))
          .toMatch(/\.s3"\s*\]/);
      });

      it("creates exactly five CloudWatch log groups (app + migrate + db-bootstrap + verify-grants + otel-collector sidecar)", () => {
        template.resourceCountIs("AWS::Logs::LogGroup", 5);
        const groups = template.findResources("AWS::Logs::LogGroup");
        const names = Object.values(groups)
          .map((r) => r.Properties?.LogGroupName as string | undefined)
          .sort();
        expect(names).toEqual([
          "/aws/ecs/sps-app-prod",
          "/aws/ecs/sps-db-bootstrap-prod",
          "/aws/ecs/sps-migrate-prod",
          "/aws/ecs/sps-otel-prod",
          "/aws/ecs/sps-verify-grants-prod",
        ]);
      });
    });

    describe("ECR repository", () => {
      it("uses an env-prefixed name with image-scan-on-push", () => {
        template.hasResourceProperties("AWS::ECR::Repository", {
          RepositoryName: "scholars-app-prod",
          ImageScanningConfiguration: { ScanOnPush: true },
        });
      });

      it("provisions a separate ETL batch-image repo (scholars-etl-<env>) with image-scan-on-push (#454)", () => {
        template.hasResourceProperties("AWS::ECR::Repository", {
          RepositoryName: "scholars-etl-prod",
          ImageScanningConfiguration: { ScanOnPush: true },
        });
      });

      it("attaches a lifecycle policy that keeps the last 30 tagged images and expires untagged after 7 days", () => {
        const repos = template.findResources("AWS::ECR::Repository");
        const policyText = Object.values(repos)[0]?.Properties
          ?.LifecyclePolicy?.LifecyclePolicyText as string | undefined;
        expect(typeof policyText).toBe("string");
        const policy = JSON.parse(policyText ?? "{}") as {
          rules?: Array<Record<string, unknown>>;
        };
        const tagged = policy.rules?.find(
          (r) =>
            (r.selection as { tagStatus?: string } | undefined)?.tagStatus ===
            "tagged",
        );
        const untagged = policy.rules?.find(
          (r) =>
            (r.selection as { tagStatus?: string } | undefined)?.tagStatus ===
            "untagged",
        );
        expect(tagged).toBeDefined();
        expect(untagged).toBeDefined();
        expect(
          (tagged?.selection as { countNumber?: number })?.countNumber,
        ).toBe(30);
        expect(
          (untagged?.selection as { countNumber?: number })?.countNumber,
        ).toBe(7);
      });
    });

    describe("ECS service + cluster", () => {
      it("enables Container Insights on the cluster", () => {
        template.hasResourceProperties("AWS::ECS::Cluster", {
          ClusterName: "sps-cluster-prod",
          ClusterSettings: Match.arrayWith([
            Match.objectLike({
              Name: "containerInsights",
              // CDK serializes ContainerInsightsV2.ENABLED as the string
              // "enhanced" -- the new v2 form covers the legacy
              // ContainerInsights=enabled metric set plus the v2 perf
              // signals. Asserted via stringLikeRegexp so the test
              // survives a CDK rename without churn.
              Value: Match.stringLikeRegexp("enabled|enhanced"),
            }),
          ]),
        });
      });

      it("runs Fargate with desiredCount=2 (prod) and circuit-breaker rollback enabled (ADR-004)", () => {
        template.hasResourceProperties("AWS::ECS::Service", {
          ServiceName: "sps-app-prod",
          LaunchType: "FARGATE",
          DesiredCount: 2,
          DeploymentConfiguration: Match.objectLike({
            MinimumHealthyPercent: 100,
            MaximumPercent: 200,
            DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          }),
        });
      });

      it("attaches one application-autoscaling target on the ECS DesiredCount dimension, min=appDesiredCount(2) / max=appMaxCount(6) (#596)", () => {
        template.resourceCountIs(
          "AWS::ApplicationAutoScaling::ScalableTarget",
          1,
        );
        template.hasResourceProperties(
          "AWS::ApplicationAutoScaling::ScalableTarget",
          {
            ServiceNamespace: "ecs",
            ScalableDimension: "ecs:service:DesiredCount",
            MinCapacity: 2,
            MaxCapacity: 6,
          },
        );
      });

      it("scales on CPU (60%) and ALB request-count (1000/target) — both target-tracking, scale-out 60s / scale-in 300s (#596)", () => {
        // Two policies, both target-tracking, on the single scalable target.
        template.resourceCountIs(
          "AWS::ApplicationAutoScaling::ScalingPolicy",
          2,
        );
        template.hasResourceProperties(
          "AWS::ApplicationAutoScaling::ScalingPolicy",
          {
            PolicyType: "TargetTrackingScaling",
            TargetTrackingScalingPolicyConfiguration: Match.objectLike({
              PredefinedMetricSpecification: {
                PredefinedMetricType: "ECSServiceAverageCPUUtilization",
              },
              TargetValue: 60,
              ScaleOutCooldown: 60,
              ScaleInCooldown: 300,
            }),
          },
        );
        template.hasResourceProperties(
          "AWS::ApplicationAutoScaling::ScalingPolicy",
          {
            PolicyType: "TargetTrackingScaling",
            TargetTrackingScalingPolicyConfiguration: Match.objectLike({
              // ResourceLabel binds to the PUBLIC target group (origin-
              // forwarded traffic). Its value is a synth-time Fn::Join over
              // the LB + TG full names, so assert only the metric type +
              // target here, not the label internals.
              PredefinedMetricSpecification: Match.objectLike({
                PredefinedMetricType: "ALBRequestCountPerTarget",
              }),
              TargetValue: 1000,
              ScaleOutCooldown: 60,
              ScaleInCooldown: 300,
            }),
          },
        );
      });

      it("uses an env-config-valid Fargate (cpu, memory) pair on both task definitions", () => {
        // L2 helper accepts invalid (cpu, memory) combinations; AWS rejects
        // them only at run time. Lock the allowlist at synth time.
        const valid: ReadonlySet<string> = new Set([
          "256:512",
          "256:1024",
          "256:2048",
          "512:1024",
          "512:2048",
          "512:3072",
          "512:4096",
          "1024:2048",
          "1024:3072",
          "1024:4096",
          "1024:5120",
          "1024:6144",
          "1024:7168",
          "1024:8192",
          "2048:4096",
          "2048:5120",
          "2048:6144",
          "2048:7168",
          "2048:8192",
          "2048:16384",
          "4096:8192",
          "4096:16384",
          "4096:30720",
        ]);
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        for (const [id, resource] of Object.entries(taskDefs)) {
          const cpu = resource.Properties?.Cpu as string | undefined;
          const memory = resource.Properties?.Memory as string | undefined;
          const pair = `${cpu}:${memory}`;
          expect({ id, pair, ok: valid.has(pair) }).toEqual({
            id,
            pair,
            ok: true,
          });
        }
      });

      it("the ECS service DependsOn list includes both ALB listeners and the public origin-verify rule (#431 blocker #4)", () => {
        // CFN dependency-class fix: because the service is L1-attached to
        // the target group via `cfnService.loadBalancers`, CDK does NOT
        // auto-infer that the service must wait for the listeners that
        // bind the TG to a load balancer. Without an explicit DependsOn,
        // CFN parallel-creates the service with the listeners and AWS
        // rejects RegisterTargets with "target group does not have an
        // associated load balancer." Every resource that establishes a
        // TG <-> LB association must be a service dependency.
        const services = template.findResources("AWS::ECS::Service");
        const ids = Object.keys(services);
        expect(ids).toHaveLength(1);
        const dependsOn = (services[ids[0]!]?.DependsOn ?? []) as string[];
        // Internal listener (associates TG via DefaultActions).
        expect(dependsOn.some((d) => d.startsWith("InternalAlbInternalHttpListener"))).toBe(true);
        // Public listener (its child rule below carries the TG association).
        expect(dependsOn.some((d) => d.startsWith("PublicAlbPublicHttpListener"))).toBe(true);
        // The priority-1 rule that forwards public traffic to the TG.
        expect(dependsOn.some((d) => d.startsWith("OriginVerifiedForward"))).toBe(true);
      });

      it("wires the ECS service to BOTH target groups via the loadBalancers mapping (manual L1 attach)", () => {
        // The L2 attachToApplicationTargetGroup helper auto-establishes SG
        // ingress rules from each ALB SG -- with the internal ALB's SG in
        // AppStack and the app SG in NetworkStack that closes a cycle.
        // The manual L1 attach skips the auto-wire and registers the
        // running app container with both TGs (one per ALB after the
        // #431 blocker #6 split).
        const services = template.findResources("AWS::ECS::Service");
        const ids = Object.keys(services);
        expect(ids).toHaveLength(1);
        const lbs = services[ids[0]!]?.Properties?.LoadBalancers as
          | Array<Record<string, unknown>>
          | undefined;
        expect(lbs).toHaveLength(2);
        for (const lb of lbs ?? []) {
          expect(lb.ContainerName).toBe("app");
          expect(lb.ContainerPort).toBe(3000);
          expect(lb.TargetGroupArn).toBeDefined();
        }
      });
    });

    describe("Task definitions", () => {
      it("the app task definition exposes container port 3000 and wires all six secrets", () => {
        template.hasResourceProperties("AWS::ECS::TaskDefinition", {
          Family: "sps-app-prod",
          NetworkMode: "awsvpc",
          RequiresCompatibilities: ["FARGATE"],
          ContainerDefinitions: Match.arrayWith([
            Match.objectLike({
              Name: "app",
              PortMappings: Match.arrayWith([
                Match.objectLike({ ContainerPort: 3000, Protocol: "tcp" }),
              ]),
              Environment: Match.arrayWith([
                Match.objectLike({ Name: "NODE_ENV", Value: "production" }),
                Match.objectLike({ Name: "PORT", Value: "3000" }),
                // #447 -- OpenSearch endpoint imported from DataStack (value
                // is an Fn::ImportValue token, so assert on Name only).
                Match.objectLike({ Name: "OPENSEARCH_NODE" }),
              ]),
              Secrets: Match.arrayWith([
                Match.objectLike({ Name: "DATABASE_URL" }),
                Match.objectLike({ Name: "DATABASE_URL_RO" }),
                Match.objectLike({ Name: "OPENSEARCH_USER" }),
                Match.objectLike({ Name: "OPENSEARCH_PASS" }),
                // #447 -- renamed from REVALIDATE_TOKEN; the readers expect
                // SCHOLARS_REVALIDATE_TOKEN.
                Match.objectLike({ Name: "SCHOLARS_REVALIDATE_TOKEN" }),
                // #100 -- iron-session key; the /edit gate + SAML callback
                // 500 without it.
                Match.objectLike({ Name: "SESSION_COOKIE_SECRET" }),
                Match.objectLike({ Name: "SAML_SP_PRIVATE_KEY" }),
                // #466 -- the IdP signing cert is a secret (rotatable trust
                // anchor), not an env var.
                Match.objectLike({ Name: "SAML_IDP_CERT" }),
                // #466 -- the SP public cert, required for metadata generation
                // once the SP private key is configured.
                Match.objectLike({ Name: "SAML_SP_CERT" }),
              ]),
            }),
          ]),
        });
      });

      // #466 -- the four required SAML_* config vars (plus the optional
      // IdP-issuer + CWID-attribute) must be injected as ENV on the app
      // container. Missing any required one makes getSamlEnv()'s requireEnv
      // throw and every SAML route 503 ("SAML SP is not configured"), killing
      // SP-initiated sign-in. SAML_IDP_CERT is asserted in the secrets test
      // above, not here -- it is the one SAML value injected as a secret.
      it("injects the required SAML_* config env on the app container (#466)", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        expect(appTaskDef).toBeDefined();
        const appContainer = (
          appTaskDef?.Properties?.ContainerDefinitions as
            | Array<{
                Name?: string;
                Environment?: Array<{ Name?: string; Value?: string }>;
              }>
            | undefined
        )?.find((c) => c.Name === "app");
        const envByName = new Map(
          (appContainer?.Environment ?? []).map((e) => [
            e.Name as string,
            e.Value,
          ]),
        );
        // The four requireEnv vars are all present.
        for (const name of [
          "SAML_IDP_SSO_URL",
          "SAML_SP_ENTITY_ID",
          "SAML_SP_ACS_URL",
        ]) {
          expect(envByName.has(name)).toBe(true);
        }
        // IdP coordinates are the WCM prod IdP (shared across envs).
        expect(envByName.get("SAML_IDP_ENTITY_ID")).toBe(
          "https://login-proxy.weill.cornell.edu/idp",
        );
        expect(envByName.get("SAML_IDP_SSO_URL")).toBe(
          "https://login-proxy.weill.cornell.edu/idp/profile/SAML2/Redirect/SSO",
        );
        // SP entityID + ACS are the prod host; ACS route is /callback.
        expect(envByName.get("SAML_SP_ENTITY_ID")).toBe(
          "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
        );
        expect(envByName.get("SAML_SP_ACS_URL")).toBe(
          "https://scholars.weill.cornell.edu/api/auth/saml/callback",
        );
        // CWID arrives in a `CWID` attribute, not the NameID.
        expect(envByName.get("SAML_CWID_ATTRIBUTE")).toBe("CWID");
      });

      it("the migration task definition has the prisma migrate deploy entrypoint and only the writer secret", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const migrate = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-migrate-prod",
        );
        expect(migrate).toBeDefined();
        const container = (migrate?.Properties?.ContainerDefinitions as
          | Array<Record<string, unknown>>
          | undefined)?.[0];
        expect(container?.EntryPoint).toEqual([
          "npx",
          "prisma",
          "migrate",
          "deploy",
        ]);
        const secretNames = (
          container?.Secrets as Array<{ Name?: string }> | undefined
        )?.map((s) => s.Name);
        expect(secretNames).toEqual(["DATABASE_URL"]);
      });

      it("the db-bootstrap task runs the tsx runner on the ETL image with both DSNs (#493)", () => {
        // Synth-time guard (deploy-only-validation pattern): the audit-bootstrap
        // task must run scripts/db-bootstrap.ts (the ETL image is the only one
        // with tsx + the source tree + the mariadb client), and inject exactly
        // its least-priv login plus the app-rw DSN it reads to resolve the
        // grantee -- nothing more.
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const bootstrap = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-db-bootstrap-prod",
        );
        expect(bootstrap).toBeDefined();
        const container = (bootstrap?.Properties?.ContainerDefinitions as
          | Array<Record<string, unknown>>
          | undefined)?.[0];
        expect(container?.Name).toBe("db-bootstrap");
        expect(container?.EntryPoint).toEqual(["npx", "tsx", "scripts/db-bootstrap.ts"]);
        // Image comes from the ETL repo, not the app repo. The Image is a
        // Join over the ETL repo URI; assert the ETL repo logical id appears.
        expect(JSON.stringify(container?.Image)).toMatch(/EtlEcrRepository/);
        const secretNames = (
          container?.Secrets as Array<{ Name?: string }> | undefined
        )
          ?.map((s) => s.Name)
          .sort();
        expect(secretNames).toEqual(["APP_RW_DSN", "BOOTSTRAP_DSN"]);
        // Grants the audit INSERT to `'app_rw'@'%'` on prod -- prod's app user
        // is host-pattern `%` (the per-env appRwGranteeHost; #493 staging fix).
        const envByName = new Map(
          (
            (container?.Environment as
              | Array<{ Name?: string; Value?: string }>
              | undefined) ?? []
          ).map((e) => [e.Name, e.Value]),
        );
        expect(envByName.get("GRANTEE_HOST")).toBe("%");
      });

      it("the verify-grants task runs the tsx verify on the ETL image with the three Phase 0 role DSNs (ADR-009)", () => {
        // Synth-time guard (deploy-only-validation pattern): the grant-equality
        // verify runs scripts/verify-db-grants.ts on the ETL image (the only one
        // with tsx + source + the mariadb client), connects AS each role, and so
        // must inject each role's own DSN. VERIFY_ROLES pins the Phase 0 set; the
        // injected DSNs must cover exactly those roles (no silent skip).
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const verify = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-verify-grants-prod",
        );
        expect(verify).toBeDefined();
        const container = (verify?.Properties?.ContainerDefinitions as
          | Array<Record<string, unknown>>
          | undefined)?.[0];
        expect(container?.Name).toBe("verify-grants");
        expect(container?.EntryPoint).toEqual(["npx", "tsx", "scripts/verify-db-grants.ts"]);
        // ETL image, not the app image (same Join-over-ETL-repo-URI shape as
        // db-bootstrap).
        expect(JSON.stringify(container?.Image)).toMatch(/EtlEcrRepository/);
        // A DSN per role named in VERIFY_ROLES -- app-ro, app-rw, sps_bootstrap.
        const secretNames = (
          container?.Secrets as Array<{ Name?: string }> | undefined
        )
          ?.map((s) => s.Name)
          .sort();
        expect(secretNames).toEqual(["APP_RO_DSN", "APP_RW_DSN", "BOOTSTRAP_DSN"]);
        const envByName = new Map(
          (
            (container?.Environment as
              | Array<{ Name?: string; Value?: string }>
              | undefined) ?? []
          ).map((e) => [e.Name, e.Value]),
        );
        expect(envByName.get("VERIFY_ROLES")).toBe("app-ro,app-rw,sps_bootstrap");
      });
    });

    describe("IAM role split (B06)", () => {
      it("the task-execution role policy lists exactly the eleven consumer secret ARNs for secretsmanager:GetSecretValue", () => {
        // No `*` resource on secretsmanager:* (Phase 1 hard rule).
        // The eleven ARNs are scholars/prod/db/app-rw, db/app-ro,
        // opensearch/app, revalidate-token, session-cookie-key, the SAML SP
        // private key, etl/reciter (ReciterDB connection for funding/mentoring
        // surfaces), saml/idp-cert (the IdP signing-cert trust anchor, #466),
        // saml-sp/prod/cert (the SP public cert for metadata, #466),
        // db/bootstrap (the least-priv db-bootstrap login, #493), and
        // newrelic-license-key (the New Relic ingest key for the ADOT
        // collector's otlphttp/newrelic exporter, B24).
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) => typeof r.Ref === "string" && r.Ref.includes("TaskExecutionRole"),
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
        expect(resourceList).toHaveLength(11);
        // No `*` ever appears in the resource list.
        for (const r of resourceList) {
          expect(JSON.stringify(r)).not.toMatch(/^"\*"$/);
        }
      });

      it("the task role policy contains zero secretsmanager:* actions (runtime identity must not read secrets)", () => {
        // Application secrets are injected by ECS at task-start via the
        // EXECUTION role. The task role -- the role the running app
        // assumes -- must never be in a position to pull a fresh secret
        // value at runtime.
        const policies = template.findResources("AWS::IAM::Policy");
        const taskRolePolicies = Object.values(policies).filter((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" &&
              r.Ref.includes("TaskRole") &&
              !r.Ref.includes("TaskExecutionRole"),
          );
        });
        // Whatever policies are attached to the task role (X-Ray, SES, ...),
        // NONE may carry a secretsmanager action -- the running app must never
        // be able to pull a fresh secret value. Catches a secrets:* smuggle
        // before the PR lands.
        for (const policy of taskRolePolicies) {
          const serialized = JSON.stringify(policy.Properties?.PolicyDocument);
          expect(serialized).not.toMatch(/secretsmanager:/);
        }
      });

      it("the OIDC deploy role admits only the SPS repo via sub-claim StringLike", () => {
        const roles = template.findResources("AWS::IAM::Role");
        const deployRole = Object.values(roles).find(
          (r) => r.Properties?.RoleName === "sps-deploy-prod",
        );
        expect(deployRole).toBeDefined();
        const statements = deployRole?.Properties?.AssumeRolePolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const subClaim = statements?.[0]?.Condition as
          | { StringLike?: Record<string, string> }
          | undefined;
        const sub =
          subClaim?.StringLike?.["token.actions.githubusercontent.com:sub"];
        // Prod admits the `prod` GitHub Environment subject (deploy.yml's prod
        // job runs with `environment: prod`, so GitHub mints an environment-
        // scoped sub, not a ref-scoped one). The master pin lives in the prod
        // Environment's branch policy + deploy.yml's non-master guard.
        expect(sub).toBe(
          "repo:wcmc-its/Scholars-Profile-System:environment:prod",
        );
      });

      it("the OIDC deploy role policy contains no `*` Resource (every action is scoped)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const deployPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) => typeof r.Ref === "string" && r.Ref.includes("DeployRole"),
          );
        });
        expect(deployPolicy).toBeDefined();
        const statements = deployPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        // Exactly one statement is allowed to use Resource=*: the ECR
        // GetAuthorizationToken call, which is account-scoped at the API
        // level and has no resource ARN. Everything else must be a
        // concrete ARN (or Fn::Join/Ref pointing at one).
        for (const stmt of statements ?? []) {
          const action = stmt.Action as string | string[];
          const resource = stmt.Resource as unknown;
          const isAuthOnly =
            (Array.isArray(action)
              ? action.length === 1 && action[0] === "ecr:GetAuthorizationToken"
              : action === "ecr:GetAuthorizationToken");
          if (isAuthOnly) {
            continue;
          }
          // Walk the resource value; assert no bare `"*"` literal.
          const serialized = JSON.stringify(resource);
          expect(serialized).not.toMatch(/^"\*"$/);
        }
      });

      // The deploy workflow (deploy.yml) reads AppStack outputs via
      // `cloudformation:DescribeStacks` and pushes to both image repos.
      // Both grants were missing before #460, so the workflow could not
      // run end-to-end.
      const findDeployStatements = () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const deployPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) => typeof r.Ref === "string" && r.Ref.includes("DeployRole"),
          );
        });
        expect(deployPolicy).toBeDefined();
        return (deployPolicy?.Properties?.PolicyDocument?.Statement ??
          []) as Array<Record<string, unknown>>;
      };

      it("the OIDC deploy role can DescribeStacks on the AppStack only (#460)", () => {
        const statements = findDeployStatements();
        const cfn = statements.find((stmt) => {
          const action = stmt.Action as string | string[];
          return Array.isArray(action)
            ? action.includes("cloudformation:DescribeStacks")
            : action === "cloudformation:DescribeStacks";
        });
        expect(cfn).toBeDefined();
        const serialized = JSON.stringify(cfn?.Resource);
        // Scoped to this stack's ARN, not `*`.
        expect(serialized).not.toMatch(/^"\*"$/);
        expect(serialized).toContain("stack/Sps-App-prod/*");
      });

      it("the OIDC deploy role can push to both the app and ETL ECR repos (#460/#454)", () => {
        const statements = findDeployStatements();
        const push = statements.find((stmt) => {
          const action = stmt.Action as string | string[];
          return Array.isArray(action) && action.includes("ecr:PutImage");
        });
        expect(push).toBeDefined();
        const serialized = JSON.stringify(push?.Resource);
        expect(serialized).toContain("EcrRepository");
        expect(serialized).toContain("EtlEcrRepository");
      });

      it("the OIDC deploy role can RunTask on the migrate, db-bootstrap and verify-grants families (#493 / ADR-009)", () => {
        // The workflow runs db-bootstrap -> verify-grants -> migrate; the deploy
        // role must be scoped to all three task-definition families and no
        // broader `*`.
        const statements = findDeployStatements();
        const runTask = statements.find((stmt) => {
          const action = stmt.Action as string | string[];
          return Array.isArray(action)
            ? action.includes("ecs:RunTask")
            : action === "ecs:RunTask";
        });
        expect(runTask).toBeDefined();
        const serialized = JSON.stringify(runTask?.Resource);
        expect(serialized).not.toMatch(/^"\*"$/);
        expect(serialized).toContain("sps-migrate-prod:*");
        expect(serialized).toContain("sps-db-bootstrap-prod:*");
        expect(serialized).toContain("sps-verify-grants-prod:*");
      });
    });

    describe("Load balancers + target group", () => {
      it("the public ALB is internet-facing with an env-prefixed name", () => {
        const lbs = template.findResources(
          "AWS::ElasticLoadBalancingV2::LoadBalancer",
        );
        const publicLb = Object.values(lbs).find(
          (r) => r.Properties?.Scheme === "internet-facing",
        );
        expect(publicLb).toBeDefined();
        expect(publicLb?.Properties?.Name).toBe("sps-public-prod");
      });

      it("the internal ALB is scheme=internal with an env-prefixed name", () => {
        const lbs = template.findResources(
          "AWS::ElasticLoadBalancingV2::LoadBalancer",
        );
        const internalLb = Object.values(lbs).find(
          (r) => r.Properties?.Scheme === "internal",
        );
        expect(internalLb).toBeDefined();
        expect(internalLb?.Properties?.Name).toBe("sps-internal-prod");
      });

      it("both target groups use the literal /api/health (PR #407) and a 30-second deregistration delay", () => {
        for (const name of ["sps-tg-pub-prod", "sps-tg-int-prod"]) {
          template.hasResourceProperties(
            "AWS::ElasticLoadBalancingV2::TargetGroup",
            {
              Name: name,
              Port: 3000,
              Protocol: "HTTP",
              TargetType: "ip",
              HealthCheckPath: "/api/health",
              HealthyThresholdCount: 2,
              TargetGroupAttributes: Match.arrayWith([
                Match.objectLike({
                  Key: "deregistration_delay.timeout_seconds",
                  Value: "30",
                }),
              ]),
            },
          );
        }
      });

      it("the public ALB listener is HTTP-only :80 (HTTPS lands in B07+B14)", () => {
        const listeners = template.findResources(
          "AWS::ElasticLoadBalancingV2::Listener",
        );
        const protocols = Object.values(listeners).map(
          (r) => r.Properties?.Protocol as string,
        );
        expect(protocols.every((p) => p === "HTTP")).toBe(true);
        const ports = Object.values(listeners).map(
          (r) => r.Properties?.Port as number,
        );
        expect(ports).toEqual([80, 80]);
      });

      it("the public ALB listener default action is a bare 403 (B07 origin-verify deny-by-default)", () => {
        // The PublicHttpListener default action is a fixed-response 403:
        // requests that arrive without the CloudFront-injected
        // X-Origin-Verify header are rejected at the ALB. The internal
        // listener still default-forwards to the target group (only the
        // ETL Lambda SG can reach it -- the perimeter is the SG, not the
        // header).
        const listeners = template.findResources(
          "AWS::ElasticLoadBalancingV2::Listener",
        );
        // Find the listener whose default action is fixed-response.
        const publicListener = Object.values(listeners).find((r) => {
          const actions = r.Properties?.DefaultActions as
            | Array<{ Type?: string }>
            | undefined;
          return actions?.some((a) => a.Type === "fixed-response");
        });
        expect(publicListener).toBeDefined();
        const publicActions = publicListener?.Properties?.DefaultActions as
          | Array<Record<string, unknown>>
          | undefined;
        expect(publicActions).toHaveLength(1);
        const fr = publicActions?.[0]?.FixedResponseConfig as
          | Record<string, unknown>
          | undefined;
        expect(fr?.StatusCode).toBe("403");
      });

      it("the public ALB has a priority-1 listener rule forwarding only when X-Origin-Verify matches", () => {
        const rules = template.findResources(
          "AWS::ElasticLoadBalancingV2::ListenerRule",
        );
        const verified = Object.values(rules).find((r) => {
          const conditions = r.Properties?.Conditions as
            | Array<{ Field?: string }>
            | undefined;
          return conditions?.some((c) => c.Field === "http-header");
        });
        expect(verified).toBeDefined();
        expect(verified?.Properties?.Priority).toBe(1);
        const conditions = verified?.Properties?.Conditions as
          | Array<Record<string, unknown>>
          | undefined;
        const headerCondition = conditions?.find(
          (c) => c.Field === "http-header",
        );
        const headerConfig = headerCondition?.HttpHeaderConfig as
          | { HttpHeaderName?: string; Values?: unknown[] }
          | undefined;
        expect(headerConfig?.HttpHeaderName).toBe("X-Origin-Verify");
        // The header value is a CFN dynamic reference using the FRIENDLY
        // NAME form. The secret value itself never sits in the template.
        //
        // #431 blocker #5: the previous `Secret.fromSecretNameV2(...).
        // secretValue` form emitted a *partial-ARN* dynamic reference
        // (`{{resolve:secretsmanager:arn:aws:secretsmanager:<region>:
        // <acct>:secret:<name>:SecretString:::}}`). CDK synth accepted
        // it; AWS Secrets Manager rejects partial-ARN references at
        // deploy time with `ResourceNotFoundException`. The fix is
        // `SecretValue.secretsManager(name)`, which emits the
        // friendly-name form (`{{resolve:secretsmanager:<name>:
        // SecretString:::}}`). This assertion blocks a regression to
        // the partial-ARN form by failing if the serialized value
        // contains `arn:aws:secretsmanager` -- which only appears in
        // the broken form.
        const values = headerConfig?.Values as unknown[] | undefined;
        expect(values).toHaveLength(1);
        const serialized = JSON.stringify(values?.[0]);
        expect(serialized).toMatch(/\{\{resolve:secretsmanager:/);
        expect(serialized).toContain(
          "scholars/prod/edge/origin-shared-secret",
        );
        expect(serialized).not.toContain("arn:aws:secretsmanager");
        // Action: forward to the app target group.
        const actions = verified?.Properties?.Actions as
          | Array<{ Type?: string }>
          | undefined;
        expect(actions?.[0]?.Type).toBe("forward");
      });
    });

    describe("VPC endpoints (B17, deviation from ADR-008 Table 4)", () => {
      it("the interface endpoint SG admits only :443 from the app + ETL SGs (no 0.0.0.0/0)", () => {
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        const endpointSg = Object.values(sgs).find((r) => {
          const desc = r.Properties?.GroupDescription as string | undefined;
          return typeof desc === "string" && desc.includes("VPC interface endpoints");
        });
        expect(endpointSg).toBeDefined();
        const ingressRules = (endpointSg?.Properties?.SecurityGroupIngress ??
          []) as Array<Record<string, unknown>>;
        expect(ingressRules).toHaveLength(2);
        for (const rule of ingressRules) {
          expect(rule.FromPort).toBe(443);
          expect(rule.ToPort).toBe(443);
          expect(rule.IpProtocol).toBe("tcp");
          expect(rule.CidrIp).toBeUndefined();
          expect(rule.SourceSecurityGroupId).toBeDefined();
        }
      });
    });

    describe("Footgun #4 -- env-prefix guard", () => {
      // Account 665083158573 hosts both staging and prod. Every named
      // resource must carry the env literal so the two stacks coexist.
      // PR #404 burned a deploy on this; the guard generalizes here so
      // future AppStack changes can't introduce a non-env-prefixed name.
      const ENV = "prod";
      const NAME_KEYS: ReadonlyArray<{ type: string; prop: string }> = [
        { type: "AWS::ECR::Repository", prop: "RepositoryName" },
        { type: "AWS::ECS::Cluster", prop: "ClusterName" },
        { type: "AWS::ECS::Service", prop: "ServiceName" },
        { type: "AWS::ECS::TaskDefinition", prop: "Family" },
        { type: "AWS::ElasticLoadBalancingV2::LoadBalancer", prop: "Name" },
        { type: "AWS::ElasticLoadBalancingV2::TargetGroup", prop: "Name" },
        { type: "AWS::Logs::LogGroup", prop: "LogGroupName" },
        { type: "AWS::IAM::Role", prop: "RoleName" },
      ];

      it.each(NAME_KEYS)("every $type carries the env literal in $prop", ({ type, prop }) => {
        const resources = template.findResources(type);
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(resources)) {
          const name = resource.Properties?.[prop] as string | undefined;
          if (typeof name !== "string") {
            continue;
          }
          if (!name.includes(ENV)) {
            violations.push(`${id}: ${type}.${prop}=${JSON.stringify(name)}`);
          }
        }
        expect(violations).toEqual([]);
      });
    });

    describe("Footgun #6 -- EC2 property character-set safety", () => {
      // Re-applied here. Carried forward from data-stack.test.ts; the
      // guard generalizes to every stack that creates SGs.
      it("every AWS::EC2::SecurityGroupIngress Description is ASCII-safe", () => {
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(ingress)) {
          const desc = resource.Properties?.Description as string | undefined;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            const bad = [...desc].filter(
              (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
            );
            violations.push(
              `${id}: ${JSON.stringify(desc)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
            );
          }
        }
        expect(violations).toEqual([]);
      });

      it("every AWS::EC2::SecurityGroup GroupDescription is ASCII-safe", () => {
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(sgs)) {
          const desc = resource.Properties?.GroupDescription as
            | string
            | undefined;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            const bad = [...desc].filter(
              (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
            );
            violations.push(
              `${id}: ${JSON.stringify(desc)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
            );
          }
        }
        expect(violations).toEqual([]);
      });

      it("inline ingress descriptions on AWS::EC2::SecurityGroup are ASCII-safe", () => {
        // VPC endpoint SG ingress lives inline as SecurityGroupIngress
        // property entries rather than standalone resources because the
        // peers are constructed via Peer.securityGroupId(...). Walk those
        // descriptions too.
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(sgs)) {
          const inline = (resource.Properties?.SecurityGroupIngress ??
            []) as Array<{ Description?: string }>;
          for (const rule of inline) {
            const desc = rule.Description;
            if (
              typeof desc === "string" &&
              !EC2_DESCRIPTION_ALLOWED.test(desc)
            ) {
              const bad = [...desc].filter(
                (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
              );
              violations.push(
                `${id}: ${JSON.stringify(desc)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
              );
            }
          }
        }
        expect(violations).toEqual([]);
      });
    });

    describe("Secrets hygiene", () => {
      it("no plaintext secret value appears in the synthesized template", () => {
        const json = JSON.stringify(template.toJSON());
        expect(json).not.toMatch(/PasswordValue/);
        expect(json).not.toMatch(/GenerateSecretString/);
      });

      it("the task definitions reference each secret only by ARN (Fn::Join/Ref) -- never as a literal value", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        for (const resource of Object.values(taskDefs)) {
          const containers = (resource.Properties?.ContainerDefinitions ??
            []) as Array<{ Secrets?: Array<{ Name?: string; ValueFrom?: unknown }> }>;
          for (const container of containers) {
            for (const secret of container.Secrets ?? []) {
              // ValueFrom must always be a CFN intrinsic (object) referring
              // to an ARN -- never a bare string.
              expect(typeof secret.ValueFrom).toBe("object");
            }
          }
        }
      });
    });

    describe("Distributed tracing sidecar (B24)", () => {
      it("the app task definition includes the otel-collector sidecar container", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        expect(appTaskDef).toBeDefined();
        const containerNames = (
          appTaskDef?.Properties?.ContainerDefinitions as
            | Array<{ Name?: string }>
            | undefined
        )?.map((c) => c.Name);
        expect(containerNames).toEqual(
          expect.arrayContaining(["app", "otel-collector"]),
        );
      });

      it("the otel-collector image is pinned by digest (no :latest, no tag-only)", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        const collector = (
          appTaskDef?.Properties?.ContainerDefinitions as
            | Array<{ Name?: string; Image?: string }>
            | undefined
        )?.find((c) => c.Name === "otel-collector");
        expect(collector).toBeDefined();
        // A pinned image always has `@sha256:<64-hex>` in the reference and
        // never carries `:latest` or any other tag.
        expect(collector?.Image).toMatch(
          /public\.ecr\.aws\/aws-observability\/aws-otel-collector@sha256:[a-f0-9]{64}$/,
        );
        expect(collector?.Image).not.toMatch(/:latest/);
      });

      it("the otel-collector container is non-essential (sidecar lifecycle) and loads its config from env", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        const collector = (
          appTaskDef?.Properties?.ContainerDefinitions as
            | Array<{
                Name?: string;
                Essential?: boolean;
                Command?: string[];
                Environment?: Array<{ Name?: string; Value?: string }>;
              }>
            | undefined
        )?.find((c) => c.Name === "otel-collector");
        expect(collector?.Essential).toBe(false);
        expect(collector?.Command).toEqual([
          "--config=env:AOT_CONFIG_CONTENT",
        ]);
        const envEntry = collector?.Environment?.find(
          (e) => e.Name === "AOT_CONFIG_CONTENT",
        );
        expect(envEntry?.Value).toMatch(/tail_sampling:/);
        expect(envEntry?.Value).toMatch(/awsxray:/);
        expect(envEntry?.Value).toMatch(/sampling_percentage:\s*5/);
        expect(envEntry?.Value).toMatch(/threshold_ms:\s*1500/);
        // Dual-export to New Relic (B24): the otlphttp/newrelic exporter, the
        // US OTLP endpoint, the env-substituted ingest key, and both exporters
        // on the traces pipeline.
        expect(envEntry?.Value).toMatch(/otlphttp\/newrelic:/);
        expect(envEntry?.Value).toMatch(/https:\/\/otlp\.nr-data\.net/);
        expect(envEntry?.Value).toMatch(/api-key:\s*\$\{env:NEW_RELIC_LICENSE_KEY\}/);
        expect(envEntry?.Value).toMatch(/exporters:\s*\[awsxray,\s*otlphttp\/newrelic\]/);
      });

      it("the otel-collector container receives the New Relic ingest key as a secret (collector-only, not the app container)", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        const containers = appTaskDef?.Properties?.ContainerDefinitions as
          | Array<{ Name?: string; Secrets?: Array<{ Name?: string }> }>
          | undefined;
        const collector = containers?.find((c) => c.Name === "otel-collector");
        const collectorSecretNames = (collector?.Secrets ?? []).map(
          (s) => s.Name,
        );
        expect(collectorSecretNames).toContain("NEW_RELIC_LICENSE_KEY");
        // The app container owns no part of the trace exporter, so it must not
        // carry the ingest key -- only the collector that holds the exporter.
        const app = containers?.find((c) => c.Name === "app");
        const appSecretNames = (app?.Secrets ?? []).map((s) => s.Name);
        expect(appSecretNames).not.toContain("NEW_RELIC_LICENSE_KEY");
      });

      it("the app container has exactly the four OTEL_* env vars (no sampler env vars)", () => {
        const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
        const appTaskDef = Object.values(taskDefs).find(
          (r) => r.Properties?.Family === "sps-app-prod",
        );
        const appContainer = (
          appTaskDef?.Properties?.ContainerDefinitions as
            | Array<{
                Name?: string;
                Environment?: Array<{ Name?: string; Value?: string }>;
              }>
            | undefined
        )?.find((c) => c.Name === "app");
        const envByName = new Map(
          (appContainer?.Environment ?? []).map((e) => [
            e.Name as string,
            e.Value,
          ]),
        );
        expect(envByName.get("OTEL_SERVICE_NAME")).toBe("Scholars-prod");
        expect(envByName.get("OTEL_EXPORTER_OTLP_ENDPOINT")).toBe(
          "http://localhost:4318",
        );
        expect(envByName.get("OTEL_PROPAGATORS")).toBe("tracecontext,xray");
        expect(envByName.get("SPS_ENV")).toBe("prod");
        // Sampling lives at the collector. SDK head sampler env vars must
        // not appear on the app container or the SDK will drop traces
        // before the tail sampler can evaluate them.
        expect(envByName.has("OTEL_TRACES_SAMPLER")).toBe(false);
        expect(envByName.has("OTEL_TRACES_SAMPLER_ARG")).toBe(false);
      });

      it("the otel-collector log group is env-prefixed and shares the app retention", () => {
        const groups = template.findResources("AWS::Logs::LogGroup");
        const otelGroup = Object.values(groups).find(
          (r) =>
            (r.Properties?.LogGroupName as string | undefined) ===
            "/aws/ecs/sps-otel-prod",
        );
        expect(otelGroup).toBeDefined();
        // Prod = 90-day retention (THREE_MONTHS).
        expect(otelGroup?.Properties?.RetentionInDays).toBe(90);
      });

      it("the task role has exactly two X-Ray action statements (custom inline, not the managed policy)", () => {
        // The plan calls for a custom inline grant of exactly
        // xray:PutTraceSegments + xray:PutTelemetryRecords on Resource:*.
        // Inline (not AWSXRayDaemonWriteAccess) so the action surface stays
        // pinned + immune to AWS quietly extending the managed document.
        // The task role now carries two inline policies (X-Ray + SES); select
        // the X-Ray one by its actions rather than assuming a single policy.
        const taskRolePolicies = findTaskRolePolicies();
        const xrayPolicy = taskRolePolicies.find((p) =>
          JSON.stringify(p.Properties?.PolicyDocument).includes("xray:"),
        );
        expect(xrayPolicy).toBeDefined();
        const statements = xrayPolicy?.Properties?.PolicyDocument?.Statement as
          | Array<Record<string, unknown>>
          | undefined;
        expect(statements).toHaveLength(2);
        const actions = statements
          ?.flatMap((s) =>
            Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string],
          )
          .sort();
        expect(actions).toEqual([
          "xray:PutTelemetryRecords",
          "xray:PutTraceSegments",
        ]);
        // Both X-Ray Put* actions are account-level on the AWS side and
        // only accept Resource:*. This is the documented exception.
        for (const stmt of statements ?? []) {
          expect(stmt.Resource).toBe("*");
        }
      });

      it("the SES send grant is the single ses:SendEmail action, From-conditioned + identity-scoped (#160 Phase 2)", () => {
        // Synth-time guard (deploy-only-validation pattern): the "Request a
        // change" mailer grant must be least-privilege -- one action, scoped to
        // SES identities (never a bare `*` resource), and conditioned to the one
        // verified no-reply From so the task can't send as any other address.
        const sesPolicy = findTaskRolePolicies().find((p) =>
          JSON.stringify(p.Properties?.PolicyDocument).includes("ses:SendEmail"),
        );
        expect(sesPolicy).toBeDefined();
        const statements = sesPolicy?.Properties?.PolicyDocument?.Statement as
          | Array<Record<string, unknown>>
          | undefined;
        expect(statements).toHaveLength(1);
        const stmt = statements![0];
        expect(stmt.Action).toBe("ses:SendEmail");
        // Resource is SES-identity-scoped, NOT a blanket "*".
        const resource = stmt.Resource as string;
        expect(resource).not.toBe("*");
        expect(resource).toContain(":identity/");
        // The From-address condition pins the sender.
        expect(stmt.Condition).toMatchObject({
          StringEquals: { "ses:FromAddress": "no-reply-scholars@weill.cornell.edu" },
        });
      });

      it("the app ships the request-change mailer OFF with the verified From set (#160 Phase 2)", () => {
        // Dormant by default: the endpoint 503s + the client mailto: fallback
        // stays in force until ops flip the flag post-verification.
        const env = appContainerEnv();
        expect(env.get("SELF_EDIT_REQUEST_CHANGE_SEND")).toBe("off");
        expect(env.get("SCHOLARS_MAIL_FROM")).toBe("no-reply-scholars@weill.cornell.edu");
      });

      it("the task role has zero AWS managed policies attached", () => {
        // The grant lands as an inline AWS::IAM::Policy resource attached
        // to the role; the role itself must not import a managed policy.
        const roles = template.findResources("AWS::IAM::Role");
        const taskRole = Object.values(roles).find(
          (r) => r.Properties?.RoleName === "sps-task-prod",
        );
        expect(taskRole).toBeDefined();
        const managed = (taskRole?.Properties?.ManagedPolicyArns ?? []) as
          | unknown[];
        expect(managed).toHaveLength(0);
      });

      it("the task-execution role's logs grant covers the otel-collector log group", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" && r.Ref.includes("TaskExecutionRole"),
          );
        });
        const statements = execPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const logsStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("logs:PutLogEvents")
            : action === "logs:PutLogEvents";
        });
        const serialized = JSON.stringify(logsStmt?.Resource);
        // The execution-role logs grant references the otel-collector log
        // group's logical id; matching by the OtelCollectorLogGroup token
        // is enough to confirm the grant covers the sidecar's streams.
        expect(serialized).toMatch(/OtelCollectorLogGroup/);
      });
    });

    // ----------------------------------------------------------------
    // Audit pass for issue #431 § Scope (b).
    //
    // Five categories. The synth-time guards below close the gaps the
    // walk surfaced; categories with no gap are documented in the PR
    // body, not here.
    // ----------------------------------------------------------------
    describe("Audit (#431) -- deploy-only-gap preemption", () => {
      // -- Category 1: string-name AWS API refs --
      //
      // SecretsStack defines six entries; AppStack reads them by name via
      // `Secret.fromSecretNameV2`. A rename in SecretsStack that drops the
      // matching AppStack entry would silently dangle the reference -- the
      // synthesized template still resolves to a `secretsmanager:` ARN
      // template that doesn't exist, and AWS rejects only at task-start
      // (or, for the listener-rule dynamic ref, at deploy time). Assert
      // every expected secret name appears at least once in the synth.
      it("references every AppStack-consumed Secrets Manager name exactly as SecretsStack defines it", () => {
        const expected = [
          "scholars/prod/db/app-rw",
          "scholars/prod/db/app-ro",
          "scholars/prod/opensearch/app",
          "scholars/prod/revalidate-token",
          "scholars/prod/session-cookie-key",
          "scholars/saml-sp/prod/private-key",
          "scholars/prod/edge/origin-shared-secret",
          // ReciterDB connection (#465) and the SAML IdP signing cert (#466).
          "scholars/prod/etl/reciter",
          "scholars/prod/saml/idp-cert",
          // SAML SP public cert (#466) -- published in SP metadata.
          "scholars/saml-sp/prod/cert",
          // New Relic ingest key (B24) -- ADOT collector otlphttp/newrelic.
          "scholars/prod/newrelic-license-key",
        ];
        const json = JSON.stringify(template.toJSON());
        for (const name of expected) {
          expect(json).toContain(name);
        }
      });

      // -- Category 3a: IAM `*` audit on the task-execution role --
      //
      // The deploy-role test already asserts "every Resource: `*` is the
      // ecr:GetAuthorizationToken exception". The same posture must hold
      // for the task-execution role -- otherwise a future PR can grant a
      // task-side `s3:*` or similar before review.
      it("the task-execution role policy uses `*` only on ecr:GetAuthorizationToken (account-level exception)", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const execPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) =>
              typeof r.Ref === "string" && r.Ref.includes("TaskExecutionRole"),
          );
        });
        expect(execPolicy).toBeDefined();
        const statements = execPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        for (const stmt of statements ?? []) {
          const action = stmt.Action as string | string[];
          const resource = stmt.Resource as unknown;
          const isAuthOnly = Array.isArray(action)
            ? action.length === 1 && action[0] === "ecr:GetAuthorizationToken"
            : action === "ecr:GetAuthorizationToken";
          if (isAuthOnly) {
            continue;
          }
          // Walk the Resource value (string or array); fail if any bare
          // `"*"` slips in. Tokenized ARNs (Fn::Join / Ref) are objects,
          // not strings, so this assertion only blocks the literal wild.
          const list = Array.isArray(resource) ? resource : [resource];
          for (const r of list) {
            expect(r).not.toBe("*");
          }
        }
      });

      // -- Category 3b: deploy-role iam:PassRole posture --
      //
      // The deploy role grants iam:PassRole on the two task-side roles.
      // Without the `iam:PassedToService=ecs-tasks.amazonaws.com`
      // condition, the deploy workflow could pass either role to *any*
      // service principal (Lambda, EC2, EMR, ...). The condition is the
      // confused-deputy guard; assert it stays.
      it("deploy role iam:PassRole is conditioned to ecs-tasks.amazonaws.com", () => {
        const policies = template.findResources("AWS::IAM::Policy");
        const deployPolicy = Object.values(policies).find((p) => {
          const roles = p.Properties?.Roles as
            | Array<{ Ref?: string }>
            | undefined;
          return roles?.some(
            (r) => typeof r.Ref === "string" && r.Ref.includes("DeployRole"),
          );
        });
        const statements = deployPolicy?.Properties?.PolicyDocument
          ?.Statement as Array<Record<string, unknown>> | undefined;
        const passRoleStmt = statements?.find((s) => {
          const action = s.Action;
          return Array.isArray(action)
            ? action.includes("iam:PassRole")
            : action === "iam:PassRole";
        });
        expect(passRoleStmt).toBeDefined();
        const condition = passRoleStmt?.Condition as
          | { StringEquals?: Record<string, string> }
          | undefined;
        expect(condition?.StringEquals?.["iam:PassedToService"]).toBe(
          "ecs-tasks.amazonaws.com",
        );
      });

      // -- Category 4: standalone CfnSecurityGroupIngress count --
      //
      // Three SG-to-SG (or CIDR) ingresses are intentionally L1 to keep
      // the rules co-located with the listeners they support (see SG
      // comment in app-stack.ts). A future PR that adds a 4th wildcard
      // ingress (e.g. `0.0.0.0/0` to a workload SG) should fail this
      // assertion before review.
      it("emits exactly three standalone AWS::EC2::SecurityGroupIngress resources", () => {
        template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 3);
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const cidrIngressCount = Object.values(ingress).filter(
          (r) => r.Properties?.CidrIp === "0.0.0.0/0",
        ).length;
        // Exactly one rule is allowed to use 0.0.0.0/0 (the public ALB's
        // :80 ingress); a future addition of a wildcard rule on a
        // workload SG must come through review.
        expect(cidrIngressCount).toBe(1);
      });

      // -- Category 2 (post-deploy gap): no target group spans more than
      //    one load balancer (AWS-side constraint, #431 blocker #6).
      //
      // AWS enforces a strict 1:1 relationship between a target group and
      // a load balancer: the second listener-create on a shared TG fails
      // with "target groups cannot be associated with more than one load
      // balancer." CDK synth accepts the shape; the deploy rejects it.
      // The fix is one TG per ALB. This guard walks every listener (and
      // its rules) in the template, maps each TG reference to the
      // listener's parent LB, and fails if a TG is reachable from more
      // than one distinct LB.
      it("no target group is referenced by listeners on more than one ALB", () => {
        const listeners = template.findResources(
          "AWS::ElasticLoadBalancingV2::Listener",
        );
        const rules = template.findResources(
          "AWS::ElasticLoadBalancingV2::ListenerRule",
        );
        // Map listener logical-id -> LB logical-id.
        const listenerToLb = new Map<string, string>();
        for (const [id, r] of Object.entries(listeners)) {
          const lbRef = (r.Properties?.LoadBalancerArn as { Ref?: string } | undefined)
            ?.Ref;
          if (typeof lbRef === "string") {
            listenerToLb.set(id, lbRef);
          }
        }
        // Walk each listener's default actions + each rule's actions for
        // TargetGroupArn refs; collect TG -> LBs seen.
        const tgToLbs = new Map<string, Set<string>>();
        const collect = (listenerId: string, actions: unknown) => {
          const lb = listenerToLb.get(listenerId);
          if (lb === undefined) return;
          for (const a of (actions as Array<Record<string, unknown>> | undefined) ?? []) {
            const tgArn = (a.TargetGroupArn as { Ref?: string } | undefined)?.Ref;
            if (typeof tgArn === "string") {
              if (!tgToLbs.has(tgArn)) tgToLbs.set(tgArn, new Set());
              tgToLbs.get(tgArn)!.add(lb);
            }
            // ForwardConfig.TargetGroups (multi-TG weighted forward).
            const fc = a.ForwardConfig as
              | { TargetGroups?: Array<Record<string, unknown>> }
              | undefined;
            for (const tg of fc?.TargetGroups ?? []) {
              const arn = (tg.TargetGroupArn as { Ref?: string } | undefined)?.Ref;
              if (typeof arn === "string") {
                if (!tgToLbs.has(arn)) tgToLbs.set(arn, new Set());
                tgToLbs.get(arn)!.add(lb);
              }
            }
          }
        };
        for (const [id, r] of Object.entries(listeners)) {
          collect(id, r.Properties?.DefaultActions);
        }
        for (const r of Object.values(rules)) {
          const listenerRef = (r.Properties?.ListenerArn as { Ref?: string } | undefined)
            ?.Ref;
          if (typeof listenerRef === "string") {
            collect(listenerRef, r.Properties?.Actions);
          }
        }
        // Every TG that appears must belong to exactly one ALB.
        const violations: string[] = [];
        for (const [tg, lbs] of tgToLbs.entries()) {
          if (lbs.size > 1) {
            violations.push(`TG ${tg} reachable from LBs: ${[...lbs].sort().join(", ")}`);
          }
        }
        expect(violations).toEqual([]);
      });

      // -- Category 5: AWS-side name-length constraints --
      //
      // ALB names are bounded at 32 chars and TG names at 32 chars. IAM
      // role names are bounded at 64 chars. CDK synth accepts longer
      // values and the deploy fails. `prod`/`staging` are safe today, but
      // a future env literal (e.g. `dev-uat`) could overflow. Walk every
      // ALB/TG/IAM-role name and assert the limit.
      it("every ALB, target-group, and IAM role name fits the AWS-side length limit", () => {
        const lbs = template.findResources(
          "AWS::ElasticLoadBalancingV2::LoadBalancer",
        );
        for (const [id, r] of Object.entries(lbs)) {
          const name = r.Properties?.Name as string | undefined;
          if (typeof name === "string") {
            expect({ id, name, len: name.length, ok: name.length <= 32 })
              .toEqual({ id, name, len: name.length, ok: true });
          }
        }
        const tgs = template.findResources(
          "AWS::ElasticLoadBalancingV2::TargetGroup",
        );
        for (const [id, r] of Object.entries(tgs)) {
          const name = r.Properties?.Name as string | undefined;
          if (typeof name === "string") {
            expect({ id, name, len: name.length, ok: name.length <= 32 })
              .toEqual({ id, name, len: name.length, ok: true });
          }
        }
        const roles = template.findResources("AWS::IAM::Role");
        for (const [id, r] of Object.entries(roles)) {
          const name = r.Properties?.RoleName as string | undefined;
          if (typeof name === "string") {
            expect({ id, name, len: name.length, ok: name.length <= 64 })
              .toEqual({ id, name, len: name.length, ok: true });
          }
        }
      });
    });
  });

  describe("staging", () => {
    const { template } = buildAppStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("uses staging desiredCount = 1", () => {
      template.hasResourceProperties("AWS::ECS::Service", {
        DesiredCount: 1,
      });
    });

    it("autoscales between min=1 and max=3 for staging (#596)", () => {
      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {
          ScalableDimension: "ecs:service:DesiredCount",
          MinCapacity: 1,
          MaxCapacity: 3,
        },
      );
    });

    it("owns (creates) the account-scoped OIDC provider (#491)", () => {
      // staging is the designated owner: it creates the single account-scoped
      // provider that prod (and any other env) imports.
      template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
    });

    it("announces the registered prod SP entityID but keeps the staging ACS host (#466)", () => {
      const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
      const appTaskDef = Object.values(taskDefs).find(
        (r) => r.Properties?.Family === "sps-app-staging",
      );
      const appContainer = (
        appTaskDef?.Properties?.ContainerDefinitions as
          | Array<{
              Name?: string;
              Environment?: Array<{ Name?: string; Value?: string }>;
            }>
          | undefined
      )?.find((c) => c.Name === "app");
      const envByName = new Map(
        (appContainer?.Environment ?? []).map((e) => [
          e.Name as string,
          e.Value,
        ]),
      );
      // Staging reuses the single registered SP entityID (the prod host), but
      // its ACS stays the staging host so the response returns to staging.
      expect(envByName.get("SAML_SP_ENTITY_ID")).toBe(
        "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
      );
      expect(envByName.get("SAML_SP_ACS_URL")).toBe(
        "https://scholars-staging.weill.cornell.edu/api/auth/saml/callback",
      );
      // IdP coordinates are shared with prod (same WCM prod IdP).
      expect(envByName.get("SAML_IDP_SSO_URL")).toBe(
        "https://login-proxy.weill.cornell.edu/idp/profile/SAML2/Redirect/SSO",
      );
    });

    it("injects the staging SAML IdP cert secret name (#466)", () => {
      const json = JSON.stringify(template.toJSON());
      expect(json).toContain("scholars/staging/saml/idp-cert");
    });

    it("uses staging Fargate sizing 512 cpu / 1024 MiB on the app task definition", () => {
      const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
      const appTaskDef = Object.values(taskDefs).find(
        (r) => r.Properties?.Family === "sps-app-staging",
      );
      expect(appTaskDef).toBeDefined();
      expect(appTaskDef?.Properties?.Cpu).toBe("512");
      expect(appTaskDef?.Properties?.Memory).toBe("1024");
    });

    it("grants the audit INSERT to `'app_rw'@'10.20.%'` on staging (#493 staging fix)", () => {
      // Staging's app user is host-pattern `10.20.%` (VPC-CIDR-scoped), not the
      // `%` the bootstrap defaulted to -- the cause of the MySQL 1410 at GRANT.
      // Guards the per-env appRwGranteeHost wiring on the bootstrap task def.
      const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
      const bootstrap = Object.values(taskDefs).find(
        (r) => r.Properties?.Family === "sps-db-bootstrap-staging",
      );
      expect(bootstrap).toBeDefined();
      const container = (
        bootstrap?.Properties?.ContainerDefinitions as
          | Array<{
              Name?: string;
              Environment?: Array<{ Name?: string; Value?: string }>;
            }>
          | undefined
      )?.find((c) => c.Name === "db-bootstrap");
      const envByName = new Map(
        (container?.Environment ?? []).map((e) => [e.Name as string, e.Value]),
      );
      expect(envByName.get("GRANTEE_HOST")).toBe("10.20.%");
    });

    it("provisions the verify-grants task on staging with the three Phase 0 role DSNs (ADR-009)", () => {
      const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
      const verify = Object.values(taskDefs).find(
        (r) => r.Properties?.Family === "sps-verify-grants-staging",
      );
      expect(verify).toBeDefined();
      const container = (
        verify?.Properties?.ContainerDefinitions as
          | Array<{ Name?: string; Secrets?: Array<{ Name?: string }> }>
          | undefined
      )?.find((c) => c.Name === "verify-grants");
      expect(container).toBeDefined();
      const secretNames = container?.Secrets?.map((s) => s.Name).sort();
      expect(secretNames).toEqual(["APP_RO_DSN", "APP_RW_DSN", "BOOTSTRAP_DSN"]);
    });

    it("uses 30-day log retention for staging (vs 90 days in prod)", () => {
      const groups = template.findResources("AWS::Logs::LogGroup");
      for (const resource of Object.values(groups)) {
        expect(resource.Properties?.RetentionInDays).toBe(30);
      }
    });

    it("OIDC sub claim admits any ref in the SPS repo for staging", () => {
      const roles = template.findResources("AWS::IAM::Role");
      const deployRole = Object.values(roles).find(
        (r) => r.Properties?.RoleName === "sps-deploy-staging",
      );
      expect(deployRole).toBeDefined();
      const statements = deployRole?.Properties?.AssumeRolePolicyDocument
        ?.Statement as Array<Record<string, unknown>> | undefined;
      const subClaim = statements?.[0]?.Condition as
        | { StringLike?: Record<string, string> }
        | undefined;
      const sub =
        subClaim?.StringLike?.["token.actions.githubusercontent.com:sub"];
      expect(sub).toBe("repo:wcmc-its/Scholars-Profile-System:*");
    });

    it("the env-config bootstrap override drives desiredCount to 0 when -c appDesiredCount=0 is set", () => {
      // Models the first-deploy two-step in the plan's § Deploy strategy.
      const fixture = makeFixture("staging");
      fixture.app.node.setContext("appDesiredCount", 0);
      const network = new NetworkStack(fixture.app, `Sps-Network-staging-zero`, {
        env: fixture.env,
        envConfig: fixture.envConfig,
      });
      const stack = new AppStack(fixture.app, `Sps-App-staging-zero`, {
        env: fixture.env,
        envConfig: fixture.envConfig,
        vpc: network.vpc,
        appSecurityGroup: network.appSecurityGroup,
        etlSecurityGroup: network.etlSecurityGroup,
        albSecurityGroup: network.albSecurityGroup,
      });
      const t = Template.fromStack(stack);
      t.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 0 });
      // The bootstrap deploy must NOT attach a scalable target: a non-zero
      // MinCapacity would make App Auto Scaling immediately schedule the
      // floor tasks against an empty ECR, re-creating the failing-pull wait
      // the bootstrap exists to avoid (#596).
      t.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
      t.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
    });
  });
});
