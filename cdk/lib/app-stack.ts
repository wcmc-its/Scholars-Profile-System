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
/**
 * Trusted eppn scopes for the federated-login CWID fallback. The WCM-direct
 * route releases the `CWID` attribute above; NYP / WCM-Q logins arrive through
 * the SAML proxy WITHOUT it but WITH eppn (`<cwid>@<scope>`) — captured from a
 * live `paa2013@nyp.org` assertion 2026-05-31. `extractCwidFromEppn` takes the
 * eppn local-part as the CWID ONLY for these scopes, so an arbitrary domain is
 * never stripped. Both are WCM-controlled domains, so allowlisting them adds no
 * attack surface — only the proxy (federating these trusted upstreams) can
 * assert an eppn scoped to them.
 *   - `nyp.org`              — CONFIRMED from a live NYP assertion 2026-05-31.
 *   - `qatar-med.cornell.edu` — ANTICIPATED from WCM-Q's faculty email domain
 *     (facultyaffairs@qatar-med.cornell.edu); the proxy passes upstream eppn
 *     scopes through unchanged (NYP arrived as `@nyp.org`), and for NYP the
 *     email domain matched the eppn scope exactly. VERIFY against a live WCM-Q
 *     login and correct here if the real scope differs (until then a WCM-Q
 *     login simply no-ops this entry and fails closed — no security impact).
 */
const WCM_SAML_EPPN_TRUSTED_SCOPES = "nyp.org,qatar-med.cornell.edu";

/**
 * The verified SES sender for the #160 Phase 2 "Request a change" server mailer.
 * Shared by the task-role `ses:FromAddress` condition and the app `SCHOLARS_MAIL_
 * FROM` env var so the IAM grant and the runtime From can never drift. Verifying
 * this identity (DKIM CNAMEs) + leaving the SES sandbox are ops steps
 * (docs/ses-sender-verification.md); the send stays dormant until then.
 */
const SCHOLARS_MAIL_FROM = "no-reply-scholars@weill.cornell.edu";

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
  public readonly dbBootstrapTaskDefinition: ecs.FargateTaskDefinition;
  /** Family-only handle to the one-shot grant-equality verify task (ADR-009). */
  public readonly verifyGrantsTaskDefinition: ecs.FargateTaskDefinition;
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
    // eleven the app + sidecars consume (db read/write, opensearch app,
    // revalidate token, session-cookie secret, SAML SP private key, ReciterDB
    // connection, SAML IdP cert, SAML SP cert, db-bootstrap DSN, and the New
    // Relic ingest key consumed by the ADOT collector). Looked up by name so the two
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
    // Least-privilege DSN for the one-shot sps-db-bootstrap task that provisions
    // the scholars_audit database + the app-rw INSERT grant before migrate
    // (#493). The sps_bootstrap user holds only CREATE/ALTER on scholars_audit.*
    // and INSERT there WITH GRANT OPTION -- never master, nothing on `scholars`.
    const bootstrapDsnSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "BootstrapDsnSecret",
      `scholars/${env}/db/bootstrap`,
    );
    // Deploy-time-only migration DSN (ADR-009). The sps_migrate user holds the
    // DDL on `scholars.*` that `prisma migrate deploy` needs; reducing app_rw to
    // DML-only (Phase 3) leaves this as the only DDL-bearing credential, and it
    // is injected ONLY into the one-shot migrate task -- never the 24/7 app. The
    // "/migrate" tail (7 chars, no leading dash) sidesteps the Secrets Manager
    // 6-char-tail partial-ARN gotcha. SecretsStack defines the stub; the
    // DataStack seeder mints the user + populates this secret (Phase 1).
    const migrateSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "MigrateSecret",
      `scholars/${env}/db/migrate`,
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
    // New Relic ingest license key (B24 observability). Injected into the ADOT
    // collector sidecar (NOT the app container) as NEW_RELIC_LICENSE_KEY and
    // read by otel-collector-config.yaml's otlphttp/newrelic exporter via
    // ${env:...}. The "-key" tail (3 chars) sidesteps the Secrets Manager
    // 6-char-tail partial-ARN gotcha. SecretsStack defines the stub.
    const newRelicLicenseKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "NewRelicLicenseKeySecret",
      `scholars/${env}/newrelic-license-key`,
    );
    // #742 — Vercel AI Gateway API key for the /edit overview-statement
    // generator. Injected into the APP container (not the ADOT sidecar) as
    // AI_GATEWAY_API_KEY; lib/seo/llm-client.ts reads it for the gateway call.
    // The "-key" tail (3 chars) sidesteps the Secrets Manager 6-char-tail
    // partial-ARN gotcha. SecretsStack defines the stub.
    const aiGatewayApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AiGatewayApiKeySecret",
      `scholars/${env}/ai-gateway-api-key`,
    );

    // ADR-009 exec-role split -- two execution roles, two secret-ARN lists:
    //
    // - appConsumerSecretArns: what the 24/7 app TASK consumes (app container +
    //   ADOT sidecar). This is the app task-execution role's
    //   `secretsmanager:GetSecretValue` resource list -- exactly these, no `*`,
    //   and crucially NOT the migrate DSN (req 4: the DDL-capable migrate
    //   credential must never be readable by the internet-adjacent app role).
    //   `bootstrap` is also gone -- it moved to the deploy role with the
    //   db-bootstrap task, so the app role sheds a grant it never used.
    // - deployConsumerSecretArns: what the deploy-time tasks (migrate,
    //   verify-grants, db-bootstrap) consume, on a separate short-lived
    //   execution role. The migrate DSN lives ONLY here.
    //
    // Both lists are asserted in app-stack.test.ts.
    const appConsumerSecretArns: string[] = [
      appRwSecret.secretArn,
      appRoSecret.secretArn,
      opensearchAppSecret.secretArn,
      revalidateTokenSecret.secretArn,
      samlSpPrivateKeySecret.secretArn,
      etlReciterSecret.secretArn,
      samlIdpCertSecret.secretArn,
      samlSpCertSecret.secretArn,
      sessionCookieSecret.secretArn,
      // New Relic ingest key (B24): consumed by the ADOT collector sidecar,
      // not the app container. Execution role still needs GetSecretValue on it.
      newRelicLicenseKeySecret.secretArn,
      // #742 AI Gateway key: consumed by the app container's overview generator.
      aiGatewayApiKeySecret.secretArn,
    ];
    // The deploy-time tasks' DSNs (ADR-009). migrate injects only the migrate
    // DSN; verify-grants injects all four role DSNs; db-bootstrap injects
    // bootstrap + app-rw. The union is these four -- and the migrate DSN appears
    // on no other execution role (req 4, asserted).
    const deployConsumerSecretArns: string[] = [
      appRoSecret.secretArn,
      appRwSecret.secretArn,
      bootstrapDsnSecret.secretArn,
      migrateSecret.secretArn,
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
    // db-bootstrap task log group (#493) — distinct stream from migrate so the
    // audit-provisioning output is visibly separate in CloudWatch.
    const dbBootstrapLogGroup = new logs.LogGroup(this, "DbBootstrapLogGroup", {
      logGroupName: `/aws/ecs/sps-db-bootstrap-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // grant-equality verify task log group (ADR-009 Phase 0) — distinct stream
    // so the per-role SHOW GRANTS diff output is separable from db-bootstrap.
    const verifyGrantsLogGroup = new logs.LogGroup(this, "VerifyGrantsLogGroup", {
      logGroupName: `/aws/ecs/sps-verify-grants-${env}`,
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
    // - **Task-execution role** (`taskExecutionRole`) is the role ECS assumes
    //   for the 24/7 APP task to pull the image, inject secrets, and write log
    //   streams. Tightly scoped: ECR auth + Batch* on the app repo only;
    //   secrets:GetSecretValue on the ten app consumer ARNs only (ADR-009: no
    //   migrate, no bootstrap); logs on the app + ADOT-sidecar groups only.
    // - **Deploy execution role** (`deployTaskExecutionRole`, ADR-009) is the
    //   parallel role for the short-lived deploy-time tasks (migrate,
    //   verify-grants, db-bootstrap). It -- and only it -- can read the migrate
    //   DSN, keeping the DDL-capable credential off the internet-adjacent app
    //   role (req 4). No `*` resource on either beyond ecr:GetAuthorizationToken.
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
    // Secrets -- exactly the ten app consumer ARNs (ADR-009 split: no migrate,
    // no bootstrap). Asserted in tests.
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: appConsumerSecretArns,
      }),
    );
    // Logs -- the app task's own groups only (app container + ADOT sidecar).
    // ADR-009: the migrate / db-bootstrap / verify-grants groups moved to the
    // deploy execution role with their tasks. (awsLogs() also auto-grants the
    // driving execution role write on each group; this explicit block is the
    // documented, asserted scope.)
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          appLogGroup.logGroupArn,
          `${appLogGroup.logGroupArn}:*`,
          otelLogGroup.logGroupArn,
          `${otelLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    // ------------------------------------------------------------------
    // Deploy-time execution role (ADR-009 exec-role split).
    //
    // The migrate / verify-grants / db-bootstrap tasks run for seconds during a
    // deploy, not 24/7. They get their OWN execution role so the migrate DSN --
    // which carries `scholars.*` DDL -- is injectable into them and ONLY them.
    // The app role (above) deliberately lacks it (req 4): a runtime compromise
    // of the internet-adjacent app cannot even read the DDL-capable credential.
    //
    // Same shape as the app role: ECR auth + Batch* on BOTH repos (migrate runs
    // the app image; db-bootstrap + verify-grants run the ETL image),
    // GetSecretValue on the four deploy ARNs only, logs on the three deploy
    // groups only. fromEcrRepository()/awsLogs() also auto-grant these; the
    // explicit blocks are the documented, asserted least-privilege contract.
    // ------------------------------------------------------------------
    const deployTaskExecutionRole = new iam.Role(this, "DeployExecutionRole", {
      roleName: `sps-deploy-exec-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS ECS deploy-time task-execution role (${env}). Migrate/verify/db-bootstrap only; the sole reader of the migrate DSN.`,
    });
    deployTaskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    deployTaskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [
          this.ecrRepository.repositoryArn,
          this.etlEcrRepository.repositoryArn,
        ],
      }),
    );
    // Secrets -- exactly the four deploy ARNs (incl. the migrate DSN, which is
    // on no other role). Asserted in tests.
    deployTaskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: deployConsumerSecretArns,
      }),
    );
    // Logs -- the three deploy-task groups + their streams.
    deployTaskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          migrationLogGroup.logGroupArn,
          `${migrationLogGroup.logGroupArn}:*`,
          dbBootstrapLogGroup.logGroupArn,
          `${dbBootstrapLogGroup.logGroupArn}:*`,
          verifyGrantsLogGroup.logGroupArn,
          `${verifyGrantsLogGroup.logGroupArn}:*`,
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
    // SES send grant (#160 Phase 2 -- "Request a change" server mailer).
    //
    // POST /api/edit/request-change sends one email to the office that owns
    // the data. A custom *inline* policy with the single action ses:SendEmail,
    // scoped by an `ses:FromAddress` condition to exactly the no-reply sender.
    // Conditioning on the From (not just the identity ARN) is tighter and is
    // independent of whether the sender is later verified as an email or a
    // domain identity. Resource stays SES-identity-scoped -- never a bare `*`.
    //
    // Dormant until SELF_EDIT_REQUEST_CHANGE_SEND=on (the env var below ships
    // "off") AND the identity is verified + the account is out of the SES
    // sandbox (ops -- docs/ses-sender-verification.md). No EmailIdentity
    // construct: a no-reply mailbox can't complete email-link verification, and
    // the real path is a DKIM/domain identity owned in WCM DNS, so the resource
    // is granted by ARN pattern + From condition and verified out-of-band.
    //
    // Contains no secretsmanager reference, so the "zero secretsmanager on the
    // task role" assertion still holds; app-stack.test.ts adds the SES-scope
    // assertions (single action, From condition, identity-scoped resource).
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleSesPolicy", {
      policyName: `sps-task-${env}-ses`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ses:SendEmail"],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
          conditions: {
            StringEquals: { "ses:FromAddress": SCHOLARS_MAIL_FROM },
          },
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
    // The ETL batch image (#454) — the only image with `tsx` + the source tree +
    // the `mariadb` client, so it is what runs the tsx-based db-bootstrap script
    // (#493). The standalone app image has none of those.
    const etlContainerImage = ecs.ContainerImage.fromEcrRepository(
      this.etlEcrRepository,
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
        // service.name resource attr -- this is the entity name in BOTH New
        // Relic (otlphttp/newrelic exporter) and the X-Ray service map, so the
        // two stay consistent. Per-env (Scholars-staging / Scholars-prod) keeps
        // staging and prod as distinct entities so alerts never mix them.
        OTEL_SERVICE_NAME: `Scholars-${env}`,
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
        // Federated-login CWID fallback (NYP / WCM-Q via the SAML proxy). The
        // proxy drops the `CWID` attribute on those routes but keeps eppn; this
        // lets those users self-edit. Scope allowlist is the security guard.
        SAML_EPPN_TRUSTED_SCOPES: WCM_SAML_EPPN_TRUSTED_SCOPES,
        // #160 Phase 2 -- "Request a change" server mailer. Ships OFF: while
        // off the endpoint 503s and the dialog falls back to the Phase-1 client
        // mailto:. Flip to "on" only after the SES sender identity is verified
        // + the account leaves the SES sandbox (docs/ses-sender-verification.md).
        // SCHOLARS_MAIL_FROM is the same address the task-role grant conditions
        // on, so the From and the IAM scope can't drift.
        SELF_EDIT_REQUEST_CHANGE_SEND: "off",
        SCHOLARS_MAIL_FROM,
        // Per-cwid hourly cap on the server send (SPEC § 5 abuse controls).
        // Superusers are exempt; the app defaults to this same value if unset.
        // Surfaced here as an explicit, tunable knob: ratchet from the 429 logs
        // rather than redeploy code to change a number.
        SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT: "20",
        // #728 -- ED admin-role org-unit managers (the /edit/administrators
        // tab). All three read `=== "on"` exactly.
        //   SELF_EDIT_ADMINISTRATORS_TAB -> the tab (superuser + unit Owners).
        //     ON in both envs: surfaces the existing manual owner/curator grants
        //     plus the audited add/edit-role/revoke controls. The `ed_locked`
        //     read-only gate is unconditional (not flag-gated).
        //   SELF_EDIT_ED_ADMINS_IMPORT -> the Web-Directory importer writes.
        //     OFF: the LDAP pull is blocked by #443 (fail-closed empty -- zero
        //     rows, zero deletes) and it is not in a scheduled Step Function
        //     yet, so the tab shows only manual grants until that lands.
        //   SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY -> narrows informal-center
        //     creation to superusers. OFF: it REMOVES a parent-dept Owner's
        //     create path, a behaviour change gated on the OQ-8a stakeholder
        //     sign-off; ships dark until then.
        SELF_EDIT_ADMINISTRATORS_TAB: "on",
        SELF_EDIT_ED_ADMINS_IMPORT: "off",
        SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY: "off",
        // #746 — self-edit "Not mine" → ReCiter gold-standard reject.
        // STAGING-FIRST rollout: ON in staging, OFF in prod until the staging
        // soak completes (prod flips in a follow-up). While off, "Not mine?"
        // keeps the Publication-Manager off-ramp. The ReCiter admin key lives
        // ONLY in the ETL task, so the app just records the reject locally and
        // the etl:reciter-refresh scanner propagates it to the gold standard +
        // fires the delayed re-score.
        RECITER_REJECT_SEND: env === "staging" ? "on" : "off",
        // SELF_EDIT_COI_GAP_HINT — the self-only "From your publications" panel
        // (relationships named in a scholar's own PubMed competing-interest
        // statements that aren't in their current WRG disclosures) + its disavow
        // endpoint. ENABLED in both envs by operator decision (the source is
        // productionized like any other — see docs/coi-pubmed-suggestion-approach.md):
        // the concept/copy gate is signed off; the High-tier precision-labeling
        // pass (docs/coi-pubmed-HANDOFF.md § C.2) is an accepted-residual follow-up,
        // not a blocker. The panel only renders when candidates exist for a
        // genuine (non-impersonating) self viewer, so it stays invisible until the
        // nightly etl:coi-gap source has seeded data in that env. Prod takes
        // effect only on an approval-gated `cdk deploy Sps-App-prod`.
        SELF_EDIT_COI_GAP_HINT: "on",
        // #497 -- self-serve slug ("Profile URL") request lifecycle: the scholar
        // request card, the superuser /edit/slug-requests approve/decline queue,
        // and the requester notification (PRs #503/#504/#505). Read via
        // isSlugRequestEnabled() (=== "on"); when off the card is hidden,
        // /edit/slug-requests 404s, and all three /api/edit/slug-request
        // endpoints 404. The risky half -- override->routing reconcile -- already
        // ships and runs on the live superuser direct-edit path
        // (reconcileScholarSlug, lib/slug.ts), so a flip changes only who can
        // initiate a slug change, not the routing mechanics. Enabled in BOTH
        // envs (product decision 2026-06-03; no staging-only soak). Takes effect ONLY on
        // a manual `cdk deploy --exclusively Sps-App-<env>` -- the CD pipeline
        // re-rolls the image and never deploys CDK. The in-app "you'll get an
        // email when it's decided" line additionally needs the request-change
        // mailer (SELF_EDIT_REQUEST_CHANGE_SEND above) + a verified
        // SCHOLARS_MAIL_FROM; until that flips the requester is notified in-app
        // only, and the decision never fails for a missing email.
        SELF_EDIT_SLUG_REQUEST: "on",
        // #742 -- the /edit Overview "Generate a draft" surface: the Existing /
        // Generator tabs, the Sources drawer, and the AI overview-statement
        // generator. overviewGenerateEnabled() reads === "on"
        // (lib/edit/overview-generator.ts); when off there are NO tabs and the
        // Overview surface is byte-identical to the manual editor. Enabled in
        // BOTH envs per operator decision 2026-06-05. HARD DEPENDENCY: the app
        // task must carry AI_GATEWAY_API_KEY (wired into `secrets:` below) -- with
        // the flag on but the key unset, "Generate a draft" 500s
        // (lib/seo/llm-client.ts throws). Methods/metrics grounding also needs
        // the scholar_tool migration applied + etl:dynamodb run in that env. The
        // spec's validation-run gate (>=4/5 publishable, 0 faithfulness
        // violations; scripts/edit/overview-validation.ts) is tracked separately
        // in #742. Takes effect ONLY on a manual `cdk deploy --exclusively
        // Sps-App-<env>` (the CD pipeline re-rolls the image, never CDK).
        SELF_EDIT_OVERVIEW_GENERATE: "on",
        // #538 -- site-wide feedback badge + /about/feedback form. When "on",
        // the badge renders on every page (except /about/feedback itself,
        // suppressed inside open Radix Dialogs) and the form route accepts
        // submissions. When "off" the badge does not render and the form
        // route returns 404. Enabled in both envs at launch; the IRB exempt-
        // determination is being handled out of band by the project lead per
        // docs/feedback-badge-spec.md § IRB / governance.
        FEEDBACK_BADGE_ENABLED: "on",
        // Origin allowlist the submit endpoint validates the request's
        // `Origin` header against. Derived from the SAML ACS URL so the env
        // can't drift between the two; same `https://<public-host>` value.
        FEEDBACK_SITE_ORIGIN: new URL(envConfig.samlSpAcsUrl).origin,
        // #760 -- launch-period "Beta" pill beside the Scholars wordmark.
        // DEFAULT ON: the header reads `=== "off"` (isBetaBadgeEnabled), so the
        // badge shows in both envs while we're in beta. Wired here explicitly so
        // the off-switch is discoverable and flag parity holds (local == deployed).
        // Retire at full launch by setting this to "off" and `cdk deploy
        // Sps-App-<env>` -- no code revert (CD re-rolls the image only, so an
        // env-flag change requires an explicit cdk deploy).
        SHOW_BETA_BADGE: "on",
        // #688 / #692 -- search query-interpretation flags. Graduated to prod
        // parity after the staging UAT + SPEC §8 eval: the #692 generic-term
        // de-highlight and the #688 "Why this match" MeSH-provenance note now
        // run in BOTH envs. resolveGenericTermMode reads off|resolve|on;
        // resolvePeopleMatchProvenance reads on|off (lib/api/search-flags.ts).
        SEARCH_GENERIC_TERM_DEMOTE: "on",
        SEARCH_PEOPLE_MATCH_PROVENANCE: "on",
        // #713 / #702 / #707 -- "Why this match" explanation lines. Brought to
        // local-dev parity (these were on in .env.local but never wired here, so
        // the features worked locally and were silently off in staging+prod):
        //   SEARCH_PEOPLE_MATCH_EXPLAIN  -> People-tab "N of M publications
        //     tagged {concept}" / "mention {term}" reason line (adds one bounded
        //     per-page publications agg; resolvePeopleMatchExplain reads === on).
        //   SEARCH_PUB_HIGHLIGHT         -> Publications-tab title highlight.
        //   SEARCH_PUB_MATCH_PROVENANCE  -> Publications-tab match provenance.
        // All three are query-time/render-only (no reindex prereq).
        SEARCH_PEOPLE_MATCH_EXPLAIN: "on",
        SEARCH_PUB_HIGHLIGHT: "on",
        SEARCH_PUB_MATCH_PROVENANCE: "on",
        // #295 / #723 -- funding-tab concept clause + result-SET gate field.
        // Enabled in both envs now that the funding index carries the descriptor
        // rollup. `fundedPubMeshUi` is the higher-fidelity gate (funded-pub MeSH)
        // and is safe ONLY after the funding index is reindexed with that field
        // (lib/funding-projection.ts), so `cdk deploy Sps-App-prod` MUST follow
        // the prod `search:index` reindex -- otherwise prod funding-concept
        // results empty out. resolveFundingConceptEnabled reads === "on";
        // resolveFundingMeshGateField reads === "fundedPubMeshUi".
        SEARCH_FUNDING_TAB_CONCEPT: "on",
        SEARCH_FUNDING_MESH_GATE: "fundedPubMeshUi",
        // #637 "View as" impersonation -- the global feature gate. The code
        // checks `=== "true"` exactly (lib/auth/effective-identity.ts,
        // middleware.ts, the /api/impersonation* routes, the /api/auth/session
        // probe), so the value is the literal string "true", not "on". When
        // unset/anything-else the whole feature is dark: /api/impersonation*
        // 404s, the switcher hides, any overlay is ignored. Requires the
        // `/api/impersonation*` EdgeStack behavior to be deployed FIRST (else
        // cookies/query are stripped + POST 403'd at the edge) -- both envs'
        // Sps-Edge stacks carry it before this flips on. Initiators still gate
        // on the live superuser-role LDAP check (R1); enabling the flag does
        // not by itself grant anyone impersonation.
        IMPERSONATION_ENABLED: "true",
        // #671 -- people profile canonical URL. "root" serves /{slug} as the
        // canonical profile URL (and /scholars/{slug} 301s to it); "scholars"
        // (or unset) keeps the legacy /scholars/{slug}. Both envs cut over to
        // "root" (staging flipped first for verification; prod followed). Kept
        // as an explicit flag -- not yet removed -- so it stays the rollback
        // lever during the soak (set back to "scholars" + redeploy to revert).
        // Unlike IMPERSONATION above, this needs NO EdgeStack behavior: a root
        // single-segment profile falls to the cacheable default behavior
        // (force-dynamic, path-cached, no cookie/query dependence) -- the same
        // edge treatment the legacy route got. The app reads PROFILE_CANONICAL
        // in lib/profile-url.ts. Deployed manually (cdk deploy --exclusively
        // Sps-App-<env>); the CD pipeline only re-rolls the image.
        PROFILE_CANONICAL: "root",
        // #443 INTERIM superuser allowlist. The live LDAP superuser check
        // (lib/auth/superuser.ts, R1) cannot succeed in any deployed env: the
        // SPS VPC has no route to the WCM directory (10.63.x) -- TGW attachment
        // + WCM firewall are pending the network team, the same gap that blocks
        // ETL #443. SCHOLARS_SUPERUSER_GROUP_CN is therefore intentionally left
        // UNSET (setting it would make every authenticated user's session probe
        // hang ~10s on the LDAPS connect timeout). This comma-separated CWID
        // allowlist confers the superuser tier WITHOUT LDAP so a tightly-scoped
        // operator set can use the admin features (incl. #637 "View as") now.
        // REMOVE this and set SCHOLARS_SUPERUSER_GROUP_CN once VPC->WCM LDAPS
        // routing lands. CWIDs are directory usernames, not secrets.
        SCHOLARS_SUPERUSER_CWIDS: "paa2013,drw2004,mrj4001,ved4006,mom2021",
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
        // #742 -- Vercel AI Gateway key for the overview-statement generator.
        // Whole-secret string; lib/seo/llm-client.ts reads it as
        // AI_GATEWAY_API_KEY. Required whenever SELF_EDIT_OVERVIEW_GENERATE=on
        // (set above), else "Generate a draft" 500s. ARN is in
        // appConsumerSecretArns so the execution role can pull it at task start.
        AI_GATEWAY_API_KEY: ecs.Secret.fromSecretsManager(aiGatewayApiKeySecret),
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
    // PutTelemetryRecords grant added above. It also exports the same
    // tail-sampled traces to New Relic (otlphttp/newrelic in the config);
    // that path needs no IAM -- it authenticates with the NEW_RELIC_LICENSE_KEY
    // secret injected below, not the task role. Image pinned by digest per
    // ADOT_COLLECTOR_IMAGE.
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
      secrets: {
        // New Relic ingest license key for the otlphttp/newrelic exporter in
        // otel-collector-config.yaml. Injected here (collector container, not
        // the app) and read as ${env:NEW_RELIC_LICENSE_KEY} in that config.
        // Pull from Secrets Manager via the execution role -- the ARN is in
        // consumerSecretArns above.
        NEW_RELIC_LICENSE_KEY: ecs.Secret.fromSecretsManager(
          newRelicLicenseKeySecret,
        ),
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
        executionRole: deployTaskExecutionRole,
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
        // ADR-009 Phase 2 cutover: the migrate task runs as sps_migrate (the
        // DDL-bearing deploy-time role), NOT app_rw. req 1 (asserted): this
        // MUST be the migrate DSN, never app-rw.
        DATABASE_URL: ecs.Secret.fromSecretsManager(migrateSecret),
      },
    });

    // ------------------------------------------------------------------
    // db-bootstrap task definition (#493).
    //
    // Provisions the separate `scholars_audit` database + the append-only
    // INSERT grant for the app role, BEFORE `sps-migrate` in the deploy
    // pipeline. Runs the tsx-based scripts/db-bootstrap.ts on the ETL image
    // (the only image carrying tsx + the source tree + the mariadb client).
    // Idempotent and fails-closed: a non-zero exit halts the deploy, so a
    // mis-provisioned audit grant errors loud-and-early rather than #493's
    // silent-late runtime failure.
    //
    // Logs in as the least-privilege `sps_bootstrap` user (BOOTSTRAP_DSN), never
    // master; APP_RW_DSN is injected read-only so the runner can resolve the
    // live grantee username (it can't drift from the real app identity). The
    // network config (private subnets + the app SG, which already has Aurora
    // 3306 ingress) is supplied at run-task time by the deploy workflow, exactly
    // as for the migrate task -- so no SG/subnet wiring lives on the task def.
    // ------------------------------------------------------------------
    this.dbBootstrapTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "DbBootstrapTaskDefinition",
      {
        family: `sps-db-bootstrap-${env}`,
        cpu: envConfig.migrationTaskCpu,
        memoryLimitMiB: envConfig.migrationTaskMemoryMiB,
        executionRole: deployTaskExecutionRole,
        taskRole,
      },
    );
    this.dbBootstrapTaskDefinition.addContainer("db-bootstrap", {
      image: etlContainerImage,
      containerName: "db-bootstrap",
      essential: true,
      entryPoint: ["npx", "tsx", "scripts/db-bootstrap.ts"],
      environment: {
        // The app-rw account's host pattern (per-env: staging is VPC-scoped
        // `10.20.%`, prod is `%`). db-bootstrap grants the audit INSERT to
        // `'app_rw'@'<this>'`; a wrong value 1410s at the GRANT (#493 staging).
        GRANTEE_HOST: envConfig.appRwGranteeHost,
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: dbBootstrapLogGroup,
        streamPrefix: "db-bootstrap",
      }),
      secrets: {
        BOOTSTRAP_DSN: ecs.Secret.fromSecretsManager(bootstrapDsnSecret),
        APP_RW_DSN: ecs.Secret.fromSecretsManager(appRwSecret),
      },
    });

    // ------------------------------------------------------------------
    // grant-equality verify task definition (ADR-009 Phase 0).
    //
    // Asserts every managed DB role's live grants EXACTLY equal a pinned golden
    // list (a delta in EITHER direction -- excess OR missing -- fails). This is
    // the load-bearing gate that kills the manual-grant drift class behind the
    // 2026-05-30 staging `ALL PRIVILEGES ON scholars.*` incident; a capability
    // probe can't see *retained* excess, only an equality diff can.
    //
    // Runs scripts/verify-db-grants.ts on the ETL image (the only one carrying
    // tsx + the source tree + the mariadb client), AFTER db-bootstrap (so app-rw
    // already holds the audit INSERT its golden list expects) and BEFORE the
    // service rolls. It connects AS each role and reads SHOW GRANTS FOR
    // CURRENT_USER() (the #607 grantee-side technique -- no mysql.user read), so
    // it needs each role's own DSN. Read-only (no GRANT/REVOKE), idempotent, and
    // fails-closed: any delta exits non-zero and halts the deploy.
    //
    // VERIFY_ROLES covers all four managed roles. ADR-009 Phase 2 wires
    // sps_migrate + its MIGRATE_DSN here, now that the migrate task runs as that
    // role -- so the verify enforces sps_migrate's golden list live too. Every
    // named role MUST have its DSN injected or the task fails closed -- never a
    // silent skip. Network config is supplied at run-task time by the deploy
    // workflow, exactly as for the migrate / db-bootstrap tasks.
    // ------------------------------------------------------------------
    this.verifyGrantsTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "VerifyGrantsTaskDefinition",
      {
        family: `sps-verify-grants-${env}`,
        cpu: envConfig.migrationTaskCpu,
        memoryLimitMiB: envConfig.migrationTaskMemoryMiB,
        executionRole: deployTaskExecutionRole,
        taskRole,
      },
    );
    this.verifyGrantsTaskDefinition.addContainer("verify-grants", {
      image: etlContainerImage,
      containerName: "verify-grants",
      essential: true,
      entryPoint: ["npx", "tsx", "scripts/verify-db-grants.ts"],
      environment: {
        VERIFY_ROLES: "app-ro,app-rw,sps_migrate,sps_bootstrap",
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: verifyGrantsLogGroup,
        streamPrefix: "verify-grants",
      }),
      secrets: {
        APP_RO_DSN: ecs.Secret.fromSecretsManager(appRoSecret),
        APP_RW_DSN: ecs.Secret.fromSecretsManager(appRwSecret),
        BOOTSTRAP_DSN: ecs.Secret.fromSecretsManager(bootstrapDsnSecret),
        // ADR-009 Phase 2: verify now also covers sps_migrate, so it connects
        // AS that role (SHOW GRANTS FOR CURRENT_USER()) -- it needs the DSN.
        MIGRATE_DSN: ecs.Secret.fromSecretsManager(migrateSecret),
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
      // A freshly placed task reports 503 on /api/health until its startup
      // warm-up pass completes (lib/warmup.ts flips the lib/warmup-state.ts
      // latch; self-bounded by WARMUP_BUDGET_MS ~15s). Give ECS a grace window
      // comfortably larger than that budget + the 2x30s ALB healthy threshold
      // so it never treats a still-warming task as failed and trips the circuit
      // breaker above into a deploy rollback. Steady-state liveness is
      // unaffected: the latch is one-way, so once warm the check stays 200.
      healthCheckGracePeriod: Duration.seconds(120),
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
    // Application autoscaling (#596).
    //
    // Caching (CloudFront + ISR) sheds the cacheable read traffic that
    // dominates, but the uncacheable paths -- /api/search*, /edit*,
    // /api/auth/* (and /api/auth/session, which fires on every public page
    // per the cookie-strip workaround), exports -- are deliberately routed
    // straight to the origin. A launch-window or outreach-wave spike
    // (Wave 4 = WCM-wide, #506 Gate D5) on those paths can peg the fixed
    // task count, saturate the ALB queue and start 503-ing with no
    // automatic recovery. A target-tracking scaling policy gives that
    // recovery; without it the docs/PRODUCTION.md incident runbook sends
    // the on-call operator chasing a policy that does not exist.
    //
    // Skipped during the bootstrap deploy (desiredCount driven to 0 via
    // `-c appDesiredCount=0`): attaching a scalable target with a non-zero
    // MinCapacity would make App Auto Scaling immediately schedule the
    // floor tasks against an empty ECR, re-introducing the guaranteed-
    // failing-pull wait the bootstrap exists to avoid. The real deploy
    // (desiredCount back to the env default) attaches the policy.
    //
    // MinCapacity == appDesiredCount: the service never scales BELOW the
    // current floor, so the prod minimum (2) stays AZ-spread. MaxCapacity
    // and the target thresholds are conservative placeholders pending the
    // #554 load-test numbers (P0, Gate A) -- see config.ts appMaxCount.
    if (desiredCount > 0) {
      const scalableTaskCount = this.ecsService.autoScaleTaskCount({
        minCapacity: envConfig.appDesiredCount,
        maxCapacity: envConfig.appMaxCount,
      });
      // CPU target-tracking. 60% leaves headroom for the lag between the
      // metric breach and a replacement task passing its ALB health check.
      // scaleOut fast (60s -- matches the runbook's "triggers within 60s"),
      // scaleIn slow (5min) so a brief lull does not flap tasks down into
      // the next request burst.
      scalableTaskCount.scaleOnCpuUtilization("CpuScaling", {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.seconds(300),
        scaleOutCooldown: Duration.seconds(60),
      });
      // ALB request-count target-tracking on the PUBLIC target group -- the
      // origin-forwarded request rate. Only requests carrying the valid
      // X-Origin-Verify header forward to a target (the listener's default
      // action is a fixed-response 403), so blocked/junk traffic never
      // inflates the metric; we scale on real served load. requestsPerTarget
      // is a placeholder until #554 measures sustainable RPS per task.
      scalableTaskCount.scaleOnRequestCount("RequestScaling", {
        requestsPerTarget: 1000,
        targetGroup: publicAppTargetGroup,
        scaleInCooldown: Duration.seconds(300),
        scaleOutCooldown: Duration.seconds(60),
      });
    }

    // ------------------------------------------------------------------
    // GitHub Actions OIDC deploy role.
    //
    // The OIDC provider is account-scoped — only one
    // `token.actions.githubusercontent.com` provider can exist per account,
    // and its ARN is deterministic. The single-account deviation (staging +
    // prod share account 665083158573) means exactly one AppStack may own
    // (create) the provider; every other env must import it. The owner is
    // staging (it deploys first). Non-owner envs import the deterministic ARN
    // by default, so a manual `cdk deploy` no longer has to remember
    // `-c githubOidcProviderArn=...` — omitting it previously fell into the
    // create branch and failed the prod stack with EntityAlreadyExistsException
    // (#491). The context flag still overrides the imported ARN, and
    // `-c createGithubOidcProvider=true` forces creation for a first-ever
    // bootstrap of a brand-new account from a non-staging env.
    //
    // Trust policy: sub claim restricted to the SPS repo. Prod admits the
    // `prod` GitHub Environment subject, NOT a branch ref -- deploy.yml's prod
    // job sets `environment: prod`, so GitHub mints a sub of
    // `repo:<repo>:environment:prod` (a ref-based sub is only issued for a job
    // WITHOUT an environment, which is why the old `ref:refs/heads/master`
    // condition denied every prod deploy with AssumeRoleWithWebIdentity). The
    // master pin is still enforced, twice over: the prod Environment's
    // deployment-branch policy (master only) and deploy.yml's "Refuse prod from
    // non-master ref" guard. Staging admits any ref so feature branches deploy
    // to staging.
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
    const githubOidcIssuerHost = "token.actions.githubusercontent.com";
    const githubOidcProviderArnContext = this.node.tryGetContext(
      "githubOidcProviderArn",
    ) as string | undefined;
    // staging owns/creates the account-scoped provider; every other env imports
    // it. `-c createGithubOidcProvider=true` forces creation for a fresh-account
    // bootstrap from a non-staging env.
    const ownsGithubOidcProvider =
      env === "staging" ||
      `${this.node.tryGetContext("createGithubOidcProvider")}` === "true";
    const githubOidcProvider = ownsGithubOidcProvider
      ? new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
          url: `https://${githubOidcIssuerHost}`,
          clientIds: ["sts.amazonaws.com"],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidcProvider",
          githubOidcProviderArnContext &&
            githubOidcProviderArnContext.length > 0
            ? githubOidcProviderArnContext
            : `arn:aws:iam::${this.account}:oidc-provider/${githubOidcIssuerHost}`,
        );

    const githubSubCondition =
      env === "prod"
        ? "repo:wcmc-its/Scholars-Profile-System:environment:prod"
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
          // The db-bootstrap task the workflow runs before migrate (#493).
          Stack.of(this).formatArn({
            service: "ecs",
            resource: "task-definition",
            resourceName: `${this.dbBootstrapTaskDefinition.family}:*`,
          }),
          // The grant-equality verify task, run after db-bootstrap (ADR-009).
          Stack.of(this).formatArn({
            service: "ecs",
            resource: "task-definition",
            resourceName: `${this.verifyGrantsTaskDefinition.family}:*`,
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
        resources: [
          taskExecutionRole.roleArn,
          // ADR-009: RunTask for migrate / verify-grants / db-bootstrap passes
          // the deploy execution role, so the deploy principal must be able to.
          deployTaskExecutionRole.roleArn,
          taskRole.roleArn,
        ],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ecs-tasks.amazonaws.com",
          },
        },
      }),
    );
    // The deploy workflow's "Discover AppStack outputs" step calls
    // `aws cloudformation describe-stacks --stack-name Sps-App-<env>` to
    // read the ECR URIs, cluster, service, and migration-task family. The
    // "Sync static assets to S3" step (#700) additionally reads
    // `Sps-Edge-<env>` for the StaticAssetsBucketName output. Scope to those
    // two stacks only -- the wildcard tail matches the stack-id suffix
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
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "stack",
            resourceName: `Sps-Edge-${env}/*`,
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
    new CfnOutput(this, "EcsDbBootstrapTaskFamily", {
      value: this.dbBootstrapTaskDefinition.family,
      description:
        "SPS one-shot scholars_audit bootstrap task family — run before migrate (#493)",
    });
    new CfnOutput(this, "EcsVerifyGrantsTaskFamily", {
      value: this.verifyGrantsTaskDefinition.family,
      description:
        "SPS one-shot grant-equality verify task family — run after db-bootstrap, before the service rolls (ADR-009)",
    });
    new CfnOutput(this, "PublicAlbDns", {
      value: this.publicAlb.loadBalancerDnsName,
      description: "SPS public ALB DNS name (consumed by EdgeStack)",
    });
    new CfnOutput(this, "InternalAlbDns", {
      value: this.internalAlb.loadBalancerDnsName,
      // Issue #479 — EtlStack reads this via `Fn::ImportValue` to point the
      // cadence revalidate step's `SCHOLARS_BASE_URL` at the VPC-private ALB.
      // Cross-stack imports require a named export — the auto-generated
      // logical-id name isn't addressable by `importValue`.
      exportName: `Sps-App-${env}-InternalAlbDns`,
      description: "SPS internal ALB DNS name (consumed by EtlStack).",
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
