import * as fs from "node:fs";
import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
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
  "@sha256:8aa9ea5f67b8d318f7d6af24677e3c70f7098bc0631147cb5fa91addbe980b06";

/**
 * WCM SAML IdP coordinates (#466). Identical across staging and prod — WCM
 * confirmed non-prod authenticates against the SAME production IdP, so these
 * are IdP-global constants rather than per-env config. Source of truth is the
 * IdP metadata document:
 *   https://login-proxy.weill.cornell.edu/idp/saml2/idp/metadata.php
 * `SAML_IDP_CERT` (the signing cert) is NOT here — it is a rotatable secret
 * injected from Secrets Manager (`scholars/<env>/saml/idp-cert`).
 */
const WCM_IDP_ENTITY_ID = "https://login-proxy.weill.cornell.edu/idp";
const WCM_IDP_SSO_URL =
  "https://login-proxy.weill.cornell.edu/idp/profile/SAML2/Redirect/SSO";
/**
 * The assertion attribute carrying the bare CWID (#466). Confirmed against a
 * live WCM assertion: a `CWID` attribute resolves to the un-suffixed CWID
 * (e.g. `paa2013`), unlike the `@med.cornell.edu` eppn forms. node-saml keys
 * attributes onto the profile by `Name`, and `extractCwid` reads
 * `profile[SAML_CWID_ATTRIBUTE]`; setting it to `CWID` avoids the NameID
 * fallback (which would otherwise yield the wrong identifier).
 */
const WCM_SAML_CWID_ATTRIBUTE = "CWID";

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
  /**
   * ECR repository for the ETL batch image (the `tsx`-based `etl/*` +
   * `search:index` scripts). Kept separate from the standalone app repo so
   * the two artifacts have independent lifecycle/scan and no `latest`
   * collision; EtlStack pulls from here (#454).
   */
  public readonly etlEcrRepository: ecr.Repository;
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
  /** App task CloudWatch log group; exposed for ObservabilityStack metric filters (B02 edit_authz_denied alarm). */
  public readonly appLogGroup: logs.LogGroup;
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
    // Secrets lookup. SecretsStack defines the full set; AppStack reads the
    // nine the running app consumes (db read/write, opensearch app,
    // revalidate token, session-cookie secret, SAML SP private key, ReciterDB
    // connection, SAML IdP cert, SAML SP cert). Looked up by name so the two
    // stacks stay loosely coupled — no
    // shared stack prop, no cross-stack export. ARNs feed both the
    // task-execution role's tightly-scoped policy and the task definition's
    // `secrets:` block.
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
    // SSO session-cookie encryption key (#100). getSessionConfig() requireEnv's
    // SESSION_COOKIE_SECRET; the middleware gate and the SAML callback both read
    // it, so without it the callback 500s minting the session (the gap sibling
    // to the SAML_* env wiring, #466).
    //
    // Name is "-key", not "-secret": fromSecretNameV2 injects the *suffix-less*
    // ARN into the task def's `secrets:` block, and a name ending in a 6-char
    // token (like "secret") collides with the Secrets Manager random-suffix
    // heuristic, making that ARN unresolvable -> GetSecretValue AccessDenied at
    // task start. See SecretsStack + docs/466-saml-deploy-debrief.md.
    const sessionCookieSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SessionCookieSecret",
      `scholars/${env}/session-cookie-key`,
    );
    const samlSpPrivateKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SamlSpPrivateKeySecret",
      `scholars/saml-sp/${env}/private-key`,
    );
    // ReciterDB connection (RePORTER funding + mentoring surfaces). The app
    // reads SCHOLARS_RECITERDB_* at request time; same secret + JSON keys the
    // ETL task already consumes (#442). Without this the reciter-backed page
    // sections fail at render and error-boundary out (#460 follow-on).
    const etlReciterSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EtlReciterSecret",
      `scholars/${env}/etl/reciter`,
    );
    // SAML IdP signing cert — the trust anchor for assertion-signature
    // verification (#466). Injected as SAML_IDP_CERT; a secret (not env) so
    // the 2026-08-19 IdP cert rollover is a value rotation, not a code
    // deploy. SecretsStack defines the stub; seed both rollover PEMs
    // concatenated out-of-band.
    const samlIdpCertSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SamlIdpCertSecret",
      `scholars/${env}/saml/idp-cert`,
    );
    // SP public cert — published in SP metadata (#466). node-saml's
    // generateServiceProviderMetadata throws when the SP private key is set
    // but no public cert is supplied, so /api/auth/saml/metadata 503s without
    // this. Injected as SAML_SP_CERT; the value is public but provisioned
    // out-of-band like its paired private key.
    const samlSpCertSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SamlSpCertSecret",
      `scholars/saml-sp/${env}/cert`,
    );

    // The exhaustive list of nine consumer ARNs. The task-execution role's
    // `secretsmanager:GetSecretValue` resource list is this exact array
    // (assertion in app-stack.test.ts). No `*` resource; no other secrets.
    const consumerSecretArns: string[] = [
      appRwSecret.secretArn,
      appRoSecret.secretArn,
      opensearchAppSecret.secretArn,
      revalidateTokenSecret.secretArn,
      samlSpPrivateKeySecret.secretArn,
      etlReciterSecret.secretArn,
      samlIdpCertSecret.secretArn,
      samlSpCertSecret.secretArn,
      sessionCookieSecret.secretArn,
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

    // Dedicated ETL batch-image repo (#454). Same scan + lifecycle posture
    // as the app repo, but a separate repository so ETL images don't share
    // the app repo's 30-tag retention window or its `latest` tag. EtlStack
    // pulls from here; the deploy workflow builds `--target etl` and pushes.
    this.etlEcrRepository = new ecr.Repository(this, "EtlEcrRepository", {
      repositoryName: `scholars-etl-${env}`,
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

    // Transitional cross-stack-export retention (#454 follow-up). EtlStack used
    // to consume the app repo's ARN + name as auto-generated cross-stack
    // exports; PR #455 repointed it to the dedicated ETL repo, so CDK would now
    // drop those two exports. CloudFormation refuses to delete an export still
    // imported by another stack, and the *currently deployed* EtlStack still
    // imports them -- so an App-stack update that removes them rolls back. Pin
    // them with the same auto-generated names for the transition deploy (App
    // adds the ETL repo + its exports while keeping these; then EtlStack
    // redeploys onto the ETL repo and stops importing them). Remove these two
    // lines in a cleanup once every env's Sps-Etl-* no longer imports them.
    this.exportValue(this.ecrRepository.repositoryArn);
    this.exportValue(this.ecrRepository.repositoryName);

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
    this.appLogGroup = appLogGroup;
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
    //   only; secrets:GetSecretValue on the nine consumer ARNs only; logs
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
    // Secrets — exactly the nine consumer ARNs. Asserted in tests.
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
        // OpenSearch domain endpoint (https://...) imported from DataStack.
        // lib/search.ts reads OPENSEARCH_NODE; the OPENSEARCH_USER/PASS
        // secrets below supply the FGAC basic-auth credentials. #447
        OPENSEARCH_NODE: `https://${Fn.importValue(
          `Sps-Data-${env}-OpenSearchDomainEndpoint`,
        )}`,
        // SAML SP non-secret config (#466). Without these, getSamlEnv()'s
        // requireEnv throws on the first missing var and every SAML route
        // 503s ("SAML SP is not configured"); SP-initiated sign-in is dead.
        // SAML_IDP_CERT is the one SAML value that is NOT here -- it is the
        // rotatable trust anchor, injected as a secret below. The IdP-side
        // values are IdP-global constants (shared prod IdP); the SP entityID
        // + ACS URL are per-env off the public host (envConfig). E2E login
        // additionally needs the app-CNAME DNS live so the IdP can redirect
        // the browser back to the ACS URL.
        SAML_IDP_ENTITY_ID: WCM_IDP_ENTITY_ID,
        SAML_IDP_SSO_URL: WCM_IDP_SSO_URL,
        SAML_SP_ENTITY_ID: envConfig.samlSpEntityId,
        SAML_SP_ACS_URL: envConfig.samlSpAcsUrl,
        SAML_CWID_ATTRIBUTE: WCM_SAML_CWID_ATTRIBUTE,
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
        // Read by lib/revalidate-auth.ts / app/api/revalidate as
        // SCHOLARS_REVALIDATE_TOKEN -- the env-var name is the contract. #447
        SCHOLARS_REVALIDATE_TOKEN:
          ecs.Secret.fromSecretsManager(revalidateTokenSecret),
        // iron-session key read by lib/auth/config.ts getSessionConfig (#100).
        // Required by the /edit middleware gate and the SAML callback's
        // session minting; without it the callback 500s after a valid login.
        SESSION_COOKIE_SECRET: ecs.Secret.fromSecretsManager(sessionCookieSecret),
        SAML_SP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(samlSpPrivateKeySecret),
        // SAML IdP signing cert(s), whole-secret PEM (#466). parseIdpCert
        // accepts one or many concatenated PEM blocks, so the 2026-08-19
        // rollover is a Secrets Manager value swap with no code change.
        SAML_IDP_CERT: ecs.Secret.fromSecretsManager(samlIdpCertSecret),
        // SP public cert (#466) — required by generateServiceProviderMetadata
        // once the SP private key is set, else /api/auth/saml/metadata 503s.
        SAML_SP_CERT: ecs.Secret.fromSecretsManager(samlSpCertSecret),
        // ReciterDB connection vars. The env-var name == the secret's JSON key
        // (#442); the running app reads these via lib/sources/reciterdb.ts.
        SCHOLARS_RECITERDB_HOST: ecs.Secret.fromSecretsManager(
          etlReciterSecret,
          "SCHOLARS_RECITERDB_HOST",
        ),
        SCHOLARS_RECITERDB_PORT: ecs.Secret.fromSecretsManager(
          etlReciterSecret,
          "SCHOLARS_RECITERDB_PORT",
        ),
        SCHOLARS_RECITERDB_DATABASE: ecs.Secret.fromSecretsManager(
          etlReciterSecret,
          "SCHOLARS_RECITERDB_DATABASE",
        ),
        SCHOLARS_RECITERDB_USERNAME: ecs.Secret.fromSecretsManager(
          etlReciterSecret,
          "SCHOLARS_RECITERDB_USERNAME",
        ),
        SCHOLARS_RECITERDB_PASSWORD: ecs.Secret.fromSecretsManager(
          etlReciterSecret,
          "SCHOLARS_RECITERDB_PASSWORD",
        ),
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

    // App target groups -- one per ALB. AWS enforces a 1:1 relationship
    // between a target group and a load balancer (the constraint surfaces
    // at the second listener-create as "target groups cannot be
    // associated with more than one load balancer" -- blocker #6 of
    // #431, 2026-05-21). The two-ALB topology therefore needs two TGs;
    // both register the same ECS task (container "app", port 3000), so
    // every running task is reachable from both the public and internal
    // listeners. Health-check path and deregistration delay are
    // identical across the pair.
    const tgProps: elbv2.ApplicationTargetGroupProps = {
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
    };
    // TG names: bounded at 32 chars (asserted in app-stack.test.ts).
    // `sps-tg-pub-${env}` / `sps-tg-int-${env}` keep room for any future
    // env literal up to ~16 chars before the limit bites.
    const publicAppTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "PublicAppTargetGroup",
      { ...tgProps, targetGroupName: `sps-tg-pub-${env}` },
    );
    const internalAppTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "InternalAppTargetGroup",
      { ...tgProps, targetGroupName: `sps-tg-int-${env}` },
    );
    // Public TG is the one ObservabilityStack alarms watch (RequestCount,
    // UnhealthyHostCount, etc. on the customer-facing path). The
    // internal TG carries only intra-VPC /api/revalidate traffic which
    // has its own latency/error budget and isn't on the public SLO.
    this.publicTargetGroup = publicAppTargetGroup;

    // Public listener (B07 origin protection). Default action is a bare
    // 403: a client that lands here without CloudFront's shared secret
    // header (`X-Origin-Verify`) gets denied. The priority-1 rule that
    // matches the header value -- and only that rule -- forwards to the
    // app target group. Without this split, the public ALB DNS becomes a
    // back-door bypass of every CloudFront cache-behavior decision (and
    // any future WAF), since CloudFront-to-ALB runs over HTTP today and
    // the DNS name is trivially discoverable.
    //
    // The expected header value is read from SecretsStack at deploy time
    // via a CFN dynamic reference (`{{resolve:secretsmanager:...}}`); the
    // value itself never appears in the synthesized template. The
    // EdgeStack origin sends the same dynamic reference as the custom
    // header on every forwarded request, so the two stacks pick up the
    // same rotated value at deploy.
    // CFN dynamic reference for the X-Origin-Verify rule's header value
    // (blocker #5 of #431, 2026-05-21). `Secret.fromSecretNameV2(...).
    // secretValue` emits a *partial-ARN* dynamic reference -- the form
    // `{{resolve:secretsmanager:arn:aws:secretsmanager:<region>:<acct>:
    // secret:<name>:SecretString:::}}` with no random suffix. CDK synth
    // accepts it; AWS Secrets Manager rejects it at deploy time with
    // `ResourceNotFoundException` (the resolver requires either the
    // friendly name alone OR the *full* ARN including the random suffix
    // -- the partial-ARN form is silently invalid).
    //
    // `SecretValue.secretsManager(name)` emits the friendly-name form
    // (`{{resolve:secretsmanager:<name>:SecretString:::}}`), which AWS
    // accepts. The synth-time guard in app-stack.test.ts asserts the
    // emitted Values entry does not contain the literal
    // `arn:aws:secretsmanager` (i.e. is not the partial-ARN form), so a
    // future regression fails at jest instead of `cdk deploy`.
    const originSharedSecretValue = SecretValue.secretsManager(
      `scholars/${env}/edge/origin-shared-secret`,
    );
    const publicListener = this.publicAlb.addListener("PublicHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Forbidden",
      }),
    });
    // Constructed as an explicit L1 rule (rather than via the void-returning
    // `publicListener.addAction(...)`) so we hold a handle and can add it to
    // the ECS service's DependsOn list below. The TG-to-public-ALB
    // association lives on this rule (the listener's default action is a
    // 403, not a forward), so it is the resource that satisfies AWS's
    // "target group must have an associated load balancer" check on the
    // public side -- see the EcsService dependency comment further down.
    const originVerifiedRule = new elbv2.ApplicationListenerRule(
      this,
      "OriginVerifiedForward",
      {
        listener: publicListener,
        priority: 1,
        conditions: [
          elbv2.ListenerCondition.httpHeader("X-Origin-Verify", [
            originSharedSecretValue.unsafeUnwrap(),
          ]),
        ],
        action: elbv2.ListenerAction.forward([publicAppTargetGroup]),
      },
    );
    const internalListener = this.internalAlb.addListener("InternalHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [internalAppTargetGroup],
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
        targetGroupArn: publicAppTargetGroup.targetGroupArn,
        containerName: "app",
        containerPort: 3000,
      },
      {
        targetGroupArn: internalAppTargetGroup.targetGroupArn,
        containerName: "app",
        containerPort: 3000,
      },
    ];
    // The ALB listeners must exist before the ECS service tries to
    // register tasks with the target group; the L2 helper would have
    // added this dependency implicitly.
    //
    // CFN dependency-class fix (issue #431, blocker #4 on 2026-05-21).
    // Because the service is L1-attached via `cfnService.loadBalancers`
    // (rather than via `attachToApplicationTargetGroup` — see SG cycle
    // note above), CDK does NOT auto-infer that the service must wait
    // for the listeners that bind the target group to a load balancer.
    // Without these explicit deps, CFN creates the EcsService in
    // parallel with the listeners, and AWS rejects RegisterTargets with
    // "target group <name> does not have an associated load balancer."
    // Every resource that establishes a TG -> LB association must be
    // an upstream dependency of the service:
    //   - internalListener: associates the TG via its DefaultActions.
    //   - originVerifiedRule: the priority-1 rule on the public listener
    //     that forwards to the TG (the listener's own default action is
    //     a fixed-response 403, so the rule -- not the listener -- is
    //     what creates the public-side TG/LB association).
    // The publicListener dependency is added for completeness; the rule
    // itself transitively depends on the listener so this is belt-and-
    // suspenders, but it keeps the intent self-evident in a refactor.
    this.ecsService.node.addDependency(publicAppTargetGroup);
    this.ecsService.node.addDependency(internalAppTargetGroup);
    this.ecsService.node.addDependency(publicListener);
    this.ecsService.node.addDependency(originVerifiedRule);
    this.ecsService.node.addDependency(internalListener);

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
    // Permissions: tightly scoped to the AppStack-owned resources. ECR
    // push on both the app and the ETL (#454) image repos, ECS RunTask on
    // the migration family, ECS service Update + Describe on the SPS
    // service, ECS task Describe/List on the cluster, iam:PassRole on the
    // two task-side roles, and cloudformation:DescribeStacks on this stack
    // (the deploy workflow reads the AppStack outputs to discover the ECR
    // URIs, cluster, service, and migration family). The only `*` resource
    // is ecr:GetAuthorizationToken, which has no resource-level ARN.
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
        // Both image repos: the standalone app image and the dedicated
        // ETL batch image (#454) the deploy workflow builds + pushes.
        resources: [
          this.ecrRepository.repositoryArn,
          this.etlEcrRepository.repositoryArn,
        ],
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
    // The deploy workflow's "Discover AppStack outputs" step calls
    // `aws cloudformation describe-stacks --stack-name Sps-App-<env>` to
    // read the ECR URIs, cluster, service, and migration-task family. Scope
    // to this stack only -- the wildcard tail matches the stack-id suffix
    // CloudFormation appends to the ARN.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "stack",
            resourceName: `${this.stackName}/*`,
          }),
        ],
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
    new CfnOutput(this, "EtlEcrRepoUri", {
      value: this.etlEcrRepository.repositoryUri,
      description: "SPS ETL batch-image ECR repository URI (#454)",
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
