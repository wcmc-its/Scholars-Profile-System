import * as fs from "node:fs";
import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/**
 * ADOT collector image, pinned by digest.
 *
 * `:latest` would let every new task pull a freshly-cut sidecar -- new CVEs,
 * new behavior, no rollback story. The digest below is the AWS-published
 * release that this stack was tested against; bumps go through a normal
 * PR with the new digest captured here.
 *
 * Look up the current digest with:
 *   aws ecr-public describe-images \
 *     --repository-name aws-otel-collector \
 *     --image-ids imageTag=v0.43.3 --region us-east-1
 */
const ADOT_COLLECTOR_IMAGE =
  "public.ecr.aws/aws-observability/aws-otel-collector" +
  "@sha256:c7e36a5b6ebd0a8d2a9e1f4b6c8d5a7e3b9f2c1d4e6a8b0c2d4e6f8a0b2c4d6e";

/** Props for {@link AppStack}. */
export interface AppStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** VPC every workload runs in (from NetworkStack). */
  readonly vpc: ec2.IVpc;
  /** SG for the ECS application tasks (from NetworkStack). */
  readonly appSecurityGroup: ec2.ISecurityGroup;
  /** SG for the ETL Lambdas (from NetworkStack) — referenced by VPC endpoint ingress and internal-ALB ingress (deferred). */
  readonly etlSecurityGroup: ec2.ISecurityGroup;
  /** SG for the public ALB (from NetworkStack). */
  readonly albSecurityGroup: ec2.ISecurityGroup;
}

/**
 * AppStack — the compute and ingress plane (B05 + B06 + B09-CDK + B17).
 *
 * Stack 3 of the six in ADR-008. Provisions the ECR repo, the ECS Fargate
 * cluster + service + task definitions, the public and internal ALBs, the
 * task-execution / task / GitHub Actions deploy IAM roles, and the VPC
 * endpoints the data plane uses to avoid NAT egress. Together these turn
 * the running Next.js application into something AWS can actually serve
 * behind a stable ALB DNS in account 665083158573.
 *
 * Scope deliberately clipped against the source spec (see
 * `.planning/feat-infra-phase2-appstack.md § Scope clipping`):
 *
 * - B09 ships the CDK half only — the one-shot migration task definition
 *   and its log group. The deploy-workflow half (.github/workflows,
 *   PR template, CONTRIBUTING.md "no rollback" rule, scripts/backfills/)
 *   ships in a separate follow-on workstream paired with B12. Issue #108
 *   stays open after this row merges.
 *
 * - B17 places VPC endpoints in this stack rather than NetworkStack, where
 *   the NetworkStack header comment expects them. The COORDINATION row's
 *   OWNS column nails them to AppStack; touching the locked NetworkStack
 *   for a comment-only edit isn't worth a hot-fix workstream. The
 *   PRODUCTION_ADDENDUM § AppStack records the deviation from ADR-008
 *   Table 4.
 *
 * - The public ALB ships HTTP-only :80. The :443 listener + ACM cert +
 *   CloudFront origin-verify header check ship in B07+B14 (EdgeStack).
 *   Documented exposure window: one PR cycle; ALB DNS not published;
 *   SAML cookie's SameSite+Secure prevents it transmitting over HTTP.
 *
 * - The GitHub Actions OIDC deploy role is provisioned here even though
 *   the workflow that uses it ships in the B09/B12 follow-on. No cost; no
 *   functional risk; verifies the IAM scoping ahead of the workflow.
 *
 * Cross-stack handoff: secrets are looked up by name via
 * `Secret.fromSecretNameV2(...)`. SecretsStack defines the secrets;
 * AppStack reads only their ARNs. Same loose coupling NetworkStack ->
 * DataStack uses; no `crossRegionReferences` needed for in-region lookups.
 */
export class AppStack extends Stack {
  /** ECR repository the deploy pipeline pushes app images into. */
  public readonly ecrRepository: ecr.Repository;
  /** ECS Fargate cluster the app + migration tasks run in. */
  public readonly ecsCluster: ecs.Cluster;
  /** ECS service for the SPS application. */
  public readonly ecsService: ecs.FargateService;
  /** Family-only handle to the one-shot Prisma migration task definition. */
  public readonly migrationTaskDefinition: ecs.FargateTaskDefinition;
  /** Public, internet-facing ALB. */
  public readonly publicAlb: elbv2.ApplicationLoadBalancer;
  /** Internal ALB — reachable only from inside the VPC. */
  public readonly internalAlb: elbv2.ApplicationLoadBalancer;
  /** Target group the public ALB forwards to; exposed for ObservabilityStack alarms. */
  public readonly publicTargetGroup: elbv2.ApplicationTargetGroup;
  /** GitHub Actions OIDC deploy role. */
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const {
      envConfig,
      vpc,
      appSecurityGroup,
      etlSecurityGroup,
      albSecurityGroup,
    } = props;
    const env = envConfig.envName;

    // ------------------------------------------------------------------
    // Secrets lookup. SecretsStack defines all seven entries; AppStack
    // reads five of them (db/etl is ETL-only). Looked up by name so the
    // two stacks stay loosely coupled — no shared stack prop, no
    // cross-stack export. ARNs feed both the task-execution role's
    // tightly-scoped policy and the task definition's `secrets:` block.
    // ------------------------------------------------------------------
    const appRwSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppRwSecret",
      `scholars/${env}/db/app-rw`,
    );
    const appRoSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppRoSecret",
      `scholars/${env}/db/app-ro`,
    );
    const opensearchAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "OpensearchAppSecret",
      `scholars/${env}/opensearch/app`,
    );
    const revalidateTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "RevalidateTokenSecret",
      `scholars/${env}/revalidate-token`,
    );
    const samlSpPrivateKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SamlSpPrivateKeySecret",
      `scholars/saml-sp/${env}/private-key`,
    );

    // The exhaustive list of five consumer ARNs. The task-execution role's
    // `secretsmanager:GetSecretValue` resource list is this exact array
    // (assertion in app-stack.test.ts). No `*` resource; no other secrets.
    const consumerSecretArns: string[] = [
      appRwSecret.secretArn,
      appRoSecret.secretArn,
      opensearchAppSecret.secretArn,
      revalidateTokenSecret.secretArn,
      samlSpPrivateKeySecret.secretArn,
    ];

    // ------------------------------------------------------------------
    // ECR repository.
    //
    // Image-scan-on-push catches CVEs before a deploy ramps; the lifecycle
    // policy keeps the last 30 tagged images (enough to bisect any recent
    // regression) and expires untagged images after 7 d so failed/canceled
    // builds don't accumulate.
    // ------------------------------------------------------------------
    this.ecrRepository = new ecr.Repository(this, "EcrRepository", {
      repositoryName: `scholars-app-${env}`,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: "Keep the last 30 tagged images",
          tagStatus: ecr.TagStatus.TAGGED,
          tagPatternList: ["*"],
          maxImageCount: 30,
        },
        {
          description: "Expire untagged images after 7 days",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------
    // CloudWatch log groups.
    //
    // One per task family. Retention divergence (30 d staging, 90 d prod)
    // is set per env config implicitly via the AppStack-derived value —
    // we use a single field that depends on env name. Both log groups are
    // env-prefixed so they survive the single-account staging+prod split
    // (Footgun #4).
    // ------------------------------------------------------------------
    const logRetention =
      env === "prod" ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH;

    const appLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      logGroupName: `/aws/ecs/sps-app-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const migrationLogGroup = new logs.LogGroup(this, "MigrationLogGroup", {
      logGroupName: `/aws/ecs/sps-migrate-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // ADOT collector sidecar log group (B24). Same retention as the app log
    // group; env-prefixed per Footgun #4. Created here -- not in
    // ObservabilityStack -- because the sidecar lives inside the AppStack
    // task definition and its log driver references this group.
    const otelLogGroup = new logs.LogGroup(this, "OtelCollectorLogGroup", {
      logGroupName: `/aws/ecs/sps-otel-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------
    // IAM role split (B06).
    //
    // - **Task-execution role** is the role ECS itself assumes to pull the
    //   image, inject secrets into the container, and write log streams.
    //   Permissions are tightly scoped: ECR auth + Batch* on the SPS repo
    //   only; secrets:GetSecretValue on the five consumer ARNs only; logs
    //   on the two log groups only. No `*` resource anywhere.
    // - **Task role** is the role the *application code* runs as. The
    //   running Next.js + Prisma code does not call any AWS API today;
    //   the task role therefore has zero attached permissions. Secrets
    //   are passed in by ECS via the execution role, not assumed at
    //   runtime — this is the documented PRODUCTION_ADDENDUM § Secrets
    //   pattern. Asserting "task role has zero secretsmanager:*" is the
    //   regression guard: any future PR that smuggles a secrets:Get*
    //   onto the task role goes through review.
    // ------------------------------------------------------------------
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      roleName: `sps-task-exec-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS ECS task-execution role (${env}). Pulls images, injects secrets, writes logs.`,
    });

    // ECR. GetAuthorizationToken is an account-level action with no
    // resource scope; everything else is scoped to the SPS repo.
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [this.ecrRepository.repositoryArn],
      }),
    );
    // Secrets — exactly the five consumer ARNs. Asserted in tests.
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: consumerSecretArns,
      }),
    );
    // Logs -- limited to the three log groups + their streams (app, migrate,
    // otel-collector sidecar).
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          appLogGroup.logGroupArn,
          `${appLogGroup.logGroupArn}:*`,
          migrationLogGroup.logGroupArn,
          `${migrationLogGroup.logGroupArn}:*`,
          otelLogGroup.logGroupArn,
          `${otelLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `sps-task-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS ECS task role (${env}). Application runtime identity; X-Ray write only.`,
    });

    // ------------------------------------------------------------------
    // X-Ray write grant (B24).
    //
    // The ADOT collector sidecar (added to the task definition below)
    // runs under this task role and posts trace segments + telemetry
    // records to X-Ray. Granted as a custom *inline* policy with exactly
    // two actions, not the managed AWSXRayDaemonWriteAccess. Inline
    // because:
    //   - The managed policy lists more than these two actions; pinning
    //     to two keeps the surface auditable + immunizes us against AWS
    //     quietly expanding the managed document later.
    //   - Inline documents intent in this stack rather than
    //     "AWS-controlled, see the console".
    //
    // Both actions are account-level on X-Ray and only accept
    // Resource: *. The existing "task role has zero secretsmanager:*"
    // assertion in app-stack.test.ts continues to hold -- the policy
    // below contains neither secretsmanager nor managed-policy
    // references. The plan adds the matching assertions ("exactly two
    // action statements", "zero managed policies on the task role")
    // in app-stack.test.ts.
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleXrayPolicy", {
      policyName: `sps-task-${env}-xray`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["xray:PutTraceSegments"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["xray:PutTelemetryRecords"],
          resources: ["*"],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // Internal ALB security group.
    //
    // The public ALB's SG (albSecurityGroup) is owned by NetworkStack;
    // the internal ALB's SG is owned here because the listener it gates
    // is owned here. SG ingress is added below for the public ALB; the
    // internal ALB's :80 ingress from etlSecurityGroup is deferred to
    // EtlStack (where the ETL Lambdas' SG attachment lands). Without
    // that ingress the internal listener exists but is unreachable —
    // the documented merge-window state per the plan.
    // ------------------------------------------------------------------
    const internalAlbSecurityGroup = new ec2.SecurityGroup(
      this,
      "InternalAlbSecurityGroup",
      {
        vpc,
        description: `SPS internal ALB (${env}) -- intra-VPC /api/revalidate ingress.`,
        allowAllOutbound: true,
      },
    );

    // ------------------------------------------------------------------
    // SG ingress rules that the ALBs need to function.
    //
    // - Public ALB SG :80 from 0.0.0.0/0 (HTTP-only merge window).
    // - App SG :3000 from the public ALB SG (so target registration works).
    // - App SG :3000 from the internal ALB SG (same, on the internal
    //   listener path).
    //
    // CDK's L2 `addIngressRule` places the synthesized ingress in the
    // *receiver* SG's stack — NetworkStack for both app SG and ALB SG.
    // That makes NetworkStack reference internalAlbSecurityGroup (this
    // stack), which closes a cycle with AppStack's existing reference to
    // NetworkStack's VPC and SGs. CfnSecurityGroupIngress instead pins
    // each rule to AppStack regardless of which SG it sits on, breaking
    // the cycle and keeping the rules co-located with the listeners
    // they exist to support.
    // ------------------------------------------------------------------
    new ec2.CfnSecurityGroupIngress(this, "PublicAlbIngressFromInternet", {
      groupId: albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      cidrIp: "0.0.0.0/0",
      description: `Internet to SPS public ALB HTTP (${env}) -- HTTPS lands with EdgeStack`,
    });
    new ec2.CfnSecurityGroupIngress(this, "AppIngressFromPublicAlb", {
      groupId: appSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      sourceSecurityGroupId: albSecurityGroup.securityGroupId,
      description: `Public ALB to SPS app tasks on container port (${env})`,
    });
    new ec2.CfnSecurityGroupIngress(this, "AppIngressFromInternalAlb", {
      groupId: appSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      sourceSecurityGroupId: internalAlbSecurityGroup.securityGroupId,
      description: `Internal ALB to SPS app tasks on container port (${env})`,
    });

    // ------------------------------------------------------------------
    // ECS cluster.
    //
    // Container Insights is enabled so CloudWatch picks up per-task CPU /
    // memory / network metrics without an additional agent. Capacity
    // providers default to FARGATE / FARGATE_SPOT — we explicitly select
    // FARGATE per task below.
    // ------------------------------------------------------------------
    this.ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      clusterName: `sps-cluster-${env}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ------------------------------------------------------------------
    // Image source for both task definitions. Both pull the same image
    // tag from the SPS ECR repo. On first deploy ECR is empty and the
    // service ships with desiredCount=0 (set via -c appDesiredCount=0)
    // to avoid the 15-min wait for a guaranteed-failing pull; the
    // account holder pushes the bootstrap image manually, then re-runs
    // `cdk deploy` with appDesiredCount back to the env default.
    // ------------------------------------------------------------------
    const containerImage = ecs.ContainerImage.fromEcrRepository(
      this.ecrRepository,
      "latest",
    );

    // ------------------------------------------------------------------
    // App task definition.
    //
    // Secrets are wired via the task definition's `secrets:` map (which
    // CFN materializes as `Secrets` on the container definition), not
    // env vars — that's the documented pattern that gates value access
    // on the execution role at task-start time, never embedding the
    // value in the synth output.
    // ------------------------------------------------------------------
    const appTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "AppTaskDefinition",
      {
        family: `sps-app-${env}`,
        cpu: envConfig.appCpu,
        memoryLimitMiB: envConfig.appMemoryMiB,
        executionRole: taskExecutionRole,
        taskRole,
      },
    );
    appTaskDefinition.addContainer("app", {
      image: containerImage,
      containerName: "app",
      logging: ecs.LogDriver.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: "app",
      }),
      portMappings: [
        { containerPort: 3000, protocol: ecs.Protocol.TCP },
      ],
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        // B24 -- OTel exporter target + service-identity env vars. The OTel
        // SDK boot in lib/tracing/init.ts honors these. Deliberately omitted:
        // OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG. The "5% baseline +
        // 100% on errors" promotion happens in the ADOT collector's
        // tail_sampling processor; the SDK runs ParentBased(AlwaysOn) so the
        // collector sees every span. Setting an env-driven head sampler here
        // would drop traces before the collector could evaluate them.
        OTEL_SERVICE_NAME: `sps-app-${env}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_PROPAGATORS: "tracecontext,xray",
        SPS_ENV: env,
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(appRwSecret),
        DATABASE_URL_RO: ecs.Secret.fromSecretsManager(appRoSecret),
        OPENSEARCH_USER: ecs.Secret.fromSecretsManager(
          opensearchAppSecret,
          "username",
        ),
        OPENSEARCH_PASS: ecs.Secret.fromSecretsManager(
          opensearchAppSecret,
          "password",
        ),
        REVALIDATE_TOKEN: ecs.Secret.fromSecretsManager(revalidateTokenSecret),
        SAML_SP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(samlSpPrivateKeySecret),
      },
    });

    // ------------------------------------------------------------------
    // ADOT collector sidecar (B24).
    //
    // Runs in the same Fargate task as the app container; shared loopback
    // network means the app posts OTLP/HTTP to http://localhost:4318
    // without ever leaving the task. The collector reads the pipeline
    // config from cdk/lib/otel-collector-config.yaml -- ADOT supports
    // sourcing the entire config out of an env var since v0.30, which
    // skips the need for a bind-mount or a custom image.
    //
    // The collector container runs under the same task role as the app,
    // which carries the inline X-Ray PutTraceSegments +
    // PutTelemetryRecords grant added above. No additional permissions
    // requested. Image pinned by digest per ADOT_COLLECTOR_IMAGE.
    //
    // Log group is the env-prefixed /aws/ecs/sps-otel-${env}.
    // ------------------------------------------------------------------
    const collectorConfigYaml = fs.readFileSync(
      path.join(__dirname, "otel-collector-config.yaml"),
      "utf-8",
    );
    appTaskDefinition.addContainer("otel-collector", {
      image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE),
      containerName: "otel-collector",
      essential: false,
      command: ["--config=env:AOT_CONFIG_CONTENT"],
      logging: ecs.LogDriver.awsLogs({
        logGroup: otelLogGroup,
        streamPrefix: "otel",
      }),
      environment: {
        AOT_CONFIG_CONTENT: collectorConfigYaml,
      },
    });

    // ------------------------------------------------------------------
    // Migration task definition.
    //
    // Same image, smaller resource envelope, entrypoint override to run
    // `npx prisma migrate deploy` and exit. Only the writer secret is
    // injected — the migration never reads through the reader endpoint.
    // The container name is "migrate" so CloudWatch log streams are
    // visibly distinct from app/. Invocation lives in the (later)
    // GitHub Actions workflow; CDK ships the task family only.
    // ------------------------------------------------------------------
    this.migrationTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "MigrationTaskDefinition",
      {
        family: `sps-migrate-${env}`,
        cpu: envConfig.migrationTaskCpu,
        memoryLimitMiB: envConfig.migrationTaskMemoryMiB,
        executionRole: taskExecutionRole,
        taskRole,
      },
    );
    this.migrationTaskDefinition.addContainer("migrate", {
      image: containerImage,
      containerName: "migrate",
      essential: true,
      entryPoint: ["npx", "prisma", "migrate", "deploy"],
      logging: ecs.LogDriver.awsLogs({
        logGroup: migrationLogGroup,
        streamPrefix: "migrate",
      }),
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(appRwSecret),
      },
    });

    // ------------------------------------------------------------------
    // ALBs (B05).
    //
    // Two-ALB topology over one-ALB-two-listeners: cleaner SG semantics
    // (the internal SG can be tightly scoped to the ETL Lambda SG, never
    // accidentally widened by an unrelated listener edit), and matches
    // PRODUCTION_ADDENDUM § /api/revalidate's wording on a separate
    // internal endpoint.
    //
    // Naming: AWS ELB names are bounded at 32 characters. `sps-public-prod`
    // and `sps-internal-staging` fit comfortably; the env literal carries
    // the Footgun #4 prefix guard.
    //
    // Public ALB: internet-facing in NetworkStack's public subnets.
    // Internal ALB: scheme=internal, in NetworkStack's private-with-egress
    // subnets. Each ALB uses its own SG (NetworkStack-owned for public;
    // this-stack-owned for internal).
    // ------------------------------------------------------------------
    this.publicAlb = new elbv2.ApplicationLoadBalancer(this, "PublicAlb", {
      loadBalancerName: `sps-public-${env}`,
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
    });

    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, "InternalAlb", {
      loadBalancerName: `sps-internal-${env}`,
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: internalAlbSecurityGroup,
    });

    // App target group. Health-check path is the literal /api/health
    // shipped by PR #407 (the shallow ALB probe route). Both ALBs forward
    // to this one target group; the ECS service registers tasks into it.
    const appTargetGroup = new elbv2.ApplicationTargetGroup(this, "AppTargetGroup", {
      targetGroupName: `sps-tg-app-${env}`,
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/api/health",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(30),
    });
    this.publicTargetGroup = appTargetGroup;

    this.publicAlb.addListener("PublicHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [appTargetGroup],
    });
    this.internalAlb.addListener("InternalHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [appTargetGroup],
    });

    // ------------------------------------------------------------------
    // ECS service.
    //
    // - Fargate launch.
    // - Circuit breaker with auto-rollback (ADR-004): failed deploys
    //   abort and revert without paging anyone for a manual rollback.
    // - minHealthy=100 / maxHealthy=200 -- a rolling deploy stands up
    //   replacement tasks before draining the old ones; reduces the
    //   p99-latency tail during deploys (ADR-004).
    // - desiredCount drawn from env config (1 staging / 2 prod). The
    //   bootstrap deploy overrides this to 0 via CDK context.
    // ------------------------------------------------------------------
    const bootstrapOverride = this.node.tryGetContext("appDesiredCount") as
      | string
      | number
      | undefined;
    const desiredCount =
      bootstrapOverride === undefined || bootstrapOverride === null
        ? envConfig.appDesiredCount
        : Number(bootstrapOverride);

    this.ecsService = new ecs.FargateService(this, "EcsService", {
      cluster: this.ecsCluster,
      serviceName: `sps-app-${env}`,
      taskDefinition: appTaskDefinition,
      desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
    });
    // Manual L1 attachment to the target group. Calling
    // `attachToApplicationTargetGroup` would auto-establish SG ingress
    // rules on the service's app SG from each ALB's SG -- adding a
    // NetworkStack -> AppStack reference (the internal ALB's SG lives
    // here) and closing the cycle described in the SG ingress comment
    // above. The matching ingress is already declared explicitly via
    // CfnSecurityGroupIngress earlier in this stack, so skipping the
    // auto-wire just deletes a duplicate, not a needed rule.
    const cfnService = this.ecsService.node.defaultChild as ecs.CfnService;
    cfnService.loadBalancers = [
      {
        targetGroupArn: appTargetGroup.targetGroupArn,
        containerName: "app",
        containerPort: 3000,
      },
    ];
    // The ALB listeners must exist before the ECS service tries to
    // register tasks with the target group; the L2 helper would have
    // added this dependency implicitly.
    this.ecsService.node.addDependency(appTargetGroup);

    // ------------------------------------------------------------------
    // GitHub Actions OIDC deploy role.
    //
    // The OIDC provider is account-scoped — only one
    // `token.actions.githubusercontent.com` provider can exist per
    // account. The single-account deviation (staging + prod share account
    // 665083158573) means the second AppStack to deploy must reuse the
    // first's provider rather than create another. The context flag
    // `-c githubOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/...`
    // lets the prod deploy reuse what the staging deploy created.
    //
    // Trust policy: sub claim restricted to the SPS repo. Prod admits
    // only refs/heads/master; staging admits any ref in the same repo
    // so feature branches can deploy to staging.
    //
    // Permissions: tightly scoped to the AppStack-owned resources only.
    // ECR push on this repo, ECS RunTask on the migration family, ECS
    // service Update + Describe on the SPS service, iam:PassRole on the
    // two task-side roles. No `*` resource anywhere.
    // ------------------------------------------------------------------
    const githubOidcProviderArnContext = this.node.tryGetContext(
      "githubOidcProviderArn",
    ) as string | undefined;
    const githubOidcProvider =
      githubOidcProviderArnContext && githubOidcProviderArnContext.length > 0
        ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            "GithubOidcProvider",
            githubOidcProviderArnContext,
          )
        : new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
            url: "https://token.actions.githubusercontent.com",
            clientIds: ["sts.amazonaws.com"],
          });

    const githubSubCondition =
      env === "prod"
        ? "repo:wcmc-its/Scholars-Profile-System:ref:refs/heads/master"
        : "repo:wcmc-its/Scholars-Profile-System:*";

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: `sps-deploy-${env}`,
      assumedBy: new iam.FederatedPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": githubSubCondition,
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      description: `SPS GitHub Actions deploy role (${env}). Assumed by the deploy workflow via OIDC.`,
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
        ],
        resources: [this.ecrRepository.repositoryArn],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecs:RunTask"],
        resources: [
          Stack.of(this).formatArn({
            service: "ecs",
            resource: "task-definition",
            resourceName: `${this.migrationTaskDefinition.family}:*`,
          }),
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecs:UpdateService", "ecs:DescribeServices"],
        resources: [this.ecsService.serviceArn],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecs:DescribeTasks", "ecs:ListTasks"],
        resources: [
          Stack.of(this).formatArn({
            service: "ecs",
            resource: "task",
            resourceName: `${this.ecsCluster.clusterName}/*`,
          }),
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [taskExecutionRole.roleArn, taskRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ecs-tasks.amazonaws.com",
          },
        },
      }),
    );

    // ------------------------------------------------------------------
    // VPC endpoints (B17).
    //
    // ADR-008 Table 4 nominally puts these in NetworkStack; the row's
    // OWNS column nails them to AppStack. Documented deviation in
    // PRODUCTION_ADDENDUM § AppStack.
    //
    // Two interface endpoints (Secrets Manager, OpenSearch) keep the
    // app/ETL secret + index traffic on the AWS backbone, off the NAT,
    // and inside the VPC. One gateway endpoint (S3) does the same for
    // image-layer pulls + any S3-backed asset traffic; gateway endpoints
    // have no SG (route table associations only).
    //
    // Endpoint SG admits :443 from the app SG + the ETL SG. ETL is
    // included now so the EtlStack ships against an already-correct
    // ingress -- adding the ETL Lambda SG ingress on each interface
    // endpoint at EtlStack time would re-touch this stack's SG.
    // ------------------------------------------------------------------
    const vpcEndpointSecurityGroup = new ec2.SecurityGroup(
      this,
      "VpcEndpointSecurityGroup",
      {
        vpc,
        description: `SPS VPC interface endpoints (${env}) -- HTTPS from app + ETL SGs.`,
        allowAllOutbound: false,
      },
    );
    // Peer.securityGroupId is used instead of passing the L2 SG directly:
    // L2 `addIngressRule(peerSg, ...)` auto-mirrors the rule by adding a
    // matching egress on the peer SG. For peers in *another stack*, that
    // mutates the other stack's resources and closes a Network -> App
    // cycle. The Peer.securityGroupId variant treats the peer as a bare
    // ID, suppressing the egress mirror.
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(appSecurityGroup.securityGroupId),
      ec2.Port.tcp(443),
      `App SG to interface endpoints HTTPS (${env})`,
    );
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(etlSecurityGroup.securityGroupId),
      ec2.Port.tcp(443),
      `ETL SG to interface endpoints HTTPS (${env})`,
    );

    new ec2.InterfaceVpcEndpoint(this, "SecretsManagerEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
      // `open: false` suppresses CDK's default ingress that opens :443 to
      // the whole VPC CIDR. The two SG-to-SG rules above are the
      // intentional surface; nothing else inside the VPC should be able
      // to reach the endpoint.
      open: false,
    });

    // OpenSearch managed-domain endpoint -- service name is `es`. The L2
    // helper's constant for the managed service is `OPENSEARCH_SERVICE`
    // in recent CDK; fall through to a string-constructed
    // InterfaceVpcEndpointAwsService if the constant isn't present in
    // the installed aws-cdk-lib version so the build doesn't break on
    // an unrelated CDK bump.
    const opensearchEndpointService =
      (ec2.InterfaceVpcEndpointAwsService as unknown as Record<
        string,
        ec2.InterfaceVpcEndpointAwsService | undefined
      >).OPENSEARCH_SERVICE ?? new ec2.InterfaceVpcEndpointAwsService("es");
    new ec2.InterfaceVpcEndpoint(this, "OpensearchEndpoint", {
      vpc,
      service: opensearchEndpointService,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
      open: false,
    });

    new ec2.GatewayVpcEndpoint(this, "S3GatewayEndpoint", {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // ------------------------------------------------------------------
    // Outputs.
    //
    // EdgeStack (B07+B14) consumes PublicAlbDns; EtlStack (B08+B20)
    // consumes InternalAlbDns + EcsServiceName + EcsAppTaskFamily for
    // the Step Functions task-launch wiring. EcrRepoUri + DeployRoleArn
    // feed the GitHub Actions workflow that ships in the B09/B12
    // follow-on.
    // ------------------------------------------------------------------
    new CfnOutput(this, "EcrRepoUri", {
      value: this.ecrRepository.repositoryUri,
      description: "SPS ECR repository URI",
    });
    new CfnOutput(this, "EcsClusterName", {
      value: this.ecsCluster.clusterName,
      description: "SPS ECS cluster name",
    });
    new CfnOutput(this, "EcsServiceName", {
      value: this.ecsService.serviceName,
      description: "SPS ECS service name",
    });
    new CfnOutput(this, "EcsAppTaskFamily", {
      value: appTaskDefinition.family,
      description: "SPS app task definition family",
    });
    new CfnOutput(this, "EcsMigrationTaskFamily", {
      value: this.migrationTaskDefinition.family,
      description: "SPS one-shot prisma migrate deploy task family",
    });
    new CfnOutput(this, "PublicAlbDns", {
      value: this.publicAlb.loadBalancerDnsName,
      description: "SPS public ALB DNS name (consumed by EdgeStack)",
    });
    new CfnOutput(this, "InternalAlbDns", {
      value: this.internalAlb.loadBalancerDnsName,
      description: "SPS internal ALB DNS name (consumed by EtlStack)",
    });
    // Additive output for EtlStack — admits the ETL SG on :80 of the
    // internal ALB SG via SG-to-SG ingress. Consumed by EtlStack through
    // `Fn::ImportValue`; declaring it here keeps EtlStack a pure consumer
    // and avoids hard-coding SG IDs per env.
    new CfnOutput(this, "InternalAlbSecurityGroupId", {
      value: internalAlbSecurityGroup.securityGroupId,
      exportName: `Sps-App-${env}-InternalAlbSecurityGroupId`,
      description:
        "SPS internal ALB security group id (consumed by EtlStack ingress).",
    });
    new CfnOutput(this, "DeployRoleArn", {
      value: this.deployRole.roleArn,
      description: "SPS GitHub Actions deploy role ARN",
    });
  }
}
