import * as path from "node:path";
import {
  CustomResource,
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  Token,
  type StackProps,
} from "aws-cdk-lib";
import * as backup from "aws-cdk-lib/aws-backup";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as opensearchservice from "aws-cdk-lib/aws-opensearchservice";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link DataStack}. */
export interface DataStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** VPC the cluster and domain attach to (from NetworkStack). */
  readonly vpc: ec2.IVpc;
  /** ECS application security group — granted Aurora + OpenSearch ingress. */
  readonly appSecurityGroup: ec2.ISecurityGroup;
  /** ETL Lambda security group — granted Aurora + OpenSearch ingress. */
  readonly etlSecurityGroup: ec2.ISecurityGroup;
  /**
   * DR-region {@link backup.IBackupVault} from {@link DrBackupVaultStack}.
   * The AWS Backup plan's `copyAction` writes recovery points here, closing
   * B10's cross-region snapshot copy.
   */
  readonly drBackupVault: backup.IBackupVault;
}

/**
 * DataStack — Aurora MySQL, the OpenSearch domain, and the AWS Backup plan
 * that cross-region-copies snapshots to the DR vault (ADR-008, B10).
 *
 * Stack 2 of the six in ADR-008. The IAM execution-role / task-role split for
 * the ECS service (B06's roles half) lands in AppStack; the per-source ETL
 * credential secrets (`scholars/etl/{source}`) land in EtlStack — both deferred
 * to their consumer stacks so the SecretsStack supplement is authored against
 * the live list of Lambdas, not speculative names.
 *
 * Stateful resources here are deletion-protected and carry
 * `RemovalPolicy.RETAIN` (ADR-008's blast-radius rule).
 */
export class DataStack extends Stack {
  /** Aurora MySQL Serverless v2 cluster. */
  public readonly auroraCluster: rds.DatabaseCluster;
  /**
   * Auto-generated master-user secret bound to the cluster. SecretsStack
   * attaches the Secrets Manager RDS rotation Lambda to this (B06).
   */
  public readonly auroraMasterSecret: secretsmanager.ISecret;
  /** OpenSearch domain in private subnets. */
  public readonly opensearchDomain: opensearchservice.Domain;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envConfig, vpc, appSecurityGroup, etlSecurityGroup, drBackupVault } =
      props;

    // ------------------------------------------------------------------
    // Security groups for the data plane. Each is created in this stack
    // (not in NetworkStack) so that the data-resource and its reachability
    // rules live together — a deploy of the cluster brings its ingress
    // with it. NetworkStack's app/etl SGs already exist; we only add
    // ingress to ours referencing them, never the reverse.
    // ------------------------------------------------------------------
    const auroraSecurityGroup = new ec2.SecurityGroup(this, "AuroraSecurityGroup", {
      vpc,
      description: `SPS Aurora MySQL (${envConfig.envName})`,
      allowAllOutbound: false,
    });
    auroraSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(3306),
      "ECS app tasks to Aurora writer/reader endpoints",
    );
    auroraSecurityGroup.addIngressRule(
      etlSecurityGroup,
      ec2.Port.tcp(3306),
      "ETL Lambdas to Aurora writer/reader endpoints",
    );
    // The Secrets Manager RDS rotation Lambda's SG ingress is added by
    // `cluster.addRotationSingleUser()` below — CDK creates the Lambda + a
    // dedicated SG + the Aurora-SG ingress rule together, so we do not
    // declare one here.

    const opensearchSecurityGroup = new ec2.SecurityGroup(
      this,
      "OpenSearchSecurityGroup",
      {
        vpc,
        description: `SPS OpenSearch domain (${envConfig.envName})`,
        allowAllOutbound: false,
      },
    );
    opensearchSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(443),
      "ECS app tasks to OpenSearch HTTPS",
    );
    opensearchSecurityGroup.addIngressRule(
      etlSecurityGroup,
      ec2.Port.tcp(443),
      "ETL Lambdas to OpenSearch HTTPS (index writes + suggest)",
    );

    // ------------------------------------------------------------------
    // Aurora MySQL Serverless v2.
    //
    // - Engine: Aurora MySQL 3.x (MySQL-8.0-compatible) per ADR-004 / Prisma.
    // - Multi-AZ: writer + N readers; ACU range per env (config).
    // - Encryption at rest: AWS-managed KMS key.
    // - Deletion protection ON, RemovalPolicy RETAIN — ADR-008 blast-radius.
    // - Backup retention drives the PITR window (Aurora ties them).
    //   B10's 35-day archive layer is provided by AWS Backup below, not by
    //   stretching the cluster's native retention beyond what we need.
    // - Master credentials live in an auto-generated Secrets Manager secret
    //   (`scholars/{env}/db/master`). SecretsStack attaches RDS rotation; no
    //   plaintext value ever appears in CDK source (ADR-008 hard rule).
    // ------------------------------------------------------------------
    const readers = Array.from(
      { length: envConfig.auroraReaderCount },
      (_, i) =>
        rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, {
          scaleWithWriter: true,
          publiclyAccessible: false,
        }),
    );

    this.auroraCluster = new rds.DatabaseCluster(this, "AuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_08_0,
      }),
      credentials: rds.Credentials.fromGeneratedSecret("scholars_admin", {
        // Env-prefixed because account `665083158573` hosts both staging and
        // prod (one-account deviation from ADR-008's separate-accounts
        // alternative). Without the env in the path, the two stacks collide
        // on Secrets Manager's per-region-per-account name uniqueness.
        secretName: `scholars/${envConfig.envName}/db/master`,
      }),
      defaultDatabaseName: "scholars",
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [auroraSecurityGroup],
      writer: rds.ClusterInstance.serverlessV2("Writer", {
        publiclyAccessible: false,
      }),
      readers,
      serverlessV2MinCapacity: envConfig.auroraMinCapacity,
      serverlessV2MaxCapacity: envConfig.auroraMaxCapacity,
      storageEncrypted: true,
      deletionProtection: true,
      backup: {
        retention: Duration.days(envConfig.auroraBackupRetentionDays),
        preferredWindow: "03:00-04:00",
      },
      iamAuthentication: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // The auto-generated master secret. Retain on cluster delete so the
    // recovery procedure can read the credentials from Secrets Manager even
    // if the cluster has been replaced from a snapshot. RETAIN on
    // UpdateReplacePolicy is equally critical: a Name change triggers a
    // CFN replace (Name is replace-required for AWS::SecretsManager::Secret),
    // and without RETAIN the OLD secret holding the cluster's live password
    // is deleted. `cluster.secret` resolves through a SecretTargetAttachment
    // whose `node.defaultChild` is that attachment, not the underlying
    // Secret — so calling `applyRemovalPolicy` on it (the original shape of
    // this code) only set the policy on the attachment. Walk into the
    // construct tree directly so the policy lands on the real CfnSecret.
    if (!this.auroraCluster.secret) {
      throw new Error(
        "Aurora cluster did not produce a master secret — Credentials.fromGeneratedSecret should always create one.",
      );
    }
    this.auroraMasterSecret = this.auroraCluster.secret;
    const masterSecretConstruct = this.auroraCluster.node.findChild(
      "Secret",
    ) as secretsmanager.Secret;
    (
      masterSecretConstruct.node.defaultChild as secretsmanager.CfnSecret
    ).applyRemovalPolicy(RemovalPolicy.RETAIN);

    // RDS rotation for the Aurora master credentials (B06 secrets half).
    //
    // ADR-008 nominally puts "RDS rotation" in SecretsStack, but CDK places
    // `AWS::SecretsManager::RotationSchedule` in the secret's stack — and the
    // Aurora master secret is auto-generated by Credentials.fromGeneratedSecret,
    // which binds it to the cluster (this stack). Threading the secret to
    // SecretsStack for rotation creates a structural cycle between the two
    // stacks (cluster + RotationSchedule one direction, rotation Lambda the
    // other) that no rearrangement avoids while keeping the cluster's
    // generated master password. The rotation Lambda therefore lives here,
    // with the cluster + secret it rotates; SecretsStack continues to own
    // the *application-tier* secret definitions and would own their rotation
    // if any of them grew an auto-rotation Lambda.
    //
    // Single-user rotation is the right primitive: the master user is
    // administrative and never serves an application connection, so the brief
    // reconnect window at rotation time is invisible.
    this.auroraCluster.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
      excludeCharacters: '"@/\\',
    });

    // ------------------------------------------------------------------
    // sps_bootstrap seeder (#493 PR 2).
    //
    // A CloudFormation custom resource that, at `cdk deploy`, uses the Aurora
    // MASTER credential to create the least-privilege `sps_bootstrap` role
    // (CREATE/ALTER on `scholars_audit`.* + INSERT there WITH GRANT OPTION;
    // nothing on `scholars`) and writes its DSN into the SecretsStack
    // `db/bootstrap` stub that the PR-1 `sps-db-bootstrap` task reads.
    //
    // This Lambda's execution role is the SOLE principal granted read on the
    // master secret, and it is invoked only by CloudFormation — never CI, never
    // a task definition. That is the whole point of the two-runner split: the
    // recurring audit provisioning runs as the least-priv `sps_bootstrap` user
    // in the deploy pipeline, while the one-time master use that mints that user
    // is confined here, in the stack that already owns the master secret. The
    // security boundary is that IAM role, not the network SG: only this role can
    // read the master secret, regardless of which SG the Lambda's ENI shares.
    //
    // Networking: the seeder runs in-VPC on the **ETL security group**. It needs
    // exactly two reachable endpoints — Secrets Manager (read master, read/write
    // the bootstrap stub) and Aurora (CREATE USER + GRANT) — and the ETL SG is
    // already admitted on both: AppStack admits it on the Secrets Manager
    // interface VPC endpoint (443) and this stack admits it on Aurora (3306).
    //
    // A *dedicated* seeder SG is not viable. The Secrets Manager interface
    // endpoint has private DNS enabled, so every in-VPC call to
    // `secretsmanager.<region>.amazonaws.com` resolves to the endpoint's private
    // IP — meaning the seeder's SG must be admitted on the *endpoint* SG, which
    // lives in AppStack, downstream of this stack. The seeder runs at this
    // stack's deploy, before AppStack, so a fresh SG could not be blessed there
    // without inverting the stack dependency. (That inversion is exactly the bug:
    // a dedicated seeder SG hung ~49s on the master-secret read — never reaching
    // Aurora — because the endpoint dropped its 443 SYN.) Reusing the ETL SG,
    // already blessed on both the endpoint and Aurora, sidesteps the layering.
    // ------------------------------------------------------------------
    const bootstrapSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "BootstrapSecret",
      `scholars/${envConfig.envName}/db/bootstrap`,
    );
    // The migrate-role stub the seeder also populates (ADR-009 Phase 1).
    const migrateSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "MigrateSecret",
      `scholars/${envConfig.envName}/db/migrate`,
    );

    const seederLogGroup = new logs.LogGroup(this, "DbBootstrapSeederLogGroup", {
      logGroupName: `/aws/lambda/sps-db-bootstrap-seed-${envConfig.envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const seederFunction = new NodejsFunction(
      this,
      "DbBootstrapSeederFunction",
      {
        functionName: `sps-db-bootstrap-seed-${envConfig.envName}`,
        entry: path.join(__dirname, "../lambda/db-bootstrap-seed/index.ts"),
        // Pin the seeder's own lockfile — otherwise NodejsFunction walks up to
        // cdk/package-lock.json (which has no mariadb) and `npm ci` fails during
        // the nodeModules install.
        depsLockFilePath: path.join(
          __dirname,
          "../lambda/db-bootstrap-seed/package-lock.json",
        ),
        handler: "onEvent",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: Duration.minutes(2),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        // ETL SG: already admitted on the Secrets Manager interface endpoint
        // (443, AppStack) and on Aurora (3306, this stack) — see the block
        // comment above for why a dedicated seeder SG can't reach the endpoint.
        securityGroups: [etlSecurityGroup],
        logGroup: seederLogGroup,
        environment: {
          MASTER_SECRET_ARN: this.auroraMasterSecret.secretArn,
          BOOTSTRAP_SECRET_ARN: bootstrapSecret.secretArn,
          MIGRATE_SECRET_ARN: migrateSecret.secretArn,
          DB_HOST: this.auroraCluster.clusterEndpoint.hostname,
          DB_PORT: Token.asString(this.auroraCluster.clusterEndpoint.port),
          // ADR-009 Phase 3: the host scope of the app_rw grant the seeder
          // tightens to DML-only (`%` prod / `10.20.%` staging). app_rw is
          // host-scoped, unlike the seeder's own `@'%'` roles.
          APP_RW_GRANTEE_HOST: envConfig.appRwGranteeHost,
        },
        bundling: {
          // Emit an ESM bundle. The handler sources are ESM-native (`import`
          // syntax, `.js` relative specifiers) and `mariadb`@3's `promise`
          // entry is ESM-only. A default CJS bundle compiles the import down to
          // `require("mariadb")`, which throws `require() of ES Module
          // .../mariadb/promise.js not supported` at load on the Node 22
          // runtime — so the seeder crashed before opening a connection and
          // had never run on any environment. ESM output keeps the static
          // `import`, which Node resolves against the installed driver.
          format: OutputFormat.ESM,
          // Provided by the Lambda runtime; bundling it inflates cold start.
          externalModules: ["@aws-sdk/client-secrets-manager"],
          // mariadb is a runtime dep (the driver) — CDK npm-installs it into the
          // bundle rather than esbuild-inlining the connector's dynamic requires.
          nodeModules: ["mariadb"],
          sourceMap: false,
          target: "node22",
        },
      },
    );
    // Master read is granted to THIS Lambda's role only — the sole master
    // consumer besides the RDS rotation Lambda. Read+write on the bootstrap
    // stub so the seeder can reuse an existing password and persist a new DSN.
    this.auroraMasterSecret.grantRead(seederFunction);
    bootstrapSecret.grantRead(seederFunction);
    bootstrapSecret.grantWrite(seederFunction);
    // Same read+write on the migrate stub so the seeder can reuse an existing
    // password and persist a fresh DSN (ADR-009 Phase 1).
    migrateSecret.grantRead(seederFunction);
    migrateSecret.grantWrite(seederFunction);

    const seederProvider = new cr.Provider(this, "DbBootstrapSeederProvider", {
      onEventHandler: seederFunction,
    });
    // No explicit ingress-ordering dependency is needed: the seeder reaches
    // Secrets Manager and Aurora over the ETL SG's grants, both of which exist
    // before it runs — the Aurora 3306 ingress is created with the cluster SG
    // here (and the resource already orders after the cluster via the Lambda's
    // env vars), and the endpoint's 443 ingress is owned by AppStack. The
    // serviceToken dependency orders the resource after the provider Lambda.
    new CustomResource(this, "DbBootstrapSeederResource", {
      serviceToken: seederProvider.serviceToken,
      properties: {
        // Bump to force a re-assert of the user + grants on a future change to
        // the seeded grant set (the handler is idempotent, so re-runs are safe).
        // "2": ADR-009 Phase 1 added the sps_migrate role to the seeder.
        // "3": ADR-009 Phase 3 revokes app_rw's `scholars`.* DDL (DML-only).
        // "4": #917 grants app_ro SELECT on scholars_audit.manual_edit_audit (/edit history reads).
        Revision: "4",
      },
    });

    // ------------------------------------------------------------------
    // OpenSearch domain.
    //
    // Fine-grained access control with an IAM master and the internal user
    // database enabled, with an INTERNAL master user (username + password).
    //
    // History (#443): the original config set an IAM master ARN *and*
    // `InternalUserDatabaseEnabled=true`. AWS does NOT support that
    // combination -- it silently dropped the master, leaving the deployed
    // domain with `MasterUserOptions: null` and an un-administrable
    // `_security` API (a later `update-domain-config` to add the IAM master
    // was a confirmed no-op). FGAC master is EITHER an IAM ARN (no internal
    // DB) OR an internal user (with the internal DB). Since the app + ETL
    // authenticate via HTTP basic auth (`lib/search.ts`, the
    // `scholars/{env}/opensearch/{app,etl}` secrets), we need the internal
    // user database, so the master must be an internal user too. Its password
    // comes from the `scholars/{env}/opensearch/master` secret (SecretsStack
    // stub, seeded out-of-band per ADR-008 -- no value in CDK). The master
    // then creates the app/etl internal users via the `_security` API.
    //
    // Multi-AZ-without-standby for prod (two AZs match NetworkStack);
    // single-AZ for staging. Encryption at rest + node-to-node + HTTPS-only.
    // ------------------------------------------------------------------
    const opensearchMultiAz = envConfig.opensearchDataNodes > 1;
    // OpenSearch validates `len(VPCOptions.SubnetIds) == zone-awareness AZ
    // count` at create time. Default `vpcSubnets` selection on a 2-AZ VPC
    // returns both private subnets, which the API rejects for a single-AZ
    // domain ("You must specify exactly one subnet"). Pick the exact subnet
    // count the topology calls for: 1 for single-AZ staging, N for the
    // multi-AZ envs.
    const allPrivateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;
    const opensearchSubnets = allPrivateSubnets.slice(
      0,
      envConfig.opensearchDataNodes,
    );
    this.opensearchDomain = new opensearchservice.Domain(this, "OpenSearch", {
      version: opensearchservice.EngineVersion.OPENSEARCH_2_19,
      vpc,
      vpcSubnets: [{ subnets: opensearchSubnets }],
      securityGroups: [opensearchSecurityGroup],
      capacity: {
        dataNodes: envConfig.opensearchDataNodes,
        dataNodeInstanceType: envConfig.opensearchDataNodeInstanceType,
        multiAzWithStandbyEnabled: false,
      },
      zoneAwareness: opensearchMultiAz
        ? { enabled: true, availabilityZoneCount: 2 }
        : { enabled: false },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      tlsSecurityPolicy: opensearchservice.TLSSecurityPolicy.TLS_1_2_PFS,
      // Internal master user. Providing `masterUserName` + `masterUserPassword`
      // makes CDK synthesize `InternalUserDatabaseEnabled: true` +
      // `MasterUserOptions.{MasterUserName,MasterUserPassword}` -- no escape
      // hatch needed. The password is a Secrets Manager dynamic reference, so
      // no plaintext value enters CDK source or the template (ADR-008). Seed
      // `scholars/<env>/opensearch/master` before deploying this stack.
      fineGrainedAccessControl: {
        masterUserName: "sps_master",
        masterUserPassword: SecretValue.secretsManager(
          `scholars/${envConfig.envName}/opensearch/master`,
        ),
      },
      enableAutoSoftwareUpdate: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Domain access policy — allow `es:ESHttp*` from any AWS principal.
    //
    // With FGAC + internal user database + HTTP basic auth, the request
    // arrives at AWS unsigned (the client uses an Authorization: Basic
    // header rather than SigV4). AWS evaluates the IAM resource policy on
    // the domain first; if it does not permit the request, AWS denies it
    // as `User: anonymous is not authorized to perform: es:ESHttpGet` and
    // OpenSearch never sees the request. To let basic-auth requests reach
    // FGAC, the domain access policy must permit `es:ESHttp*` from
    // `Principal: { AWS: "*" }`. This is the AWS-documented pattern for
    // VPC domains with basic auth — the VPC and the SG ingress rules are
    // the real network gates; FGAC's username/password is the application
    // gate. Anonymous access into OpenSearch is still blocked because
    // `AdvancedSecurityOptions.AnonymousAuthEnabled` is false.
    this.opensearchDomain.addAccessPolicies(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ["es:ESHttp*"],
        resources: [`${this.opensearchDomain.domainArn}/*`],
      }),
    );

    // ------------------------------------------------------------------
    // AWS Backup — daily plan in this region, cross-region copy to the DR
    // vault. B10: PITR 14d (above, via Aurora backup.retention) +
    // automated snapshot retention 35d (this plan's deleteAfter, prod).
    // The "manual snapshot before each weekly ETL" step is a Step Functions
    // task that lands with EtlStack (B08) — not part of this stack.
    // ------------------------------------------------------------------
    const sourceVault = new backup.BackupVault(this, "BackupVault", {
      backupVaultName: `sps-backup-vault-${envConfig.envName}`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const backupPlan = new backup.BackupPlan(this, "BackupPlan", {
      backupPlanName: `sps-aurora-daily-${envConfig.envName}`,
      backupVault: sourceVault,
    });
    backupPlan.addRule(
      new backup.BackupPlanRule({
        ruleName: "daily",
        // Daily at 05:00 UTC — overlaps with Aurora's preferred backup window
        // (03:00–04:00 UTC) intentionally; AWS Backup uses the cluster's
        // automated-snapshot machinery, the schedule is when AWS Backup
        // records the recovery point, not when it dumps the cluster.
        scheduleExpression: events.Schedule.cron({
          minute: "0",
          hour: "5",
        }),
        deleteAfter: Duration.days(envConfig.awsBackupRetentionDays),
        copyActions: [
          {
            destinationBackupVault: drBackupVault,
            deleteAfter: Duration.days(envConfig.awsBackupRetentionDays),
          },
        ],
      }),
    );
    backupPlan.addSelection("AuroraSelection", {
      resources: [
        backup.BackupResource.fromRdsDatabaseCluster(this.auroraCluster),
      ],
    });

    // ------------------------------------------------------------------
    // Outputs — surfaced for cdk diff / deploy review and for the later
    // stacks (SecretsStack rotation, AppStack ECS task definition).
    // ------------------------------------------------------------------
    new CfnOutput(this, "AuroraClusterArn", {
      value: this.auroraCluster.clusterArn,
      description: "SPS Aurora cluster ARN",
    });
    new CfnOutput(this, "AuroraClusterEndpoint", {
      value: this.auroraCluster.clusterEndpoint.hostname,
      description: "SPS Aurora writer endpoint hostname",
    });
    new CfnOutput(this, "AuroraReaderEndpoint", {
      value: this.auroraCluster.clusterReadEndpoint.hostname,
      description: "SPS Aurora reader endpoint hostname",
    });
    new CfnOutput(this, "AuroraMasterSecretArn", {
      value: this.auroraMasterSecret.secretArn,
      description: "SPS Aurora master Secrets Manager secret ARN",
    });
    new CfnOutput(this, "OpenSearchDomainEndpoint", {
      value: this.opensearchDomain.domainEndpoint,
      description: "SPS OpenSearch domain endpoint",
      // Named export so AppStack + EtlStack can Fn::ImportValue it into
      // OPENSEARCH_NODE without coupling to DataStack as a constructor prop
      // (mirrors AppStack's InternalAlbSecurityGroupId export pattern). #447
      exportName: `Sps-Data-${envConfig.envName}-OpenSearchDomainEndpoint`,
    });
    new CfnOutput(this, "OpenSearchDomainArn", {
      value: this.opensearchDomain.domainArn,
      description: "SPS OpenSearch domain ARN",
    });
    new CfnOutput(this, "BackupPlanArn", {
      value: backupPlan.backupPlanArn,
      description: "SPS AWS Backup plan ARN (B10)",
    });
    new CfnOutput(this, "BackupVaultArn", {
      value: sourceVault.backupVaultArn,
      description: "SPS AWS Backup source vault ARN (primary region)",
    });
  }
}
