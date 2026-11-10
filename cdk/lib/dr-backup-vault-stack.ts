import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as backup from "aws-cdk-lib/aws-backup";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link DrBackupVaultStack}. */
export interface DrBackupVaultStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
}

/**
 * DrBackupVaultStack — the disaster-recovery {@link backup.BackupVault} in the
 * DR region (ADR-008: `us-west-2`).
 *
 * Owns nothing else: the AWS Backup *plan* and *selection* live in
 * {@link import("./data-stack").DataStack} in the primary region. That plan
 * has a `copyAction` targeting this vault — the cross-region wiring that
 * closes B10's "cross-region snapshot copy to a documented secondary region."
 *
 * The vault is deletion-protected and `RemovalPolicy.RETAIN` — destroying the
 * stack does not delete the vault or its recovery points.
 */
export class DrBackupVaultStack extends Stack {
  /** The DR BackupVault, exported for cross-region reference from DataStack. */
  public readonly vault: backup.BackupVault;

  constructor(scope: Construct, id: string, props: DrBackupVaultStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // BackupVault encrypted with an AWS-managed KMS key. The cross-region
    // copyAction in DataStack's BackupPlan writes recovery points here. The
    // vault is retained on stack delete (ADR-008's deletion-protection rule
    // for stateful resources).
    this.vault = new backup.BackupVault(this, "DrBackupVault", {
      backupVaultName: `sps-dr-backup-vault-${envConfig.envName}`,
      removalPolicy: RemovalPolicy.RETAIN,
      // Vault Lock, GOVERNANCE mode -- same rationale as the source vault in
      // DataStack: no early deletion of DR copies short of an admin first
      // removing the lock.
      lockConfiguration: {
        minRetention: Duration.days(envConfig.awsBackupRetentionDays),
      },
    });

    // DR replica of the curated-tables backup bucket (EtlStack's
    // CurationBackupBucket replicates here). Fixed name so EtlStack can target
    // it without a cross-region reference: see drCurationBackupBucketName().
    new s3.Bucket(this, "DrCurationBackupBucket", {
      bucketName: drCurationBackupBucketName(envConfig.envName),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: "expire-noncurrent-versions", noncurrentVersionExpiration: Duration.days(90) },
      ],
    });

    new CfnOutput(this, "DrBackupVaultArn", {
      value: this.vault.backupVaultArn,
      description: `SPS DR BackupVault ARN (${envConfig.drRegion})`,
    });
    new CfnOutput(this, "DrBackupVaultName", {
      value: this.vault.backupVaultName,
      description: `SPS DR BackupVault name (${envConfig.drRegion})`,
    });
  }
}

/**
 * Name of the DR-region (us-west-2) replica of the curated-tables backup bucket.
 * Account-qualified for global uniqueness; resolves via the AWS::AccountId
 * pseudo-parameter so the env-agnostic synth still works.
 */
export function drCurationBackupBucketName(envName: string): string {
  return `sps-curation-backups-dr-${envName}-${Aws.ACCOUNT_ID}`;
}
