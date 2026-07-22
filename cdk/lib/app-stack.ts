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
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";
import { resolveSharedSg, resolveTierSubnets } from "./shared-vpc-subnets";

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
const WCM_IDP_SSO_URL = "https://login-proxy.weill.cornell.edu/idp/profile/SAML2/Redirect/SSO";
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
  /** ECS task role (application runtime identity). Exposed so AnalyticsStack can
   *  grant it workgroup-scoped Athena/Glue/S3 for the in-app Usage dashboard —
   *  the grant lives in AnalyticsStack (which owns the bucket + workgroup L2s),
   *  giving an Analytics→App dependency rather than importing the CFN-named
   *  analytics bucket into this stack. */
  public readonly appTaskRole: iam.Role;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { envConfig, vpc } = props;
    const env = envConfig.envName;
    // Item-3 pass 2a: import the app/etl/alb SGs by id from the SSM params
    // NetworkStack publishes (pass 1) instead of the cross-stack handles — severs
    // the SG `Ref` exports that would lock the useSharedVpc flip (the SGs replace
    // onto the imported VPC). All uses below are `.securityGroupId` or a
    // `securityGroup` reference, valid on an imported SG; the L1 id-keyed ingress
    // rules survive the switch (map Q4).
    const appSecurityGroup = resolveSharedSg(this, envConfig, "app", "AppSg");
    const etlSecurityGroup = resolveSharedSg(this, envConfig, "etl", "EtlSg");
    const albSecurityGroup = resolveSharedSg(this, envConfig, "alb", "AlbSg");

    // Estate-consolidation subnet placement (plan §4.4): the app service +
    // internal ALB (compute) land in the app2 tier, the optional public ALB in
    // the dmz tier, when useSharedVpc is on; else the standalone Sps VPC's
    // PRIVATE_WITH_EGRESS / PUBLIC tiers — byte-identical otherwise.
    const appSubnets = resolveTierSubnets(this, envConfig, "app", "AppSubnet");
    const albSubnets = resolveTierSubnets(this, envConfig, "alb", "PublicAlbSubnet");

    // ------------------------------------------------------------------
    // Secrets lookup. SecretsStack defines the full set; AppStack reads the
    // twelve the app + sidecars consume (db read/write, opensearch app,
    // revalidate token, session-cookie secret, SAML SP private key, ReciterDB
    // connection, SAML IdP cert, SAML SP cert, db-bootstrap DSN, the New
    // Relic ingest key consumed by the ADOT collector, and the read-only ED
    // bind #1592). Looked up by name so the two
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
    const facultyReviewTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "FacultyReviewTokenSecret",
      `scholars/${env}/faculty-review-token`,
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
    // Read-only WCM Enterprise Directory (ED) bind (#1592, #1595). The SAME
    // secret + JSON keys the nightly ETL consumes (cdk/lib/etl-stack.ts
    // "EtlSecretEd"): SCHOLARS_LDAP_URL / _BIND_DN / _BIND_PASSWORD. The app
    // injects these so lib/sources/ldap.ts openLdap() can bind for the
    // SSO-gated GET /api/directory/people — both of its modes: `?cwids=`
    // (unit-access-card CWID→name/title hydration) and `?q=` (the Add-admin
    // DirectoryPeopleTypeahead). Without them openLdap() throws
    // "SCHOLARS_LDAP_URL is not set" and BOTH surfaces fail closed.
    // Read-only bind, no DDL. The "/ed" tail (2 chars) is clear of the Secrets
    // Manager 6-char-tail partial-ARN gotcha.
    //
    // Deliberately does NOT activate the other openLdap() consumers: all three
    // role checks (superuser, comms_steward, development) short-circuit on an
    // empty/unset *_GROUP_CN before reaching openLdap(). See the role-flag block
    // below — SCHOLARS_DEVELOPMENT_GROUP_CN is pinned "" for exactly this reason.
    // ponytail: reuses the ETL's ED bind account instead of a distinct app-
    // scoped read-only bind. Ceiling: the 24/7 app's larger RCE window now
    // shares the SOR-critical ETL credential -- prefer a separate ED service
    // account for prod (ADR-009 exposure-window logic) when one is cheap to get.
    const edSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppEtlEdSecret",
      `scholars/${env}/etl/ed`,
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
      // Read-only ED bind (#1592, #1595): the app task-execution role must
      // GetSecretValue on the ED secret to inject SCHOLARS_LDAP_* into the app
      // container (the SSO-gated /api/directory/people directory route).
      // Read-only bind, no DDL -- same class as the other app-consumer secrets
      // (ADR-009: still no migrate, no bootstrap). Lands on the EXECUTION role
      // only; the task role keeps zero secretsmanager:* (asserted in tests).
      edSecret.secretArn,
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
    //   secrets:GetSecretValue on the eleven app consumer ARNs only (ADR-009: no
    //   migrate, no bootstrap) -- the eleventh is the read-only ED bind secret
    //   (#1592) the app injects for the SSO-gated /api/directory/people route;
    //   logs on the app + ADOT-sidecar groups only.
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
    // Secrets -- exactly the eleven app consumer ARNs (ADR-009 split: no migrate,
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
        resources: [this.ecrRepository.repositoryArn, this.etlEcrRepository.repositoryArn],
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
    this.appTaskRole = taskRole;

    // ------------------------------------------------------------------
    // Shared ISR cache bucket (#1503).
    //
    // Backs the S3 `cacheHandler` (lib/cache/s3-cache-handler.js) that lets all
    // 2–6 app tasks share one incremental-cache store, so `revalidatePath` on
    // one task can't be undone by the edge refilling a stale copy from another.
    // Private, SSE-S3, TLS-only; objects self-expire after 7 days (the cache is
    // derived + disposable, so lifecycle is the only cleanup). Provisioned in
    // every env but INERT until NEXT_ISR_CACHE_S3="on" flips the handler on —
    // so enabling the feature is a flag flip, not an infra race. RETAIN matches
    // the house style for every other bucket in this account.
    const isrCacheBucket = new s3.Bucket(this, "IsrCacheBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: "expire-isr-cache", prefix: "next-isr-cache/", expiration: Duration.days(7) },
      ],
    });
    // Scoped to the app's prefix only: object CRUD on next-isr-cache/* plus
    // ListBucket (the handler never touches anything else).
    isrCacheBucket.grantReadWrite(taskRole, "next-isr-cache/*");

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
    // Bedrock InvokeModel grant (#742 -- overview-statement generator).
    //
    // The app container calls Claude on Amazon Bedrock to draft faculty
    // overview statements (lib/edit/overview-generator.ts, via the AI SDK
    // @ai-sdk/amazon-bedrock provider with fromNodeProviderChain()). The
    // provider resolves THIS task role at runtime -- institutional AWS
    // billing, no API key, no secret to seed. A custom *inline* policy with
    // the single action bedrock:InvokeModel (the generator uses generateText,
    // not streaming, so no InvokeModelWithResponseStream).
    //
    // Scoped to the Claude Opus 4.8 and Sonnet 4.x families, NOT a bare `*`:
    //   - the us. cross-region INFERENCE PROFILE the model id resolves to
    //     (account-scoped), and
    //   - the underlying FOUNDATION MODELs (AWS-owned, empty account field)
    //     the profile routes to.
    // Opus 4.8 is now the DEFAULT generate model and is granted here. Sonnet
    // stays granted because the verify/revise critic pass and the
    // OVERVIEW_GENERATE_MODEL rollback lever still run on Sonnet.
    // Region is `*` because a us. inference-profile call fans out across the
    // US regions (us-east-1/-2, us-west-2); the family wildcards let an
    // intra-family bump (e.g. Sonnet 4.5 -> 4.6) via OVERVIEW_GENERATE_MODEL
    // skip an IAM change while still excluding Haiku and every non-Anthropic
    // provider. Contains no secretsmanager reference, so the "zero
    // secretsmanager on the task role" assertion still holds.
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleBedrockPolicy", {
      policyName: `sps-task-${env}-bedrock`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["bedrock:InvokeModel"],
          resources: [
            `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-opus-4-8*`,
            "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-8*",
            `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-*`,
            "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-*",
          ],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // CloudFront CreateInvalidation grant (#353 -- synchronous edge purge).
    //
    // The suppress / rename / revoke write paths call
    // sendCloudFrontInvalidation (lib/edit/revalidation.ts) inline post-commit
    // to purge the edge copy of the affected page (ADR-005 layer 1). That SDK
    // call runs under THIS task role and, once SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID
    // is set, would AccessDenied without an explicit grant. A custom *inline*
    // policy with the single action cloudfront:CreateInvalidation, scoped to a
    // distribution ARN -- never a bare `*` -- the same scope the EtlStack
    // background-reconciler task role (#353 PR-2) carries. CloudFront is global,
    // so the ARN has no region segment.
    //
    // Dormant until SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID is set: the invalidation
    // helper no-ops while it is unset, so the grant sits unused pre-launch.
    // Contains no secretsmanager reference, so the "zero secretsmanager on the
    // task role" assertion still holds; app-stack.test.ts adds the CloudFront-
    // scope assertions (single action, distribution-scoped resource, no `*`).
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleCloudFrontPolicy", {
      policyName: `sps-task-${env}-cloudfront`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cloudfront:CreateInvalidation"],
          resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // ReCiter read grant (#746 -- live "suggested articles" nudge).
    //
    // GET /api/edit/reciter-pending reads the self viewer's live ReCiter
    // candidate publications DIRECTLY from ReCiter's own DynamoDB + S3 (no
    // engine HTTP round-trip, no api-key): the GoldStandard table (the fresh
    // accept/reject sets) + the Analysis table (the scored candidate list),
    // falling back to s3://reciter-dynamodb/AnalysisOutput/<uid> when the
    // analysis is offloaded. lib/reciter/client.ts fetchSuggestedArticles
    // resolves THIS task role via the AWS SDK default chain -- institutional
    // AWS, no secret to seed.
    //
    // A custom *inline* policy, least-privilege:
    //   - dynamodb:GetItem ONLY (a keyed GetItem on uid -- never Scan/Query),
    //     scoped to exactly the Analysis + GoldStandard tables (these are the
    //     account-shared ReCiter stores, NOT region/account-tokenized like the
    //     SPS tables, so the ARNs are pinned to us-east-1 / 665083158573 where
    //     ReCiter runs).
    //   - s3:GetObject ONLY, scoped to the AnalysisOutput/* prefix of the
    //     reciter-dynamodb bucket -- never a bare `*`.
    //   - kms:Decrypt ONLY, scoped to the single CMK that SSE-KMS-encrypts the
    //     reciter-dynamodb bucket. The offloaded AnalysisOutput/<uid> objects
    //     are encrypted with this key, so s3:GetObject ALONE returns
    //     AccessDenied on a prolific scholar (whose analysis is offloaded) --
    //     the read then silently degrades to [] and the nudge shows nothing.
    //     The key policy delegates to the account root (no condition), so this
    //     IAM grant is sufficient; the key's broad `Principal:*` Decrypt is
    //     conditioned to kms:ViaService=rds and does NOT cover S3 reads.
    //
    // Read-only by construction; the #746 reject WRITE path is the engine HTTP
    // call gated separately. Contains no secretsmanager reference, so the "zero
    // secretsmanager on the task role" assertion still holds; app-stack.test.ts
    // adds the matching scope assertions.
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleReciterReadPolicy", {
      policyName: `sps-task-${env}-reciter-read`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:GetItem"],
          resources: [
            "arn:aws:dynamodb:us-east-1:665083158573:table/Analysis",
            "arn:aws:dynamodb:us-east-1:665083158573:table/GoldStandard",
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject"],
          resources: ["arn:aws:s3:::reciter-dynamodb/AnalysisOutput/*"],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["kms:Decrypt"],
          resources: [
            "arn:aws:kms:us-east-1:665083158573:key/6b9d182c-8abc-48a0-ac90-7c47b55c829a",
          ],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // #1163 cores claim writeback -- SPS's FIRST DynamoDB *write*.
    //
    // When a core owner confirms/rejects a publication's core-facility usage in
    // the /edit/core/[coreId] review queue, lib/cores/claim-writeback.ts mirrors
    // that status onto the engine's item in the shared `reciterai` table
    // (PK PUB#{pmid} / SK CORE#{coreId}) so the next pipeline_cores run sees the
    // human decision. SPS `core_claim` stays the authoritative store and the
    // read-merge wins regardless, so a missing/denied grant only no-ops the
    // mirror (best-effort, non-throwing).
    //
    // A custom *inline* policy, least-privilege:
    //   - dynamodb:UpdateItem ONLY (the single UpdateCommand the writeback
    //     issues -- both create-on-first-write and update; never
    //     Put/Delete/BatchWrite/Scan), scoped to exactly table/reciterai. NOT
    //     table.grantWriteData(), which would over-grant Put/Delete/BatchWrite.
    //   - the same `${this.region}/${this.account}` reciterai ARN as the ETL
    //     read grant (EtlTaskRoleReciterAiPolicy, etl-stack.ts) -- the reciterai
    //     store is account-shared in THIS account. OPERATOR: if a future env
    //     hosts reciterai cross-account, this ARN needs a cross-account
    //     assume-role (same caveat as the ETL grant).
    //
    // Gated in code by CORE_CLAIM_WRITEBACK (default off; staging-first in the
    // environment block below), so this grant can land ahead of go-live and a
    // single `cdk deploy` brings grant + flag up together (no flip-before-grant
    // window). Contains no secretsmanager reference, so the "zero secretsmanager
    // on the task role" assertion still holds; app-stack.test.ts adds the
    // matching scope assertion.
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleCoreClaimWritebackPolicy", {
      policyName: `sps-task-${env}-reciterai-writeback`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:UpdateItem"],
          resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/reciterai`],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // Opportunity URL intake -- the SUBMISSION queue write + list
    // (docs/opportunity-url-intake-spec.md §5).
    //
    // /api/edit/opportunity-intake appends `PK=SUBMISSION` items to the shared
    // `reciterai` table (development-role staff queueing funding-opportunity
    // URLs for ReciterAI's ingest_submissions drain) and Queries them back for
    // the status list. DeleteItem/UpdateItem cover the Submissions-tab cleanup
    // verbs (DELETE a pending/rejected item outright; PATCH-suppress a
    // processed one -- status='suppressed', which ReciterAI's drain companion
    // honors by removing the produced GRANT# items). Least-privilege via the
    // partition-key design: every queue item shares the literal partition key
    // `SUBMISSION`, so a `dynamodb:LeadingKeys` condition pins ALL FOUR
    // actions to that single partition -- the app credential cannot read or
    // write `GRANT#` / `PUB#` / any other engine item. (That key shape exists
    // FOR this condition: a Scan can't be LeadingKeys-scoped, so the list is a
    // Query.)
    // Same account-shared table ARN + cross-account caveat as the writeback
    // grant above. Gated in code by OPPORTUNITY_URL_INTAKE (default off;
    // staging-first in the environment block below) -- grant and flag land in
    // one deploy, no flip-before-grant window.
    // ------------------------------------------------------------------
    new iam.Policy(this, "TaskRoleOpportunitySubmissionPolicy", {
      policyName: `sps-task-${env}-opportunity-submission`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:DeleteItem",
            "dynamodb:UpdateItem",
          ],
          resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/reciterai`],
          conditions: {
            "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["SUBMISSION"] },
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
    const internalAlbSecurityGroup = new ec2.SecurityGroup(this, "InternalAlbSecurityGroup", {
      vpc,
      description: `SPS internal ALB (${env}) -- intra-VPC /api/revalidate ingress.`,
      allowAllOutbound: true,
    });

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
    // #1507 -- :443 ingress for the HTTPS origin leg, added only once the ALB
    // cert is seeded (the :443 listener below is gated the same way).
    if (envConfig.edgeOriginCertArn.length > 0) {
      new ec2.CfnSecurityGroupIngress(this, "PublicAlbIngressFromInternetHttps", {
        groupId: albSecurityGroup.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIp: "0.0.0.0/0",
        description: `Internet to SPS public ALB HTTPS (${env}) -- #1507 origin TLS`,
      });
    }
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
    const containerImage = ecs.ContainerImage.fromEcrRepository(this.ecrRepository, "latest");
    // The ETL batch image (#454) — the only image with `tsx` + the source tree +
    // the `mariadb` client, so it is what runs the tsx-based db-bootstrap script
    // (#493). The standalone app image has none of those.
    const etlContainerImage = ecs.ContainerImage.fromEcrRepository(this.etlEcrRepository, "latest");

    // ------------------------------------------------------------------
    // App task definition.
    //
    // Secrets are wired via the task definition's `secrets:` map (which
    // CFN materializes as `Secrets` on the container definition), not
    // env vars — that's the documented pattern that gates value access
    // on the execution role at task-start time, never embedding the
    // value in the synth output.
    // ------------------------------------------------------------------
    const appTaskDefinition = new ecs.FargateTaskDefinition(this, "AppTaskDefinition", {
      family: `sps-app-${env}`,
      cpu: envConfig.appCpu,
      memoryLimitMiB: envConfig.appMemoryMiB,
      executionRole: taskExecutionRole,
      taskRole,
    });
    appTaskDefinition.addContainer("app", {
      image: containerImage,
      containerName: "app",
      logging: ecs.LogDriver.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: "app",
      }),
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
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
        // #1503 — shared S3 ISR cacheHandler. NEXT_ISR_CACHE_BUCKET (the bucket
        // name, a runtime CloudFormation ref) is always wired so the handler can
        // read/write the store; the handler no-ops safely if it is ever absent.
        // The on/off switch is NOT here: whether the handler is compiled in is a
        // BUILD-time decision (next.config bakes it into the standalone image),
        // so it is passed as `--build-arg NEXT_ISR_CACHE_S3` by the Deploy
        // workflow, per env — a runtime task-def env could never flip it. See
        // docs/1503-shared-cachehandler-spec.md §4e.
        NEXT_ISR_CACHE_BUCKET: isrCacheBucket.bucketName,
        // Reverse grant→researcher matcher: subtopic-grain path vs. the proven
        // topic-vector path. Per-env (on in staging, off in prod until the prod
        // corpus carries match_dsl); lib/api/match-researchers.ts also self-gates
        // on the opportunity's compiled match_dsl, so "on" is safe pre-reproject.
        GRANT_MATCHER_SUBTOPIC_GRAIN: envConfig.grantMatcherSubtopicGrain ? "on" : "off",
        // Abstention floor for the reverse matcher (0 = off). Staging-first; must
        // stay 0 wherever subtopic-grain is off. See config.ts grantMatcherAbstainFloor.
        GRANT_MATCHER_ABSTAIN_FLOOR: String(envConfig.grantMatcherAbstainFloor),
        // OpenSearch domain endpoint (https://...). Default: a plaintext env
        // baked from the DataStack cross-stack export. When
        // openSearchNodeFromSecret is on (consolidation cutover de-coupling,
        // §8.4), the export is dropped and OPENSEARCH_NODE is injected from the
        // opensearch secret's `node` key (secrets block below). lib/search.ts
        // reads OPENSEARCH_NODE; OPENSEARCH_USER/PASS come from secrets. #447
        ...(envConfig.openSearchNodeFromSecret
          ? {}
          : {
              OPENSEARCH_NODE: `https://${Fn.importValue(
                `Sps-Data-${env}-OpenSearchDomainEndpoint`,
              )}`,
            }),
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
        // Data Quality dashboard (`/edit/data-quality`, docs/data-quality-dashboard-spec.md):
        // a read-only, prominence-sorted list of scholars + their profile gaps
        // (missing headshot/overview, pending COI suggestions) for stewards
        // (superuser/comms_steward → all scholars) and unit Owners/Curators (→ their
        // units). Read via isDataQualityDashboardEnabled() (=== "on"); when off the
        // route 404s and the sub-nav tab is hidden — ships dark. App-only, no reindex.
        // STAGING-FIRST: on in staging to soak, off in prod until sign-off. The
        // headshot column is populated by the weekly etl:headshot step (EtlStack);
        // until its first run, headshot cells render "— (not checked)".
        EDIT_DATA_QUALITY_DASHBOARD: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #746 — self-edit "Not mine" → ReCiter gold-standard reject.
        // STAGING-FIRST rollout: ON in staging, OFF in prod until the staging
        // soak completes (prod flips in a follow-up). While off, "Not mine?"
        // keeps the Publication-Manager off-ramp. The ReCiter admin key lives
        // ONLY in the ETL task, so the app just records the reject locally and
        // the etl:reciter-refresh scanner propagates it to the gold standard +
        // fires the delayed re-score.
        RECITER_REJECT_SEND: "on", // Prod flipped 2026-07-05 (launch batch 2, #506; side-effect flag, staging-soaked).
        // #836 — SELF_EDIT_MANUAL_HIGHLIGHTS: the self-only opt-in to choose
        // profile Highlights manually (a frozen `field_override(selectedHighlightPmids)`
        // set that overrides the AI ranking at read time). Read via
        // isManualHighlightsEnabled() (=== "on"); when off the route rejects a
        // selectedHighlightPmids write, the read path ignores any stored override,
        // and the /edit Highlights rail item / card are not surfaced — the whole
        // feature ships dark. ON in both envs: live on staging; prod is ARMED but
        // NOT yet live — prod still runs the pre-arm task def and activates only on
        // the next `cdk deploy --exclusively Sps-App-prod` (CD only re-rolls the
        // image, never CDK). No data migration — the JSON value rides the existing
        // field_override Text column.
        SELF_EDIT_MANUAL_HIGHLIGHTS: "on",
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
        // SELF_EDIT_GRANT_RECS (GrantRecs Phase 3) — the owner-facing "Grants for
        // me" rail item + panel on /edit (self) and /edit/scholar/[cwid]
        // (superuser), surfacing the Phase-2 forward matcher
        // (/api/scholars/[cwid]/opportunities). Read via isGrantRecsEnabled()
        // (=== "on"); when off the grant-recs attribute is dropped from the rail
        // and the valid-attr set, so the feature ships fully dark.
        // STAGING-FIRST (#1613): on in staging to soak, off in prod. The matcher
        // only returns data once GRANT# opportunities are ingested + indexed in
        // that env — staging has the corpus; prod stays dark until the prod
        // mirror lands (ReciterAI#269) and #506/#1203 sign off.
        SELF_EDIT_GRANT_RECS: env === "staging" ? "on" : "off",
        // PRESTIGE_AXIS_WEIGHT — funding-opportunity prestige axis weight, read by
        // prestigeAxisWeight() in lib/api/match-opportunities.ts (parsed as a number,
        // default "0"). The prestige badge + "Prestige" sort ship unconditionally;
        // "0" disables the prestige *ranking* term in combineScore so it has no
        // effect on match order until this is raised post Track-A eval. Same "0" in
        // BOTH envs for launch; flip via `cdk deploy --exclusively Sps-App-<env>`
        // (CD re-rolls the image only) — the flag-parity rule.
        PRESTIGE_AXIS_WEIGHT: "0",
        // #1102/#1103/#1104/#1105 — Cancer-Center / org-unit features (merged
        // 2026-06-18, PRs #1108/#1109/#1110/#1111). Staging-on for soak;
        // prod-off/armed (flip on the next approval-gated Sps-App-prod deploy):
        //   EDIT_UNIT_ROSTER_EXPORT    (#1102) center roster CSV on the /edit Members tab
        //   PROFILE_CENTER_AFFILIATION (#1103) "Centers" card on the scholar profile
        //                              (center name renders now; program label/type
        //                              fill in once #906's classification load runs)
        //   UNIT_ADMIN_CENTER_PROXY    (#1104) center owner/curator proxy-edit (Amendment 4, D1)
        //   CENTER_PROGRAM_PAGES       (#1105) per-program pages + leader. The schema
        //                              migration was applied by the CD migrate step on
        //                              the edbb70eb deploy, so the loader's new columns exist.
        EDIT_UNIT_ROSTER_EXPORT: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        PROFILE_CENTER_AFFILIATION: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        UNIT_ADMIN_CENTER_PROXY: "on", // Prod flipped 2026-07-05 (launch batch 2, #506; side-effect flag, staging-soaked).
        CENTER_PROGRAM_PAGES: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // CENTER_COLLABORATION_NETWORK (#1137) — the public "Collaboration" tab
        // on the center page: an interactive, program-colored co-authorship
        // graph + standalone-HTML export. ADDITIONALLY gated data-driven on the
        // center having a CenterProgram taxonomy (today only the Meyer Cancer
        // Center), so "just the Cancer Center for now" needs no hardcoded code.
        // App-only, no reindex, no migration. Staging-on for soak; prod-off.
        CENTER_COLLABORATION_NETWORK: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // CENTER_COLLABORATION_GRANT_AXIS (#1137 Phase 2) — the SECOND
        // relationship axis on the same tab: grant co-investigation (members who
        // share a sponsor awardNumber), with an axis toggle (Publications /
        // Grants / Both). Sub-flag of CENTER_COLLABORATION_NETWORK — no effect
        // unless the parent is also on. Separate so the grant axis can soak
        // independently and ship dark to prod while the pub axis stays live. The
        // #160 grant-suppression gate is applied before edge-building. App-only,
        // no reindex, no migration. Staging-on for soak; prod-off.
        CENTER_COLLABORATION_GRANT_AXIS: env === "staging" ? "on" : "off",
        // CLINICAL_TRIALS_SECTION — the profile "Clinical trials" section
        // (#clinical-trials). Dark on prod; staging-on for soak. The profile
        // payload returns [] when off, so this is safe to leave off even after
        // the etl:clinical-trials backfill lands.
        CLINICAL_TRIALS_SECTION: "on", // Prod flipped 2026-07-07 (presence-gated, hidden when empty).
        // AVAILABLE_TECHNOLOGIES_SECTION — the profile "Available technologies"
        // section, sourced from the CTL portfolio via `npm run etl:technologies`.
        // The profile payload returns [] when off, and the section is
        // presence-gated (hidden when a scholar holds nothing), so a scholar with
        // no technologies is unaffected either way.
        AVAILABLE_TECHNOLOGIES_SECTION: "on", // Prod flipped 2026-07-14 (#1631); takes effect on the next `cdk deploy Sps-App-prod`.
        // NEWS_MENTIONS_SECTION — the profile "News mentions" section + the /edit
        // card, sourced from the WCM Research news feed via `npm run etl:news`. The
        // payload returns [] when off and the section is presence-gated (hidden when
        // a scholar has no mentions), so a scholar with none is unaffected either
        // way. Dark-launched staging-first; flip prod once the seed lands.
        NEWS_MENTIONS_SECTION: env === "staging" ? "on" : "off",
        // NEWS_APPROVAL_QUEUE — the /edit/news-queue comms surface + its decision
        // endpoint; off ⇒ both 404 and the subnav tab is hidden. Reviewer audience
        // is superusers + external comms (the comms_steward role). Takes effect ONLY
        // on a manual `cdk deploy --exclusively Sps-App-<env>` — the CD pipeline
        // re-rolls the image and never deploys CDK.
        NEWS_APPROVAL_QUEUE: env === "staging" ? "on" : "off",
        // CONSOLE_SUBNAV_GROUPED — collapses the /edit console sub-nav's 14
        // role-gated tabs into two tiers: Profiles · Org units · Queues ·
        // Registries · Insights · Tools, with the active group's members on a
        // second row (`docs/2026-07-20-console-subnav-two-tier-spec.md`).
        // Presentation only — no route, caller or prop changes, and off ⇒ the
        // previous flat strip renders byte-identically.
        //
        // On in both envs. Staging soaked first (deployed 07-21, taskdef :130)
        // and was eyeballed at a narrow window — the tier-2 row scrolls, the six
        // tier-1 items plus the account chip fit. jsdom cannot verify layout
        // (exactly how #1803 shipped broken with green CI), so that eyeball was
        // the gate, not CI. Prod stays dark until `cdk deploy --exclusively
        // Sps-App-prod -c env=prod` — env vars live in the task def.
        CONSOLE_SUBNAV_GROUPED: "on",
        // MATCHA* — the /edit/matcha surface (paste a description of an interest → WCM researchers
        // ranked on topical fit alone). Renamed from SPONSOR_MATCH* 2026-07-17 (#1770 deployed the
        // names, #1773 moved the code, this drops the old set). The old names are GONE from the
        // code as of this change — nothing reads them, so nothing wires them.
        //
        // ⚠ THIS REMOVAL COSTS AN IMAGE ROLLBACK. Pre-#1773 images read `SPONSOR_MATCH`, which
        // this deploy deletes from the task def — so rolling the image back PAST the rename now
        // 404s the feature (`route.ts`: `if (!isMatchaEnabled()) return 404`, and MATCHA is
        // prod-ON). To roll back that far, re-add these four names first. Forward is unaffected.
        //
        // ⚠ THESE TWO MOVE TOGETHER. `MATCHA=on` + `MATCHA_SPINE=off` is a SUPPORTED config, not
        // an error: it serves the surface off the BESPOKE engine, which lost the bake-off
        // decisively (nDCG@20 0.367 vs the spine's 0.594) and returned ZERO real scleroderma
        // experts on the rare-disease fixture. The console would look perfectly healthy and hand
        // out the wrong researchers. Never flip one without the other.
        MATCHA: "on", // Prod-ON since 2026-07-13 (as SPONSOR_MATCH; the eval picked the spine).
        MATCHA_SPINE: "on", // Prod-ON since 2026-07-13, TOGETHER with MATCHA above.
        // A RANKING change ⇒ eval-gated: staging-on to A/B, prod-off until a clean off-vs-on run
        // clears the sponsor eval's ~0.0074 nDCG noise floor. A one-sided staging run (no off arm)
        // cannot prove it. The rename did not reset that debt.
        //
        // MATCHA_GLOSS_QUERY was the other one and is GONE — its A/B ran on 2026-07-19 and it lost
        // on every metric (nDCG 0.613 off vs 0.535 best gloss variant; 15 judged-relevant scholars
        // lost to gain 1). Retrieval now always uses the bare member tokens, so there is no flag
        // left to set. See docs/2026-07-19-matcha-gloss-query-concept-vs-keyword-handoff.md.
        MATCHA_RECENCY: env === "staging" ? "on" : "off",
        // MATCHA_GLOSS_RERANK — gloss as an OpenSearch rescore (recall-safe re-order of the
        // per-cluster pool). A RANKING change ⇒ eval-gated: OFF in BOTH envs until an offline
        // in-VPC λ-sweep A/B (base vs gloss-rerank) picks a λ on the graded-only nDCG, THEN
        // staging-on. STATIC literal for flag parity. λ is read from MATCHA_GLOSS_RERANK_LAMBDA
        // (default 0.5); wire it here too when this goes staging-on. See
        // docs/2026-07-21-matcha-gloss-reranker-handoff.md.
        MATCHA_GLOSS_RERANK: "off",
        // SELF_EDIT_RECITER_PENDING_HINT — the self-only ReCiter "pending /
        // suggested" candidate-publications nudge on the publications + home
        // self-edit surfaces (so the scholar logs into Publication Manager to claim
        // them). The read is a LIVE, on-the-fly DynamoDB GetItem of ReCiter's
        // GoldStandard + Analysis tables (read-only via the task role's
        // TaskRoleReciterReadPolicy — no api-key), filtered against the live gold
        // standard, so it shows nothing when a scholar has no pending suggestions.
        // ON in staging (live rollout); OFF in prod (armed — flips on the next
        // approval-gated Sps-App-prod deploy after the staging soak). The nudge only
        // renders for a genuine (non-impersonating) self viewer with this flag on.
        SELF_EDIT_RECITER_PENDING_HINT: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #443 -- mentee co-publication BRIDGE. getMenteesForMentor's per-mentee
        // co-pub count + 3-pub preview is a LIVE WCM ReciterDB query the in-VPC
        // app can't reach, so it degrades to "temporarily unavailable" in
        // staging/prod. When "on" the read layer serves the pre-computed
        // `mentee_copublication` table instead (lib/api/mentoring.ts). DATA
        // PREREQ (import-then-flip): populate that table FIRST -- run
        // `etl:mentoring:export-copubs` WCM-side (writes S3) then
        // `etl:mentoring:import-copubs` in-VPC -- BEFORE the activating `cdk
        // deploy --exclusively Sps-App-<env>` (CD only re-rolls the image, never
        // CDK). An empty / not-yet-imported table degrades honestly back to
        // "temporarily unavailable" (the read does one cheap global existence
        // probe), so a flag that goes live before the import never shows fake
        // zeros. ON in both envs; prod activates only on the approval-gated prod
        // cdk deploy.
        MENTORING_COPUB_BRIDGE: "on",
        // #928 -- publication-modal cited-by BRIDGE. The modal's "Cited by" list
        // + total are a LIVE WCM ReciterDB query (analysis_nih_cites, in
        // lib/api/publication-detail.ts) the in-VPC app can't reach, so they
        // degrade to "Citation list temporarily unavailable" in staging/prod.
        // When "on" the read layer serves the pre-computed `publication_citing`
        // table instead. DATA PREREQ (import-then-flip): populate that table
        // FIRST -- run `etl:mentoring:export-citing` WCM-side (writes S3) then
        // `etl:mentoring:import-citing` in-VPC -- BEFORE the activating `cdk
        // deploy --exclusively Sps-App-<env>` (CD only re-rolls the image, never
        // CDK; the new etl `citations/*` GetObject grant also needs `cdk deploy
        // Sps-Etl-<env>`). An empty / not-yet-imported table degrades honestly
        // back to "temporarily unavailable" (the read does one cheap global
        // existence probe), so a flag live before the import never shows fake
        // zeros -- the in-VPC outcome is byte-identical to today's live-path
        // failure. ON in both envs; prod activates only on the approval-gated
        // prod cdk deploy.
        PUBLICATION_CITING_BRIDGE: "on",
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
        // #1762 -- the /edit honors approval queue. STAGING ONLY for now: it is
        // superuser-gated and nothing it approves can render until a human
        // approves it, but prod has no honor rows to work yet (the Phase 2 seed
        // hasn't run), so the tab would be an empty surface promising a workflow
        // that doesn't exist there. Flip prod WITH the seed, not before.
        // isHonorQueueEnabled() reads === "on" (lib/edit/honor-queue.ts); off ⇒
        // the page AND the decision endpoint 404, and the subnav tab is hidden.
        // Takes effect ONLY on a manual `cdk deploy --exclusively Sps-App-<env>`
        // -- the CD pipeline re-rolls the image and never deploys CDK.
        HONORS_APPROVAL_QUEUE: env === "staging" ? "on" : "off",
        // #1762 — the `honors_curator` role. The approver is the RESEARCH DEAN's
        // office (a different org unit from the Dean's office), which self-serves
        // from day one, so this is not a fast-follow: without it the queue is
        // superuser-only and the people it exists for cannot reach it.
        //   HONORS_CURATOR_ENABLED -- master kill switch. While not "on",
        //     isHonorsCurator() short-circuits to false BEFORE any directory work,
        //     so the role is dormant and the queue stays superuser-only. Tracks
        //     HONORS_APPROVAL_QUEUE: enabling a role for a surface that 404s buys
        //     nothing. Flip prod WITH the seed and the queue, not before.
        //   SCHOLARS_HONORS_CURATOR_GROUP_CN -- the ED group whose membership
        //     confers the role. Created 2026-07-17 and probe-verified in-VPC:
        //     objectClass groupOfURLs (dynamic) under `ou=application security`,
        //     structurally identical to the superuser / comms-steward /
        //     development groups. Resolved via isGroupMember() (resolve+compare,
        //     ~230ms, #1626).
        //     ⚠ Its memberURL filters `weillCornellEduPersonTypeCode=employee`.
        //     That matches the development-role pattern, NOT the superuser /
        //     comms-steward one (`employee-exempt` / `academic-faculty` /
        //     `affiliate-contractor`). The filter is base-scoped and equality is
        //     exact, so a curator whose type code differs silently matches nothing
        //     and FAILS CLOSED — which presents as "the role is broken", not "the
        //     group is wrong". Verify on staging with a real curator before prod.
        //   No allowlist var: the three older roles carry one only because the VPC
        //     once had no route to the directory; that landed (#1592) and all
        //     three are now pinned "". A superuser is already the fallback tier.
        // Both take effect ONLY on a manual `cdk deploy --exclusively Sps-App-<env>`.
        HONORS_CURATOR_ENABLED: env === "staging" ? "on" : "off",
        SCHOLARS_HONORS_CURATOR_GROUP_CN: "ITS:Library:Scholars/honors-curator-role",
        // #742 -- the /edit Overview "Generate a draft" surface: the Existing /
        // Generator tabs, the Sources drawer, and the AI overview-statement
        // generator. overviewGenerateEnabled() reads === "on"
        // (lib/edit/overview-generator.ts); when off there are NO tabs and the
        // Overview surface is byte-identical to the manual editor. Enabled in
        // BOTH envs per operator decision 2026-06-05. The generator calls
        // Claude on Amazon Bedrock (institutional AWS billing, no API key) and
        // authenticates with THIS task role via the AWS SDK credential chain --
        // the TaskRoleBedrockPolicy below grants bedrock:InvokeModel. No secret
        // to seed. Methods/metrics grounding additionally needs the scholar_tool
        // migration applied + etl:dynamodb run in that env. The spec's
        // validation-run gate (>=4/5 publishable, 0 faithfulness violations;
        // scripts/edit/overview-validation.ts) is tracked separately in #742.
        // Takes effect ONLY on a manual `cdk deploy --exclusively Sps-App-<env>`
        // (the CD pipeline re-rolls the image, never CDK).
        SELF_EDIT_OVERVIEW_GENERATE: "on",
        // SELF_EDIT_OVERVIEW_GENERATE_STREAM -- stream the generate response as NDJSON
        // (the determinate progress bar + CDN idle-timeout protection on a slow Opus-4.8
        // draft) instead of the legacy buffered JSON. A SEPARATE sub-flag because the base
        // generator is already live in prod: flipping the response SHAPE there needs its
        // own staging-first lever. "on" in staging while it bakes, "off" in prod until an
        // approval-gated Sps-App-prod deploy flips it; off ⇒ the buffered path, unchanged
        // (isOverviewGenerateStreamEnabled, lib/edit/overview-generator.ts). Takes effect
        // on a manual `cdk deploy --exclusively Sps-App-<env>`.
        SELF_EDIT_OVERVIEW_GENERATE_STREAM: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #917 v5 -- the NIH-biosketch generator on the /edit surface. Default-off
        // and staging-first: this is a NEW surface, so it stays "on" only in
        // staging while it bakes, and "off" in prod until an approval-gated
        // Sps-App-prod deploy flips it. Same Bedrock task role as the overview
        // generator (no new IAM). Takes effect on a manual
        // `cdk deploy --exclusively Sps-App-<env>`.
        EDIT_BIOSKETCH_GENERATE: "on", // Prod flipped 2026-07-05 (launch batch 2, #506; side-effect flag, staging-soaked).
        // EDIT_CV_EXPORT -- the "CV (WCM format)" generator on the /edit Tools
        // section. NEW surface: staging-first, prod-dark until an approval-gated
        // `cdk deploy --exclusively Sps-App-<env>`. Same Bedrock task role (M1
        // reuses the overview generator) -- no new IAM.
        EDIT_CV_EXPORT: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // REPORTER_MATCH_V2 -- the RePORTER PMID-overlap "Is this you?" card on the
        // /edit surface (the app side of the flag; the ETL side is set in
        // etl-stack.ts). Gates the EditContext load, the rail item, and the
        // confirm/reject/revoke routes. NEW surface: staging-first, prod-dark until
        // an approval-gated `cdk deploy --exclusively Sps-App-<env>`. No new IAM.
        REPORTER_MATCH_V2: env === "staging" ? "on" : "off",
        // POPS physician-directory base (clinical CV enrichment, zero-persist, over
        // NAT egress -- the public WCM physician-directory host, reachable from the
        // Sps VPC unlike the 10.x internal sources).
        POPS_BASE_URL: "http://pops.weillcornell.org",
        // SELF_EDIT_RAIL_RESTRUCTURE -- the restructured self-edit attribute rail
        // (floating Home, content-only "Yours to edit", "From WCM records" with
        // Identity/Records sub-headers, "Tools", and a "Settings" group for the
        // admin controls). Presentational only -- same attributes, regrouped.
        // Default-off and staging-first: "on" in staging while it bakes, "off" in
        // prod until an approval-gated Sps-App-prod deploy flips it. Takes effect
        // on a manual `cdk deploy --exclusively Sps-App-<env>`.
        SELF_EDIT_RAIL_RESTRUCTURE: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #917 v6 -- post-generation faithfulness pass for the biosketch generator.
        // ON in BOTH envs: the biosketch is a grant document, and one fabricated
        // metric there dwarfs the ~3x cost (handoff §5). The route forces it on
        // unless this is "off" (the debugging opt-out). Flip per-env here + a manual
        // `cdk deploy --exclusively Sps-App-<env>`.
        BIOSKETCH_FAITHFULNESS_PASS: "on",
        // #917 v7 -- the LIVE default biosketch prompt VERSION (its own namespace,
        // NOT the overview v2/v3/v4). "v7" is v6 + a short subject heading on each
        // contribution (the NIH "Contributions to Science" heading format) and the new
        // default in both envs. No-image-roll ROLLBACK lever: set "v6" + a manual
        // `cdk deploy --exclusively Sps-App-<env>` to revert to the (byte-pinned)
        // title-less prompt. An invalid / unset value falls back to the registry default
        // (v7), so a typo never breaks the generator (defaultBiosketchPromptVersionId,
        // lib/edit/biosketch-prompt-versions.ts). Superuser / curator can still pick any
        // version per-generate regardless of this default.
        BIOSKETCH_PROMPT_VERSION_DEFAULT: "v7",
        // #742 -- the LIVE default prompt VERSION (overview-prompt-versioning-spec.md).
        // "v3" is the keyword-rich narrative prompt and the new default for all
        // generations in both envs. This env is the no-image-roll ROLLBACK lever:
        // set it to "v2" + a manual `cdk deploy --exclusively Sps-App-<env>` to
        // revert the default to the legacy concise prompt without touching code.
        // An invalid / unset value falls back to the registry default (v3), so the
        // generator is never broken by a typo (defaultPromptVersionId,
        // lib/edit/overview-prompt-versions.ts). Superuser / curator can still pick
        // either version per-generate regardless of this default.
        OVERVIEW_PROMPT_VERSION_DEFAULT: "v4",
        // OVERVIEW_AUDIENCE_DEFAULT -- the LIVE default AUDIENCE tier for the overview
        // generator (overview-params.ts): "accessible" | "informed" | "technical". The
        // default is "informed" (prospective trainees / scientifically-literate
        // non-specialists), a deliberate step down from the keyword-rich prompt's
        // technical drift (the corrective to the "overly technical" reports) without going
        // all the way to layperson. This env is the no-image-roll lever to shift the
        // baseline: set "accessible" or "technical" + a manual `cdk deploy --exclusively
        // Sps-App-<env>`. An invalid / unset value falls back to the registry default
        // (informed) (defaultAudience, lib/edit/overview-params.ts). The editor can still
        // pick any tier per-generate regardless of this default.
        OVERVIEW_AUDIENCE_DEFAULT: "informed",
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
        // Public site origin for absolute-URL metadata (canonical/OG via the
        // root layout's `metadataBase`). RUNTIME var (read at server startup),
        // NOT `NEXT_PUBLIC_SITE_URL` -- that one is inlined at build time, so an
        // unset build baked the localhost fallback into every canonical. Derived
        // from the SAML ACS URL (same per-env `https://<public-host>`).
        SITE_URL: new URL(envConfig.samlSpAcsUrl).origin,
        // In-app Usage dashboard (/edit/usage) — the workgroup + Glue database the
        // app queries for the daily_usage rollup. Stable, config-derived names
        // (AnalyticsStack creates `sps-usage-app-${env}` / `sps_usage_${env}`); the
        // matching Athena/Glue/S3 grant on THIS task role is attached in
        // AnalyticsStack. Region is pinned so the Athena client targets the same
        // region the workgroup lives in regardless of the task's default chain.
        // Uses the app-only workgroup (results isolated under athena-results/app/)
        // so this role can never read an operator's PII-bearing ad-hoc results.
        SPS_USAGE_WORKGROUP: `sps-usage-app-${env}`,
        SPS_USAGE_DATABASE: `sps_usage_${env}`,
        SPS_USAGE_REGION: this.region,
        // #760 -- launch-period "Beta" pill beside the Scholars wordmark.
        // DEFAULT ON: the header reads `=== "off"` (isBetaBadgeEnabled), so the
        // badge shows in both envs while we're in beta. Wired here explicitly so
        // the off-switch is discoverable and flag parity holds (local == deployed).
        // Retire at full launch by setting this to "off" and `cdk deploy
        // Sps-App-<env>` -- no code revert (CD re-rolls the image only, so an
        // env-flag change requires an explicit cdk deploy).
        SHOW_BETA_BADGE: "on",
        // #692 -- generic-term de-highlight, graduated to prod parity after the
        // staging UAT + SPEC §8 eval; runs in BOTH envs. resolveGenericTermMode
        // reads off|resolve|on (lib/api/search-flags.ts). Its #688 sibling
        // SEARCH_PEOPLE_MATCH_PROVENANCE (the "Why this match" MeSH-provenance
        // note) was retired in #1440 -- the note is now always on in code.
        SEARCH_GENERIC_TERM_DEMOTE: "on",
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
        // #967 -- surface a representative matching publication inside the
        // People reason line (`... tagged HIV -- incl. "<title>" (2024)`). Adds a
        // `top_hits` sub-agg to the SAME bounded reason-count publications agg
        // (no people-index field, no reindex); inert unless MATCH_EXPLAIN is on.
        // resolvePeopleSnippetRepresentativePub reads === "on". Turned OFF on
        // staging too (was staging-on): the `top_hits` sub-agg is the most
        // expensive part of the reason-count agg and drove the broad-concept
        // /search ~10s hang -- the streamed People render tails past the 7s
        // #1017 nav watchdog. PR #1278 caps the agg wall-time app-side; this
        // drops the sub-agg and brings staging to prod parity. Flip back to a
        // staging soak once #1278 has landed and been measured.
        SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB: "off",
        // search reason-from-doc -- serve the People "N of M publications tagged
        // {concept}" reason count from the precomputed people-doc field
        // `meshSubtreeCounts` (O(1) `_source` lookup) instead of a per-request
        // publications-index aggregation, taking that agg off the search path so
        // broad-concept searches stop saturating the OpenSearch thread pool under
        // concurrency. resolvePeopleReasonFromDoc reads === "on". REINDEX PREREQ:
        // the people index must be rebuilt with `meshSubtreeCounts` before this
        // serves non-zero counts (a stale index degrades to the concept fallback,
        // never a 500). Inert unless MATCH_EXPLAIN is on. DEFAULT OFF BOTH ENVS --
        // staging-first parity A/B + instant rollback; flip on staging after the
        // people reindex, then prod after its own reindex.
        // Staging reindex done 2026-06-25 (people v11 carries meshSubtreeCounts) → ON staging.
        // Prod ON 2026-07-02 (prod search:index ran 2026-07-01; verify a prod
        // people doc carries non-null meshSubtreeCounts before deploying).
        SEARCH_PEOPLE_REASON_FROM_DOC: "on",
        SEARCH_PUB_HIGHLIGHT: "on",
        SEARCH_PUB_MATCH_PROVENANCE: "on",
        // #837 -- Publications-tab Department facet. Unlike the three above this
        // has a REINDEX prereq: the publications index must be rebuilt so docs
        // carry `wcmAuthorDepartments` before the flag serves (resolvePublication-
        // DepartmentFilter reads === "on"; a not-yet-reindexed cluster degrades to
        // no Department facet, never a 500). ON in both envs: live on staging
        // (reindexed). Prod is ARMED but NOT yet live (still on the pre-arm task
        // def) AND not yet reindexed — so even once the next `cdk deploy
        // --exclusively Sps-App-prod` activates it, the facet stays invisible until
        // the prod publications index is reindexed (search:index:publications).
        SEARCH_PUB_DEPARTMENT_FILTER: "on",
        // #396 -- Publications-tab "Show only MeSH-tagged matches" filter.
        // NO reindex prereq (unlike SEARCH_PUB_DEPARTMENT_FILTER above):
        // `meshDescriptorUi` is already indexed, so the `exists` predicate is
        // exact the moment the flag flips. App-only; gated additionally on
        // `?searchMode=mesh-only` so a stale URL is inert when off.
        // STAGING-FIRST: on for staging, off for prod (separate gated flip).
        SEARCH_PUB_MESH_ONLY_FILTER: "on", // Prod flipped 2026-07-07 (no reindex; opt-in ?searchMode=mesh-only).
        // Pub-tab perf -- split the facet aggregation off the hit-list request
        // (resolvePubFacetSplit): hits (Request A) + cached/time-capped facets
        // (Request B) in parallel, so paginating/re-sorting a query reuses the
        // page- and sort-invariant facet counts and pays only the cheap hit
        // query. NO reindex prereq -- request-shape change only; flag-off is
        // byte-identical. STAGING-FIRST: soak on staging before prod.
        SEARCH_PUB_FACET_SPLIT: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #824 sec4c -- People-tab method-family ranking boost. Same
        // reindex-then-flip shape as SEARCH_PUB_DEPARTMENT_FILTER above: the
        // people index must be rebuilt so docs carry the `methodFamily` rollup
        // before the boost serves (resolvePeopleMethodFamilyBoost reads
        // === "on"; a not-yet-reindexed cluster simply matches an absent field,
        // never a 500). STAGING-FIRST: on for staging (people index reindexed
        // 2026-06-16), off for prod (prod go-live is a separate reindex + flip).
        SEARCH_PEOPLE_METHOD_FAMILY: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        // #1269 -- People-tab method-family TIER boost. A MULTIPLICATIVE
        // function_score factor for scholars tagged with the SEARCHED family, so
        // an explicitly method-tagged scholar outranks a keyword/MeSH-only match
        // (the sibling SEARCH_PEOPLE_METHOD_FAMILY above is only an additive
        // cross_fields nudge -- too weak to form a tier). READS the same
        // `methodFamily` index field, so NO new reindex: staging is already
        // ready (reindexed 2026-06-16, per above). resolvePeopleMethodFamilyTier
        // reads === "on"; off => no factor pushed (body unchanged). STAGING-FIRST:
        // on for staging (validate the #1269 spatial-transcriptomics repro), off
        // for prod -- prod go-live pairs with SEARCH_PEOPLE_METHOD_FAMILY's own
        // prod flip + reindex.
        SEARCH_PEOPLE_METHOD_FAMILY_TIER: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        // #1119 -- People-tab method-CONTEXT ranking boost (tool-usage snippet text
        // from ReciterAI tool_context). Same reindex-then-flip shape as
        // SEARCH_PEOPLE_METHOD_FAMILY. It is PROSE, so it must SOAK on staging
        // before any prod flip. STAGING-FIRST: on for staging -- the tools ETL
        // backfilled scholar_family.exemplar_contexts (artifact v2026-06-13) and the
        // people index was reindexed on this code 2026-06-18, so docs carry the
        // `methodContext` field. Off for prod (prod go-live is a separate backfill +
        // reindex + flip). resolvePeopleMethodContextBoost reads === "on"; a
        // not-yet-reindexed cluster matches an absent field (never a 500).
        SEARCH_PEOPLE_METHOD_CONTEXT: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        // #1333 clinical-reason precedence — the tagged-pub COUNT below which a
        // clinical:exact reason outranks a tagged-pub reason (a board cert beats more
        // pubs than a bare specialty: "5 pubs > 1 specialty"). Read whenever
        // SEARCH_PEOPLE_CLINICAL_FN is on, so these are live wherever that flag is.
        // The flag-parity CI gate requires every env key a code path consumes.
        SEARCH_PEOPLE_CLINICAL_BOARD_OVER_TAGGED: "6",
        SEARCH_PEOPLE_CLINICAL_SPECIALTY_OVER_TAGGED: "4",
        // Track B / B2 — clinical-specialty function_score boost. (The cross_fields
        // text-field variant SEARCH_PEOPLE_CLINICAL was measured inert in-VPC and has
        // been removed.) Additive boost on docs whose board-derived
        // clinicalSpecialties match the query; lifts thin-publication clinician-experts
        // (measured: obesity Igel #183->#12). No reindex (query-time boost). Query-tunable
        // weight via SEARCH_PEOPLE_CLINICAL_FN_WEIGHT (code default 3). Staging-on after the
        // 2026-07-02 A/B (docs/search-area-boost-ab-2026-07-02.md): strict win over the
        // staging default — clinician-expert medRank 14->9, zero per-query regressions.
        // Prod flipped on 2026-07-04 (#1466); clinicalSpecialties backfilled on prod (#1481).
        SEARCH_PEOPLE_CLINICAL_FN: "on",
        // #1836 — extend the clinical signal to the whole MeSH disease subtree a
        // board specialty covers (a "heart failure" query lights up a board-certified
        // cardiologist), via cap-free tree-number subsumption. Sub-toggle of
        // SEARCH_PEOPLE_CLINICAL_FN. NEEDS a people reindex to populate the anchor
        // fields (inert + safe until then — the boost/evidence read absent fields).
        // Staging-on for the #1836 rollout eval; prod still off pending sign-off.
        SEARCH_PEOPLE_CLINICAL_MESH_ANCHOR: env === "staging" ? "on" : "off",
        // #824 follow-up -- match-aware People-results "why" line (method/topic/
        // humanized-areas snippet). APP-ONLY, no reindex: derives from
        // scholar_family + the topic taxonomy at query time. resolvePeopleMatch-
        // AwareSnippet reads === "on"; off => today's snippet. STAGING-FIRST: on
        // for staging (pairs with SEARCH_PEOPLE_METHOD_FAMILY above so the method
        // badge has families to surface), off for prod.
        SEARCH_PEOPLE_MATCH_AWARE_SNIPPET: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #824 follow-up Phase 1 -- the coherent ResultEvidence snippet model
        // (#1056). When on, supersedes the match-aware chain above with one typed
        // evidence object per hit selected by one precedence function and rendered
        // by one <ResultEvidence> component. APP-ONLY, no reindex (same query-time
        // derive). resolveSearchResultEvidence reads === "on". STAGING-FIRST soak:
        // Prod flipped on 2026-07-04 (#1464 evidence bundle: this + rows + reason-counts flip together).
        SEARCH_RESULT_EVIDENCE: "on",
        // Generalized evidence rows -- surfaces a scholar's topic-matching grants
        // as a lazy "Funding" disclosure row (Key funding) on the Scholars card and
        // badges the publications flavor (Research area / Concept / Keyword). The
        // row is presence-gated (hide-when-empty) via a per-card /grants fetch.
        // APP-ONLY, no reindex. resolveSearchEvidenceRows reads === "on".
        // Prod flipped on 2026-07-04 (#1464 evidence bundle).
        SEARCH_EVIDENCE_ROWS: "on",
        // #1366 -- counted, STACKED evidence reason lines on the People card:
        // method / tagged-concept / research-area each become a first-class line
        // prefixed "N of M publications" (keyword fallback; clinical label-only).
        // Method + area counts read precomputed people-doc maps (methodFamilyCounts
        // / areaCounts), populated by a reindex. resolveSearchEvidenceReasonCounts
        // reads === "on". Prod flipped on 2026-07-04 (#1464 evidence bundle); methodFamilyCounts/areaCounts backfilled (#1481).
        SEARCH_EVIDENCE_REASON_COUNTS: "on",
        // Research-Area concentration boost (docs/search-research-area-relevance-spec.md).
        // When on, a topic query that resolves to a Research Area lifts scholars by their
        // relevance×coverage ranking in that area (reorder-only, no reindex).
        // resolveSearchPeopleAreaBoost reads === "on". Staging-first.
        SEARCH_PEOPLE_AREA_BOOST: "on", // Prod flipped 2026-07-07 (reorder-only, no reindex).
        // #1344 -- multi-word topic phrase boost. When on, a topic People query adds
        //   match_phrase should-clauses over publicationTitles (slop 8) + areasOfInterest
        //   (slop 4) so a multi-word specialty ("pediatric congenital heart surgery") is
        //   not diluted by the min_should_match over-broadening. resolvePeopleTopicPhraseBoost
        //   reads === "on"; flag-OFF => empty spread => body byte-identical (never admits,
        //   no msm on the bool). Query-time, no reindex. Staging-first for the #1344 A/B.
        SEARCH_PEOPLE_PHRASE_BOOST: "on", // Prod flipped 2026-07-07 (#1344; query-time; +0.022 validated).
        // #1347 -- division-shape routing. When on, a bare clinical-division-name People
        //   query (Cardiology) routes to the department template AND is scoped to that
        //   division's roster (deptDivKey filter), instead of falling to topic_template.
        //   resolveSearchPeopleDivisionShape reads === "on". Query-time, no reindex. DARK
        //   everywhere -- several division names are also topical terms, so this needs a
        //   staging A/B before any flip (then set staging -> "on"); the chief-of ranking
        //   WITHIN the roster additionally needs the #1347 chiefCwid reindex.
        SEARCH_PEOPLE_DIVISION_SHAPE: "off",
        // #1345 -- full-time-faculty prominence lever. Default ON keeps the #513 flat
        //   +1.0 full_time_faculty prominence term (prod ranking byte-identical until a
        //   deliberate flip). Set to "off" to drop the expertise-independent employment
        //   prior so genuine affiliated/clinical subspecialty experts aren't buried.
        //   resolveSearchPeopleFacultyProminence reads !== "off". Query-time, no reindex.
        //   STAGING-FIRST: neutralized on staging for the A/B soak, prod keeps +1.0.
        SEARCH_PEOPLE_FACULTY_PROMINENCE: env === "staging" ? "off" : "on",
        // People-tab "concepts" hint -- replace the sparse self-reported
        // research-areas hint on the scholar row's identity line with the
        // scholar's top MeSH descriptor labels (topMeshTerms). Only the no-match
        // TAIL of the evidence model changes (areas slot -> concepts slot); the
        // query-match kinds are untouched. resolveSearchPeopleConceptHint reads
        // === "on". APP-ONLY query derive, but the topMeshTerms index field needs
        // a reindex to populate. Prod flipped on 2026-07-04 (#1465); topMeshTerms present on prod.
        SEARCH_PEOPLE_CONCEPT_HINT: "on",
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
        // #1359 Tier 2 -- concept-match the People-card KEY FUNDING evidence row
        // (threads the resolved concept into /api/scholar/[cwid]/grants). Recall-
        // affecting: a grant TAGGED with the resolved concept's MeSH descriptor now
        // surfaces even when it never names the term in prose, and the row's reason
        // label moves from "mention '<query>'" to "N of M grants tagged <Concept>".
        // Relies on the same fundedPubMeshUi reindex as the gate above, which prod
        // already runs (SEARCH_FUNDING_MESH_GATE is unconditional).
        //
        // PROD-OFF AGAIN 2026-07-14, SAME DAY, AFTER A LIVE PROD PROBE. It was flipped
        // prod-on earlier today on the argument that "the A/B has soaked on staging with
        // no precision complaint". The precision spot-check this flag was explicitly held
        // for HAD NEVER ACTUALLY BEEN RUN, and it fails:
        //
        //   The funding query is an OR -- literal text OR concept tag. `grantMatchCount`
        //   counts the OR. But when `grantMatchTagged` is true the card captions that
        //   count "N of M grants tagged <Concept>". Measured in prod (cwid stt2007,
        //   "antibody-drug conjugate" -> Immunoconjugates): the card rendered
        //   "5 of 24 grants tagged Immunoconjugates" while exactly ONE grant carried the
        //   tag. The other four were text mentions, and the two ranked above the tagged
        //   one were PROSTATE cancer awards. A false count, on the public People card.
        //
        // The recall gain is real and wanted -- the concept axis does admit grants the
        // text axis misses. It is only the COUNT and its caption that lie. Do not re-flip
        // this until `searchFunding` returns a concept-tagged count and the "tagged" label
        // is fed by THAT, not by the OR total (the upgrade the grants route's own comment
        // already anticipates). Then re-run this probe before flipping.
        SEARCH_FUNDING_CONCEPT_GRANTS: env === "staging" ? "on" : "off",
        // #861 -- streams the /search shell so the header/tabs paint before the
        // cold MeSH precompute + the three badge-count searches resolve (the
        // 6-10s first-byte block). resolveSearchShellStreaming reads === "on".
        // STAGING ON (soak + measure cold/warm /search TTFB); PROD OFF until that
        // measurement + go-live. While off the rendered output is byte-identical to
        // today (the body is awaited before the shell, exactly as now). No data
        // prereq; flip is env-only via cdk deploy Sps-App-<env> (CD re-rolls the
        // image only) -- the flag-parity rule.
        SEARCH_SHELL_STREAMING: "on", // Prod flipped 2026-07-07 (#861; no data prereq).
        // #878 -- MeSH-concept rows in the autocomplete dropdown. Reuses the
        // results-page MeSH resolver (getMeshMap().byForm: descriptor names + NLM
        // entry terms + #642 aliases) so the dropdown surfaces a "Flow Cytometry
        // -- MeSH concept" row and resolves synonyms/acronyms (FACS) as you type.
        // resolveSearchSuggestMeshConcept reads === "on". Default OFF BOTH envs
        // (ships dark for a staging soak; flip staging first). No reindex, no new
        // data (reuse-only); flip is env-only via cdk deploy Sps-App-<env> (CD
        // re-rolls the image only) -- the flag-parity rule. Orthogonal to
        // METHODS_LENS_PAGES.
        SEARCH_SUGGEST_MESH_CONCEPT: "off",
        // Section B / B2 -- drop the dedicated concept-escalation pre-count on
        // the People tab. NOTE THE INVERTED POLARITY: "off" is the NEW fast path
        // (read the main search's own total, re-run escalated only on sparse),
        // "on" is today's dedicated size:0 pre-count. resolvePeopleConcept-
        // Precount reads `!== "off"`, so unset == "on" == unchanged. The two
        // states are RESULT-NEUTRAL -- both make the identical escalation
        // decision off the same lexical predicate, so `badge == list` holds
        // either way (locked by tests/unit/search-people-concept-precount.ts);
        // only the round-trip count differs (the win: 2 fewer hops per cold
        // concept-People SSR render on the common non-sparse case). BOTH ENVS
        // now run the reorder ("off"): staging soaked clean, and the win was
        // confirmed deterministically via the D3 `osRoundTrips` SLI (#927) --
        // topic-People drops one OpenSearch hop (4 -> 3) -- because prod's tiny
        // topic-query volume (n=15/14d) is too sparse for a latency-percentile
        // read. Prod applied via `cdk deploy --exclusively Sps-App-prod` (CD
        // re-rolls the image only, so an env-flag change needs the explicit cdk
        // deploy) -- the flag-parity rule.
        SEARCH_PEOPLE_CONCEPT_PRECOUNT: "off",
        // #921 -- concept-scope grant axis. When ON, the Scholars tab under
        // `?match=concept` admits scholars who are FUNDED on the resolved
        // concept (a grant whose SEARCH_FUNDING_MESH_GATE field -- fundedPubMeshUi
        // -- intersects the descendant set), not only those with a concept-tagged
        // publication. The People list, facets, and count badge all widen
        // together (the union rides the always-on filter gate + the scoring
        // `must`), and grant-only matches sort BELOW publication evidence (a 0.1
        // cwid-admission boost, well under pub BM25). resolvePeopleConceptGrant-
        // Axis reads `=== "on"`, default OFF -- so flag-off skips the extra
        // Funding round-trip entirely and leaves every concept-People query body
        // byte-identical to today (the feature ships dark). NO reindex prereq: it
        // reuses the already-live Funding gate field (SEARCH_FUNDING_MESH_GATE ==
        // "fundedPubMeshUi", on in both envs), so activation is a pure flag flip.
        // STAGING-FIRST: on in staging to soak + evaluate (grant-only matches
        // surface count-only for now -- a distinguishing "funded in X" badge,
        // ranking-weight tuning past 0.1, and agg sizing past the 5000-cwid cap
        // are open design follow-ups, NOT activation blockers); prod stays off
        // until that eval. Flip is env-only via `cdk deploy --exclusively
        // Sps-App-<env>` (CD re-rolls the image only) -- the flag-parity rule.
        SEARCH_PEOPLE_CONCEPT_GRANT_AXIS: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        //   SEARCH_MESH_RESOLUTION_FALLBACK -- decompose-and-resolve MeSH fallback.
        //     When ON, resolveMeshDescriptor -- after the exact name/entry-term/alias
        //     lookup misses -- retries the query's contiguous word-windows
        //     (longest-first) and, on a hit, returns the descriptor at the new low
        //     `partial` confidence tier (admits/attributes BENEATH every verbatim tier
        //     via MESH_ADMIT_WEIGHT, so a guess never out-ranks a real match; concept-
        //     only docs already sort below lexical hits). Lets a multi-concept or
        //     qualifier-laden query (e.g. "Liquid biopsy / circulating tumor DNA")
        //     reach its dominant descriptor instead of degrading to free-text.
        //     Guardrail: a single-token window resolves ONLY on an exact descriptor-
        //     NAME match, so a short/common word can't mis-map (the "Seahorse ->
        //     Smegmamorpha" trap). STAGING ON to soak + measure; PROD OFF pending eval.
        //     Resolve-time only: no reindex. Flip is env-only via cdk deploy
        //     Sps-App-<env> (CD re-rolls the image only) -- the flag-parity rule.
        SEARCH_MESH_RESOLUTION_FALLBACK: env === "staging" ? "on" : "off",
        // #1342 -- query-side morphology retry. When ON, resolveMeshDescriptor, after
        //   the exact lookup misses, retries the SINGULARIZED query ("melanomas" ->
        //   "melanoma") against the same index and, on a hit, returns the descriptor at
        //   `partial` confidence. Closes the plural/possessive inflection tail (headline
        //   lay-term wins additionally need the #1258 alias rows). Resolve-time only: no
        //   reindex. STAGING ON to soak; PROD OFF pending eval. Flip env-only via cdk
        //   deploy Sps-App-<env> (CD re-rolls the image only) -- the flag-parity rule.
        SEARCH_MESH_QUERY_NORMALIZATION: "on", // Prod flipped 2026-07-07 (resolve-time, no reindex).
        // #1346 -- acronym wrong-sense guard. When ON, resolveMeshDescriptor suppresses a
        //   short all-caps acronym (CAR/PET) that resolved ONLY via a common-word entry-
        //   term synonym whose matched form is a plain Title-case word (CAR -> "Car" ->
        //   Automobiles, PET -> "Pet" -> Pets) -- the wrong non-medical sense on a medical
        //   search; it drops to BM25. Internal-caps acronyms (COPD/EHR) and exact NAME
        //   matches (DNA/RNA) are kept. Resolve-time only: no reindex. STAGING ON; PROD
        //   OFF pending eval. Flip env-only via cdk deploy Sps-App-<env> (flag-parity).
        SEARCH_ACRONYM_SENSE_GUARD: "on", // Prod flipped 2026-07-07 (#1346; resolve-time, no reindex).
        // #1026 -- surface soft-deleted doctoral-student co-authors as NON-LINKED
        // chips (name + headshot, no profile link, never faceted/searchable) on
        // publication chip surfaces site-wide (search, topic feeds, methods pages,
        // home spotlight). FERPA carve (docs/student-profile-visibility.md): the
        // constraint is on the link/searchability, not the public PubMed name. The
        // code checks `=== "on"`; the non-linked rendering itself is enforced by the
        // prefix-hardened isPubliclyDisplayed regardless of this flag. Flag-off is
        // byte-identical (every hidden-class scholar is soft-deleted, so the relaxed
        // hydration matches no one new). STAGING-FIRST: on in staging to soak pending
        // the WCGS sign-off (docs/outreach/wave3-doctoral-students.md Q2); prod stays
        // off until then. Env-only flip via `cdk deploy --exclusively Sps-App-<env>`.
        COAUTHOR_HIDDEN_STUDENT_CHIPS: "on", // Prod flipped 2026-07-07 (#1026 FERPA non-linked chips; operator-approved).
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
        // #799/#800/#801 -- family-primary "Methods & tools" lens. Two flags,
        // STAGING-FIRST (both ON in staging, OFF in prod until the staging soak
        // completes and the prod data steps are done):
        //   METHODS_LENS_ENABLED      -- master render gate. While off,
        //     loadScholarFamilies/partitionScholarFamilies return [], so the
        //     lens renders nothing and no SEO/JSON side channel leaks.
        //   METHODS_LENS_SENSITIVE_GATE -- #801 audience gate. Hides the
        //     External-Affairs-approved live-animal/in-vivo family subset from
        //     the public profile, revealing it only to the scholar/admin.
        //   METHODS_LENS_FAMILY_FILTER -- #819 click-to-filter. Makes the family
        //     rows clickable to filter the publication list (like Topics). Reads
        //     scholar_family.pmids (ReciterAI#175); only changes the UI affordance,
        //     so flipping it never 500s. Needs the pmids-bearing rollup loaded
        //     (re-run etl:scholar-tool against the >= v2026-06-10 / tools-a2-v2
        //     artifact) before turning on.
        // STRICT DEPLOY ORDER (never flags-first): the scholar_family rollup
        // must exist + be populated (the #794 SCHOLAR_TOOL_SOURCE=s3 cutover)
        // and the #801 sensitivity overlay must be seeded (etl:family-sensitivity)
        // BEFORE this deploy -- flags-on over a missing table 500s every
        // profile; ENABLED-on with the gate off would expose the sensitive
        // families. Deployed manually (cdk deploy --exclusively Sps-App-<env>);
        // the CD pipeline only re-rolls the image.
        METHODS_LENS_ENABLED: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        METHODS_LENS_SENSITIVE_GATE: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        METHODS_LENS_FAMILY_FILTER: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_FAMILY_ROSTER_FALLBACK -- #862. Backfills the per-family
        //     "Top scholars" row with attributed non-faculty (postdocs/fellows/core
        //     staff), faculty-first, when the FT-faculty set is empty/short -- so a
        //     trainee/core-driven family renders a row instead of an empty one.
        //     STAGING ON; PROD OFF -- a public-display policy change pending
        //     External/Faculty Affairs sign-off on surfacing non-faculty in this row.
        //     While off the row is FT-faculty-only, byte-identical to today, and the
        //     tooltip copy reads faculty-only. doctoral_student/affiliate_alumni are
        //     NEVER surfaced regardless of this flag. Image-only/reversible (no data
        //     prereq); flip is env-only via cdk deploy Sps-App-<env>.
        METHODS_LENS_FAMILY_ROSTER_FALLBACK: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_PAGES -- standalone cross-scholar Method pages
        //     (/methods/**), search surfacing, and the per-scholar inbound
        //     links. ARMED ON in BOTH envs. Staging is live (the master lens +
        //     sensitive gate above are staging-on and soaked, and the
        //     scholar_family rollup incl. pmids is loaded on staging via
        //     #819/#820). PROD is ARMED-NOT-LIVE: this flag is INERT in prod
        //     until METHODS_LENS_ENABLED is also flipped at the data-gated
        //     go-live (#794 cutover + the people-attribution reindex) -- a
        //     Method page / search candidate ALSO requires METHODS_LENS_ENABLED,
        //     and CD only re-rolls the image (never cdk deploys), so prod stays
        //     off in practice until a manual cdk deploy Sps-App-prod. When off,
        //     a /methods/** route notFound()s and no search candidate/badge or
        //     inbound link renders.
        METHODS_LENS_PAGES: "on",
        //   METHODS_LENS_FAMILY_DEFINITIONS -- #879. Renders ReciterAI's generated
        //     per-family `definition` (tools-a2-v3 passthrough) on the family page +
        //     the profile methods hover, with an "AI-generated" disclaimer gated on
        //     definition_source === "generated". OFF in BOTH envs at merge -- ships
        //     fully dark because the generated copy is unreviewed: the ETL populates
        //     the column unconditionally, but the family page does not even READ the
        //     definition (no DefinedTerm JSON-LD / SEO side channel) and the profile
        //     payload omits it until this flips. Go-live: migrate + run
        //     etl:scholar-tool (backfill) -> flip staging-on here + cdk deploy
        //     Sps-App-staging to soak -> External Affairs sign-off -> prod on.
        //     STAGING-ON (soak phase): the generated copy renders on staging for
        //     review; PROD stays dark until External Affairs signs off.
        //     RENDER-ONLY: never re-fed into any LLM/embedding/retrieval. Wire in
        //     BOTH .env.local AND here per the flag-parity rule.
        METHODS_LENS_FAMILY_DEFINITIONS: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_TOOL_CONTEXT -- #1119. Surfaces the ReciterAI tool-usage
        //     CONTEXT snippets (scholar_family.exemplar_contexts /
        //     scholar_tool.sample_context) across the public Methods surfaces: a
        //     per-exemplar-tool hover on the profile methods panel, a "How researchers
        //     use these tools" strip on the family page, and the search method-badge
        //     exemplar hover. STAGING-FIRST: on for staging -- the tools ETL ran on
        //     this code against the tool_context.json artifact (v2026-06-13) and
        //     backfilled scholar_family.exemplar_contexts (10,026 family rows) /
        //     scholar_tool.sample_context (11,309 rows) on 2026-06-18, so the columns
        //     are populated. Off for prod (prod ships dark until its own backfill +
        //     flip). Every surface ALSO inherits the #800/#801 family-overlay gate, so
        //     only overlay-visible families render. Go-live (executed for staging):
        //     migrate + run etl:scholar-tool (backfills exemplar_contexts/sample_context)
        //     -> flip staging-on here + cdk deploy Sps-App-staging to soak -> prod on.
        //     Wire in BOTH .env.local AND here per the flag-parity rule.
        METHODS_LENS_TOOL_CONTEXT: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_PUB_MODAL -- #917. The publication-detail modal "Methods"
        //     section (per-pmid method families, #800/#801-gated, linked to the
        //     Method pages). The families data layer + UI shipped in #938; this
        //     per-surface flag (like every other methods-lens surface) lets the modal
        //     section roll out -- or be darked in prod -- INDEPENDENTLY of the rest of
        //     the lens. ADDITIONALLY gated on METHODS_LENS_ENABLED in code. Render-only:
        //     no DB/ETL/reindex dependency. STAGING ON (preserves the surface live since
        //     #938 shipped dark behind the master flag), prod OFF until the gated lens
        //     go-live. Wire in BOTH .env.local AND here per the flag-parity rule.
        METHODS_LENS_PUB_MODAL: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_FAMILY_SYNONYMS -- method-family search synonyms. When on,
        //     matchQueryToTaxonomy ALSO matches a family against its curated lay-term /
        //     brand / acronym synonyms (lib/methods/family-synonyms.ts) via whole-word
        //     window exact match -- so "Seahorse" reaches `extracellular flux
        //     respirometry`, "FACS" reaches `flow cytometry assays`, which the canonical
        //     substring matcher cannot. ADDITIONALLY gated on METHODS_LENS_PAGES (method
        //     candidates only load then), so off OR pages-off => byte-identical to today.
        //     Match-only: no DB, no ETL, no reindex; flip is env-only via cdk deploy
        //     Sps-App-<env> (CD only re-rolls the image). STAGING ON (method lens is
        //     staging-live -> synonyms soak there); PROD OFF (inert anyway until the
        //     methods-lens go-live flips METHODS_LENS_ENABLED in prod).
        METHODS_LENS_FAMILY_SYNONYMS: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_CELL_LINE_ENTITIES -- #1166. Methods Surface B: the ranked
        //     "Specific cell lines used" strip + per-(pub x entity) relevance snippet
        //     + all-cell-lines directory on the method-family page, read from the
        //     family_entity / family_entity_usage tables (loaded from the ReciterAI
        //     tools-a2-v4 entity sidecars by etl:scholar-tool). When off, the readers
        //     return [] (no query) and the page renders the existing tool-usage strip,
        //     so it is byte-identical to today until the entity data lands AND this
        //     flips. App-only: env-only flip via cdk deploy Sps-App-<env> after a
        //     `etl:scholar-tool` backfill against a v4 manifest (CD only re-rolls the
        //     image). STAGING ON (soak there); PROD OFF (no entity data + gated).
        METHODS_LENS_CELL_LINE_ENTITIES: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   METHODS_LENS_ENTITY_USAGE -- #1168. SUPERSET of the cell-line flag:
        //     generalizes the same entity rail + per-paper usage snippet to ALL
        //     tool/method families and lights up the WS-C badge (mention_class ->
        //     "How it was used" / "Where it appears"), WS-B generic soft-suppression,
        //     and the dominant_kind rail noun. Readers serve when EITHER flag is on.
        //     STAGING ON: today this is REDUNDANT with the cell-line flag's OR (the
        //     entity layer is already served on staging), but it locks the entity
        //     layer on independent of METHODS_LENS_CELL_LINE_ENTITIES and is the
        //     prod-rollout rehearsal switch. The all-tools surface stays empty until
        //     the producer emits non-cell-line entity layers + a backfill lands them.
        //     PROD OFF (gated -- no prod entity data, flipped at go-live).
        METHODS_LENS_ENTITY_USAGE: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   CENTER_METHODS_FACET -- #962. The center-roster "Methods & tools"
        //     multi-select facet + per-member tool chips on the GROUPED center
        //     roster. ADDITIONALLY gated on METHODS_LENS_ENABLED in code (the
        //     scholar_family substrate): when the lens is off this is off, so a
        //     center page never queries scholar_family and the payload carries no
        //     family data (no SEO/JSON side channel). PUBLIC families only (same
        //     #800/#801 overlay gate as the lens), so the CloudFront-cacheable
        //     center page stays cacheable -- no per-request/per-viewer call. When
        //     off the grouped roster is byte-identical to today. STAGING-ON (the
        //     lens substrate is staging-on); PROD OFF until the methods-lens
        //     go-live. Wire in BOTH .env.local AND here per the flag-parity rule;
        //     manual cdk deploy Sps-App-<env> required (CD only re-rolls image).
        CENTER_METHODS_FACET: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   ORG_UNIT_METHODS_CHIPS -- #974 Phase 1. Per-member "method chips"
        //     (top-3 public method families) on the DEPARTMENT + DIVISION roster
        //     rows. ADDITIONALLY gated on METHODS_LENS_ENABLED in code (the
        //     scholar_family substrate): when the lens is off this is off, so a
        //     roster page never queries scholar_family and the payload carries no
        //     family data (no SEO/JSON side channel). PUBLIC families only (same
        //     #800/#801 overlay gate as the lens), per-page (<=20 CWIDs) read so
        //     the CloudFront-cacheable roster page stays cacheable -- no
        //     per-request/per-viewer call. CHIPS ONLY (no facet, no whole-dataset
        //     aggregation -- that's Phase 2). STAGING-ON (the lens substrate is
        //     staging-on); PROD OFF until the methods-lens go-live. Wire in BOTH
        //     .env.local AND here per the flag-parity rule; manual cdk deploy
        //     Sps-App-<env> required (CD only re-rolls the image).
        ORG_UNIT_METHODS_CHIPS: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        //   ORG_UNIT_METHODS_FACET -- #974 Phase 2. The DEPARTMENT + DIVISION
        //     roster "Methods & tools" multi-select FACET (server-aggregated
        //     buckets rendered with the cacheable page + a client-fetch to the
        //     uncacheable /api/units/[kind]/[code]/members route for the filtered
        //     roster). ADDITIONALLY gated on METHODS_LENS_ENABLED in code (the
        //     scholar_family substrate): when the lens is off this is off, so no
        //     aggregation runs and the payload carries no facet data (no SEO/JSON
        //     side channel). PUBLIC families only (same #800/#801 overlay gate) --
        //     buckets, selectable families, AND returned chips. The buckets are
        //     viewer-independent, so the roster page stays CloudFront-cacheable;
        //     only the force-dynamic API route filters per request. Independent of
        //     ORG_UNIT_METHODS_CHIPS (Phase 1) so the facet can flip separately.
        //     STAGING-ON (the lens substrate is staging-on); PROD OFF until the
        //     methods-lens go-live. Wire in BOTH .env.local AND here per the
        //     flag-parity rule; manual cdk deploy Sps-App-<env> required (CD only
        //     re-rolls the image).
        ORG_UNIT_METHODS_FACET: "on", // Prod flipped 2026-07-05 (#962/#1481 methods-lens go-live).
        // Cores -- core-facility usage inference (publication_core substrate,
        // ReciterAI pipeline_cores #245; SPS #1161/#1163/#1165/#1176). Three
        // STANDALONE flags, all STAGING-FIRST, all default OFF until the engine
        // + full-corpus run populate confirmed publication_core rows. Unlike the
        // methods lens there is NO master "data" gate: the substrate is just an
        // empty table until ETL Block 6 fills it, so each surface renders nothing
        // (safe but pointless) while empty. Wire in BOTH .env.local AND here per
        // the flag-parity rule; manual `cdk deploy Sps-App-<env>` required (CD
        // only re-rolls the image).
        //   CORE_PUB_MODAL -- #1176. The publication-detail modal "Core
        //     facilities" section (per-pmid, effective-confirmed core_claim
        //     merge). Render-only; omitted when the pub has no confirmed cores.
        //   CORE_PAGES -- #1176. The public /cores/[coreId] pages (force-dynamic;
        //     the route notFound()s while off, so no SEO/JSON side channel). When
        //     CORE_PAGES is also on, the modal chips link to the core page.
        //   CORE_CLAIM_WRITEBACK -- #1163. Gates the best-effort DynamoDB
        //     UpdateItem mirror of an owner claim onto the reciterai item
        //     (TaskRoleCoreClaimWritebackPolicy above -- grant + flag deploy
        //     atomically, no flip-before-grant window). While off the claim still
        //     lands in SPS core_claim (authoritative); only the engine-side
        //     mirror no-ops.
        CORE_PUB_MODAL: env === "staging" ? "on" : "off",
        CORE_PAGES: env === "staging" ? "on" : "off",
        CORE_CLAIM_WRITEBACK: env === "staging" ? "on" : "off",
        // Opportunity URL intake (docs/opportunity-url-intake-spec.md). Gates
        // the submit-a-URL panel on /edit/find-researchers + both
        // /api/edit/opportunity-intake verbs (they 404 while off). The writes
        // go to the SUBMISSION partition of the shared reciterai table
        // (TaskRoleOpportunitySubmissionPolicy above -- grant + flag deploy
        // atomically). STAGING-FIRST. The audit-ENUM widening the first write
        // needs (`opportunity_submission`) rides audit-log.sql's idempotent
        // MODIFY COLUMN block via the sps-db-bootstrap task, so any deploy at
        // or after that commit has already applied it -- no manual DDL step.
        OPPORTUNITY_URL_INTAKE: "on", // Prod flipped 2026-07-07 (enum rides db-bootstrap; IAM rides deploy).
        // Scholar-profile facet-filter redesign (PR-2). A BIG visual change to
        // the Topics/Methods facets + a unified filter bar, fully gated. ON in
        // staging to soak the real-data behavior (method rows + cross-facet
        // "{in} of {total}" counts); OFF in prod until sign-off. While off the
        // rendered output is byte-identical to today. Applying a change here
        // needs cdk deploy Sps-App-<env> (CD only re-rolls the image) — the
        // flag-parity rule.
        PROFILE_FACET_REDESIGN: "on", // Prod flipped 2026-07-07 (facet redesign go-live).
        // #847 -- internal "download the leading scholars" CSV export. When
        // "on", the POST /api/export/scholars/{scope} endpoint accepts
        // authenticated requests and the download button renders; method scopes
        // are ALSO gated by METHODS_LENS_PAGES above. STAGING ON (soak, paired
        // with the #866 email column below); prod OFF (ships dark in prod). Wire
        // in BOTH .env.local AND here per the flag-parity rule; `cdk deploy
        // Sps-App-<env>` required (CD re-rolls the image only).
        SCHOLAR_LIST_EXPORT: "on", // Prod flipped 2026-07-05 (launch flag-parity batch 1, #506; render-only, staging-soaked).
        // #866 -- "internal viewer" gating (authenticated session OR on the WCM
        // network by source IP). STAGING soak ON (network signal + email column);
        // prod OFF (ships dark in prod, pending #876 authoritative ranges +
        // Faculty Affairs sign-off on the email column). Wire in BOTH .env.local
        // AND here per the flag-parity rule -- a manual `cdk deploy Sps-App-<env>`
        // is required (CD re-rolls the image only):
        //   INTERNAL_VIEWER_NETWORK_SIGNAL -- when "on", an unauthenticated
        //     viewer whose CloudFront-Viewer-Address falls inside INTERNAL_VIEWER_CIDRS
        //     also counts as an internal viewer. While off, "internal" means an
        //     authenticated session only (the network half is inert), so an
        //     external viewer can never gain internal access via a spoofable IP.
        //   SCHOLAR_LIST_EXPORT_EMAIL -- UC-B. When "on" (and SCHOLAR_LIST_EXPORT
        //     is also on), the internal-only #847 roster CSV gains an email column
        //     for internal viewers. While off the CSV is byte-identical to today.
        //   INTERNAL_VIEWER_CIDRS -- the CIDR allowlist the network signal matches
        //     the viewer IP against. STAGING carries a TEMP single-host soak CIDR
        //     (one WCM egress in the 157.139.0.0/16 range) -- REPLACE with the
        //     authoritative WCM/Qatar/NYP ranges from #876, sourced together with
        //     EdgeStack edgeAllowedCidrs (#461). Prod EMPTY (network half matches
        //     nobody -- default-safe).
        INTERNAL_VIEWER_NETWORK_SIGNAL: "on", // Prod flipped 2026-07-07 (paired w/ prod CIDRs below; IP signal spoofable — accepted).
        SCHOLAR_LIST_EXPORT_EMAIL: "on", // Prod flipped 2026-07-07 (adds email col to internal roster CSV; operator-approved).
        INTERNAL_VIEWER_CIDRS:
          env === "staging" ? "157.139.83.164/32" : "140.251.0.0/16,157.139.0.0/16",
        // PROFILE_EMAIL_RELEASE_GATE -- when "on", the Web Directory
        // `weillCornellEduReleaseCode;mail` audience (email_visibility) is
        // respected across both profile-email DISPLAY (table A) and the #847
        // export row-filter (none blanks the cell). While off, email is shown
        // to everyone (legacy fail-open) and the export email column is gated
        // only by viewer-context + hidden-role. STAGING ON; PROD OFF.
        // Reindex-then-flip discipline: email_visibility is NULL until backfilled,
        // and NULL is treated as `none` (fail-closed), so flipping before the
        // backfill would hide every email. Staging is now safe to flip: the
        // backfill landed 2026-06-11 via the LDAP->S3 bridge (#898; the in-VPC ED
        // ETL can't reach WCM LDAP -- #443), populating email_visibility for 8,895
        // scholars (verified). PROD stays OFF until its own backfill runs. Wire in
        // BOTH .env.local AND here per the flag-parity rule -- a manual
        // `cdk deploy Sps-App-<env>` is required (CD re-rolls the image only).
        PROFILE_EMAIL_RELEASE_GATE: env === "staging" ? "on" : "off",
        // Superuser tier, sourced from the ED group
        // `ITS:Library:Scholars/superuser-role`. isSuperuser()
        // (lib/auth/superuser.ts, R1) checks the CWID allowlist first, then the
        // group via isGroupMember() (lib/auth/ldap-group.ts resolve+compare).
        //
        // The group is now the source of truth: #1592 gave the app the LDAP
        // credential and #1626 made the dynamic-group query correct+fast
        // (resolve the group DN, then LDAP `compare` — the `groupOfURLs` role
        // groups have no readable `member`, and a `(member=..)` filter times
        // out). All five former allowlist CWIDs are verified members of the ED
        // group in BOTH envs (probe 2026-07-10), so emptying the allowlist locks
        // nobody out. The allowlist is kept as an empty break-glass override.
        //
        // Cost of enabling: isSuperuser() is on the session/edit hot path, so
        // each such request now does one LDAPS bind+compare (~230ms), deduped
        // per request by React cache(). Promote staging-first via a manual
        // reviewer-gated `cdk deploy Sps-App-<env>` and watch latency.
        SCHOLARS_SUPERUSER_GROUP_CN: "ITS:Library:Scholars/superuser-role",
        SCHOLARS_SUPERUSER_CWIDS: "",
        // comms_steward Method-Family visibility role + surface
        // (docs/comms-steward-methods-visibility-spec.md §3/§9). Three vars,
        // OFF in BOTH envs at launch -- the surface ships dark until External
        // Affairs names the steward set and the LDAP group is created:
        //   COMMS_STEWARD_ENABLED -- the §9 master kill switch. While not "on",
        //     isCommsSteward() short-circuits to false BEFORE any directory work,
        //     so the /edit/methods route 404s and every /api/edit/methods/* and
        //     the /api/export/methods/families endpoint 404 -- regardless of
        //     group membership or the allowlist below. Flip to "on" per-env only
        //     after the group exists (or the interim allowlist is set) AND the
        //     surfacing pass has run once (npm run etl:family-review).
        //   SCHOLARS_COMMS_STEWARD_GROUP_CN -- the ED group whose membership
        //     confers the role: ITS:Library:Scholars/comms-steward-role, now the
        //     source of truth. Resolved via isGroupMember() (resolve+compare,
        //     #1626). dwd2001 is a verified member in both envs (probe
        //     2026-07-10). NOTE: prod previously conferred this to NO ONE (empty
        //     prod allowlist), so setting the cn NEWLY grants dwd2001 comms-
        //     steward in prod — the intended go-live, not a mechanism no-op.
        //   SCHOLARS_COMMS_STEWARD_ALLOWLIST -- kept as an empty break-glass
        //     override (mirrors SCHOLARS_SUPERUSER_CWIDS); the group is the
        //     operative source now that the LDAP route (#1592) + query (#1626)
        //     are in place.
        // COMMS_STEWARD_ENABLED stays on both envs; membership now flows from the
        // ED group. Promotion is a manual reviewer-gated `cdk deploy
        // Sps-App-<env>` (staging first); CD re-rolls the image only.
        COMMS_STEWARD_ENABLED: env === "staging" || env === "prod" ? "on" : "off",
        SCHOLARS_COMMS_STEWARD_GROUP_CN: "ITS:Library:Scholars/comms-steward-role",
        SCHOLARS_COMMS_STEWARD_ALLOWLIST: "",
        // `development` role (GrantRecs Phase 4 — the /edit/find-researchers
        // reverse-matcher admin surface). The page + its data route admit
        // `isSuperuser || isDeveloper`, so superusers always retain access; the
        // dev role adds a non-superuser operator tier.
        //   DEVELOPMENT_ENABLED -- master kill switch. While not "on",
        //     isDeveloper() short-circuits to false BEFORE any directory work.
        //     ENABLED for staging + prod. Prod was validated on staging first
        //     and promoted via a reviewer-gated `cdk deploy Sps-App-prod`; note
        //     the flag is inert until the prod image carries the find-researchers
        //     feature (#1185), so it ships with the next full prod release.
        //   SCHOLARS_DEVELOPMENT_GROUP_CN -- the ED group whose membership
        //     confers the role: ITS:Library:Scholars/development-role, now the
        //     source of truth. isDeveloper() (lib/auth/development.ts) is called
        //     unconditionally by getEffectiveEditSession(), so this puts an LDAPS
        //     bind+compare on the /edit path per request (deduped by React
        //     cache()); #1626 made that query correct+fast (resolve+compare,
        //     ~230ms) so it is no longer the latency trap that kept it pinned "".
        //     Both former allowlist members are verified in the group: flm4001
        //     (employee) and lmp2006 (affiliate — the group carries a per-uid
        //     memberURL for each, so the affiliate is matched by an affiliate-
        //     filtered line). Probe 2026-07-10, both envs.
        //   SCHOLARS_DEVELOPMENT_ALLOWLIST -- kept as an empty break-glass
        //     override; the ED group is the operative source now.
        DEVELOPMENT_ENABLED: env === "staging" || env === "prod" ? "on" : "off",
        SCHOLARS_DEVELOPMENT_GROUP_CN: "ITS:Library:Scholars/development-role",
        SCHOLARS_DEVELOPMENT_ALLOWLIST: "",
        // #374 — Content-Security-Policy rollout mode. next.config.ts reads
        // this via lib/security-headers.ts `resolveCspMode()`: "report-only"
        // ships the policy as `Content-Security-Policy-Report-Only` (the
        // launch default both envs carry), "enforce" flips the same policy
        // value to the enforcing `Content-Security-Policy` header. Wired here
        // per-env (envConfig.cspMode) so promotion is a config edit + manual
        // `cdk deploy Sps-App-<env>` — CD re-rolls the image but never the
        // task-def env, so without this the flag would never reach the task.
        // Promote staging first, only after its post-#636 report feed is
        // confirmed clean under real traffic (see issue #374).
        SECURITY_CSP_MODE: envConfig.cspMode,
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(appRwSecret),
        DATABASE_URL_RO: ecs.Secret.fromSecretsManager(appRoSecret),
        // Cutover de-coupling (§8.4): when on, OPENSEARCH_NODE comes from the
        // secret's `node` key instead of the dropped cross-stack export above.
        ...(envConfig.openSearchNodeFromSecret
          ? {
              OPENSEARCH_NODE: ecs.Secret.fromSecretsManager(opensearchAppSecret, "node"),
            }
          : {}),
        OPENSEARCH_USER: ecs.Secret.fromSecretsManager(opensearchAppSecret, "username"),
        OPENSEARCH_PASS: ecs.Secret.fromSecretsManager(opensearchAppSecret, "password"),
        // Read by lib/revalidate-auth.ts / app/api/revalidate as
        // SCHOLARS_REVALIDATE_TOKEN -- the env-var name is the contract. #447
        SCHOLARS_REVALIDATE_TOKEN: ecs.Secret.fromSecretsManager(revalidateTokenSecret),
        // Read by app/api/faculty-review/[cwid]/grants as FACULTY_REVIEW_TOKEN --
        // the WCM Faculty Review Tool's shared bearer. Dark until seeded (#1855).
        FACULTY_REVIEW_TOKEN: ecs.Secret.fromSecretsManager(facultyReviewTokenSecret),
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
        // WCM Enterprise Directory bind (#1592, #1595). The env-var name == the
        // secret's JSON key; the app reads these via lib/sources/ldap.ts. The
        // read-only bind backs the SSO-gated GET /api/directory/people -- the
        // SAME secret the nightly ED ETL consumes.
        SCHOLARS_LDAP_URL: ecs.Secret.fromSecretsManager(
          edSecret,
          "SCHOLARS_LDAP_URL",
        ),
        SCHOLARS_LDAP_BIND_DN: ecs.Secret.fromSecretsManager(
          edSecret,
          "SCHOLARS_LDAP_BIND_DN",
        ),
        SCHOLARS_LDAP_BIND_PASSWORD: ecs.Secret.fromSecretsManager(
          edSecret,
          "SCHOLARS_LDAP_BIND_PASSWORD",
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
        NEW_RELIC_LICENSE_KEY: ecs.Secret.fromSecretsManager(newRelicLicenseKeySecret),
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
    this.migrationTaskDefinition = new ecs.FargateTaskDefinition(this, "MigrationTaskDefinition", {
      family: `sps-migrate-${env}`,
      cpu: envConfig.migrationTaskCpu,
      memoryLimitMiB: envConfig.migrationTaskMemoryMiB,
      executionRole: deployTaskExecutionRole,
      taskRole,
    });
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
    // G15 (docs/cutover-item3-execution-runbook.md §0): the ALBs + target
    // groups are VPC-coupled, so the useSharedVpc flip REPLACES them onto the
    // shared VPC. A fixed physical name blocks CFN create-before-delete
    // ("sps-public-<env> already exists" — the old one still holds the name).
    // Auto-generate the name when shared; keep the exact env-prefixed name when
    // standalone so flag-off synth stays byte-identical. Names are not
    // externally referenced (NetScaler reads the ALB DNS, not the name).
    const sharedReplaceName = (fixed: string): string | undefined =>
      envConfig.useSharedVpc ? undefined : fixed;

    this.publicAlb = new elbv2.ApplicationLoadBalancer(this, "PublicAlb", {
      loadBalancerName: sharedReplaceName(`sps-public-${env}`),
      vpc,
      internetFacing: true,
      vpcSubnets: albSubnets,
      securityGroup: albSecurityGroup,
    });

    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, "InternalAlb", {
      loadBalancerName: sharedReplaceName(`sps-internal-${env}`),
      vpc,
      internetFacing: false,
      vpcSubnets: appSubnets,
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
    const publicAppTargetGroup = new elbv2.ApplicationTargetGroup(this, "PublicAppTargetGroup", {
      ...tgProps,
      targetGroupName: sharedReplaceName(`sps-tg-pub-${env}`),
    });
    const internalAppTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "InternalAppTargetGroup",
      { ...tgProps, targetGroupName: sharedReplaceName(`sps-tg-int-${env}`) },
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
    const originVerifiedRule = new elbv2.ApplicationListenerRule(this, "OriginVerifiedForward", {
      listener: publicListener,
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader("X-Origin-Verify", [
          originSharedSecretValue.unsafeUnwrap(),
        ]),
      ],
      action: elbv2.ListenerAction.forward([publicAppTargetGroup]),
    });
    // #1507 -- HTTPS :443 listener alongside :80 (kept; :80 removal is a
    // follow-up) so CloudFront's origin leg can run over TLS. Same 403-default
    // + X-Origin-Verify-forward shape as :80, onto the same target group. Added
    // only once the ALB-region cert (edgeOriginCertArn) is seeded; ships dark.
    if (envConfig.edgeOriginCertArn.length > 0) {
      const publicHttpsListener = this.publicAlb.addListener("PublicHttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(envConfig.edgeOriginCertArn)],
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: "text/plain",
          messageBody: "Forbidden",
        }),
      });
      new elbv2.ApplicationListenerRule(this, "OriginVerifiedForwardHttps", {
        listener: publicHttpsListener,
        priority: 1,
        conditions: [
          elbv2.ListenerCondition.httpHeader("X-Origin-Verify", [
            originSharedSecretValue.unsafeUnwrap(),
          ]),
        ],
        action: elbv2.ListenerAction.forward([publicAppTargetGroup]),
      });
    }
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
      vpcSubnets: appSubnets,
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
    const githubOidcProviderArnContext = this.node.tryGetContext("githubOidcProviderArn") as
      | string
      | undefined;
    // staging owns/creates the account-scoped provider; every other env imports
    // it. `-c createGithubOidcProvider=true` forces creation for a fresh-account
    // bootstrap from a non-staging env.
    const ownsGithubOidcProvider =
      env === "staging" || `${this.node.tryGetContext("createGithubOidcProvider")}` === "true";
    const githubOidcProvider = ownsGithubOidcProvider
      ? new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
          url: `https://${githubOidcIssuerHost}`,
          clientIds: ["sts.amazonaws.com"],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidcProvider",
          githubOidcProviderArnContext && githubOidcProviderArnContext.length > 0
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
        resources: [this.ecrRepository.repositoryArn, this.etlEcrRepository.repositoryArn],
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
    // Skipped when sharing its-reciter-vpc01 (plan §4.4 / §5.5 / G5): a
    // privateDNS Secrets Manager endpoint flips VPC-wide private DNS, which
    // would hijack the co-tenant ReCiter workloads' SM resolution, and a gateway
    // endpoint mutates shared route tables SPS does not own. its-reciter already
    // provides the S3/DynamoDB gateway + Lambda interface endpoints, and SPS
    // reaches Secrets Manager over its-reciter's NAT. SPS owns these endpoints
    // only in the standalone Sps VPC it creates.
    if (!envConfig.useSharedVpc) {
      const vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, "VpcEndpointSecurityGroup", {
        vpc,
        description: `SPS VPC interface endpoints (${env}) -- HTTPS from app + ETL SGs.`,
        allowAllOutbound: false,
      });
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
    }

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
      description: "SPS one-shot scholars_audit bootstrap task family - run before migrate (#493)",
    });
    new CfnOutput(this, "EcsVerifyGrantsTaskFamily", {
      value: this.verifyGrantsTaskDefinition.family,
      description:
        "SPS one-shot grant-equality verify task family - run after db-bootstrap, before the service rolls (ADR-009)",
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
      description: "SPS internal ALB security group id (consumed by EtlStack ingress).",
    });

    // Item-3 pass 1 (publish; docs/cutover-item3-implementation-map-2026-06-30.md).
    // Mirror the internal-ALB SG-id + DNS and the public-ALB DNS into SSM so pass-2
    // consumers read them by id instead of the cross-stack handle / named export
    // that locks at the useSharedVpc flip (both ALBs replace onto the shared VPC):
    //   - EtlStack repoints to the internal-ALB DNS + SG-id params (edges 6/7). The
    //     named CfnOutputs above stay, so those exports are never orphaned — no pin.
    //   - EdgeStack repoints to the public-ALB DNS param (edge 8), whose current
    //     source is the AUTO-generated FnGetAtt DNSName export from the handle Edge
    //     imports today; pin it so dropping that import at pass 2 leaves no in-use
    //     export for the flip to delete. (Removed in the pass-4 cleanup.)
    const appParam = (name: string, value: string): void => {
      new ssm.StringParameter(this, `App-${name}`, {
        parameterName: `/sps/${env}/app/${name}`,
        stringValue: value,
      });
    };
    appParam("internal-alb-sg-id", internalAlbSecurityGroup.securityGroupId);
    appParam("internal-alb-dns", this.internalAlb.loadBalancerDnsName);
    appParam("public-alb-dns", this.publicAlb.loadBalancerDnsName);
    this.exportValue(this.publicAlb.loadBalancerDnsName);
    new CfnOutput(this, "DeployRoleArn", {
      value: this.deployRole.roleArn,
      description: "SPS GitHub Actions deploy role ARN",
    });
  }
}
