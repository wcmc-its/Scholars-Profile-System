import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
