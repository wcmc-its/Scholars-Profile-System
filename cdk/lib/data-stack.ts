import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as backup from "aws-cdk-lib/aws-backup";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as opensearchservice from "aws-cdk-lib/aws-opensearchservice";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
  /** IAM role that is the OpenSearch fine-grained access control master user. */
  public readonly opensearchMasterRole: iam.Role;

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
    // OpenSearch domain.
    //
    // Fine-grained access control with an IAM master (no secret-managed
    // master user — the chosen pattern per Phase 1 sign-off). The role's
    // trust policy admits the account root; the account holder assumes it
    // to administer roles/users via the `_security` API after deploy.
    //
    // Multi-AZ-without-standby for prod (two AZs match NetworkStack);
    // single-AZ for staging. Encryption at rest + node-to-node + HTTPS-only.
    // ------------------------------------------------------------------
    this.opensearchMasterRole = new iam.Role(this, "OpensearchMasterRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      roleName: `sps-opensearch-master-${envConfig.envName}`,
      description: `SPS OpenSearch fine-grained access control master (${envConfig.envName}). Assume from a workstation to administer the domain.`,
    });

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
      fineGrainedAccessControl: {
        masterUserArn: this.opensearchMasterRole.roleArn,
      },
      enableAutoSoftwareUpdate: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

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
    });
    new CfnOutput(this, "OpenSearchDomainArn", {
      value: this.opensearchDomain.domainArn,
      description: "SPS OpenSearch domain ARN",
    });
    new CfnOutput(this, "OpenSearchMasterRoleArn", {
      value: this.opensearchMasterRole.roleArn,
      description: "SPS OpenSearch FGAC master role ARN — assume to administer",
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
