# Restore-drill runbook

This is the operator reference for verifying that the SPS Aurora cluster can actually be restored from backup. It pairs with [`docs/PRODUCTION.md`](./PRODUCTION.md) (RPO/RTO targets) and `cdk/lib/data-stack.ts` + `cdk/lib/dr-backup-vault-stack.ts` (the backup plan that produces the recovery points this runbook consumes).

Closes [#414](https://github.com/wcmc-its/Scholars-Profile-System/issues/414) (B10 follow-up; AC6 of [#109](https://github.com/wcmc-its/Scholars-Profile-System/issues/109)).

## When to run

- **Quarterly.** First Tuesday of each calendar quarter, as part of the on-call rotation.
- **On change.** Any time `data-stack.ts`, `dr-backup-vault-stack.ts`, the backup plan rule, or the engine version changes.
- **On incident.** During a real data-loss event — but in that case Variant A below IS the recovery, not a drill.

The drill is always staging-only. Production never gets a deliberate test-restore; we trust the staging drill to certify the mechanism, and we run the same commands against prod only in a real recovery.

## Targets

- **RPO ≤ 24 h.** Daily AWS Backup plan + 5-minute PITR window; in normal operation we are well under this. Documented in `docs/PRODUCTION.md`.
- **RTO ≤ 4 h.** End-to-end wall-clock from the decision to restore to a fully-validated cluster. This runbook's pass criterion.

## Pre-flight (≈ 5 min)

Run from a shell with the SPS AWS credentials loaded (same env vars as `cdk deploy`).

1. **Most recent recovery point in staging vault** (us-east-1):
   ```bash
   aws backup list-recovery-points-by-backup-vault \
     --backup-vault-name sps-backup-vault-staging \
     --query "RecoveryPoints | sort_by(@, &CreationDate) | [-1].{Arn:RecoveryPointArn,Created:CreationDate,Size:BackupSizeInBytes,Status:Status}" \
     --output json
   ```
2. **DR-region copy** (us-west-2) — verify it exists, do not restore from it for the routine drill:
   ```bash
   aws backup list-recovery-points-by-backup-vault \
     --region us-west-2 \
     --backup-vault-name sps-dr-backup-vault-staging \
     --query "RecoveryPoints | sort_by(@, &CreationDate) | [-1].{Arn:RecoveryPointArn,Created:CreationDate,Size:BackupSizeInBytes}" \
     --output json
   ```
3. **PITR window on the source cluster:**
   ```bash
   aws rds describe-db-clusters \
     --db-cluster-identifier sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc \
     --query "DBClusters[0].{Earliest:EarliestRestorableTime,Latest:LatestRestorableTime,Retention:BackupRetentionPeriod}"
   ```
4. **No in-flight clusters using the drill identifier:**
   ```bash
   aws rds describe-db-clusters \
     --query "DBClusters[?contains(DBClusterIdentifier, 'staging-drill')].DBClusterIdentifier"
   ```
   Expect empty. If non-empty, finish or delete the leftover before starting.

Record the recovery point ARN, the `LatestRestorableTime`, and the chosen drill timestamp in the Drills log at the bottom of this file.

## Source-cluster reference values

These are the live staging values the drill clones. Update this block if `data-stack.ts` changes.

| Property | Value |
|---|---|
| Cluster identifier | `sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc` |
| Engine | `aurora-mysql 8.0.mysql_aurora.3.08.0` |
| Capacity | Aurora Serverless v2, min 0.5 ACU / max 2.0 ACU |
| Port | 3306 |
| Subnet group | `sps-data-staging-auroraclustersubnetsf3e9e6ad-lmvnlruhpwwx` |
| Security group | `sg-04c629b488189a170` |
| KMS key | `arn:aws:kms:us-east-1:665083158573:key/6e13ff78-189a-4e71-a4c2-348de32d2edb` |
| Cluster param group | `default.aurora-mysql8.0` |
| Storage encrypted | true |

## Variant A — PITR restore (preferred, ≈ 20–40 min)

PITR is the default drill path: it exercises the continuous-backup window without depending on the AWS Backup vault state. Use this every quarter.

```bash
STAMP=$(date -u +%Y%m%d-%H%M)
DRILL_ID=sps-data-staging-drill-$STAMP

# 1. Create the cluster (~5-10 min to reach `available`)
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc \
  --db-cluster-identifier "$DRILL_ID" \
  --use-latest-restorable-time \
  --vpc-security-group-ids sg-04c629b488189a170 \
  --db-subnet-group-name sps-data-staging-auroraclustersubnetsf3e9e6ad-lmvnlruhpwwx \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=2.0 \
  --engine-mode provisioned

# 2. Wait for the cluster (poll every 60s)
until [ "$(aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" --query 'DBClusters[0].Status' --output text)" = "available" ]; do
  sleep 60
done

# 3. Add a writer instance (~10-15 min to reach `available`)
aws rds create-db-instance \
  --db-instance-identifier "$DRILL_ID-1" \
  --db-cluster-identifier "$DRILL_ID" \
  --db-instance-class db.serverless \
  --engine aurora-mysql

# 4. Wait for the instance
until [ "$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" --query 'DBInstances[0].DBInstanceStatus' --output text)" = "available" ]; do
  sleep 60
done
```

When step 4 returns, the cluster is restored and reachable from inside the VPC. Move to Validation.

## Variant B — Snapshot restore from DR vault (≈ 30–60 min)

Used when (a) PITR is unavailable (corrupted continuous-backup state, source cluster lost), or (b) we're explicitly drilling cross-region recovery. The DR-region restore creates the new cluster in `us-west-2`.

```bash
DR_RP_ARN=<from pre-flight step 2>
RESTORE_ROLE_ARN=arn:aws:iam::665083158573:role/<AWSBackupDefaultServiceRole or sps-restore-role>
STAMP=$(date -u +%Y%m%d-%H%M)
DRILL_ID=sps-data-staging-dr-drill-$STAMP

aws backup start-restore-job \
  --region us-west-2 \
  --recovery-point-arn "$DR_RP_ARN" \
  --iam-role-arn "$RESTORE_ROLE_ARN" \
  --resource-type RDS \
  --metadata "DBClusterIdentifier=$DRILL_ID,VpcSecurityGroupIds=<dr-region-sg>,DBSubnetGroupName=<dr-region-subnet-group>"

# Poll the restore job
JOB_ID=<from start-restore-job response>
until [ "$(aws backup describe-restore-job --region us-west-2 --restore-job-id "$JOB_ID" --query Status --output text)" = "COMPLETED" ]; do
  sleep 60
done
```

Variant B requires the DR-region subnet group, SG, and the AWS Backup restore IAM role to exist in `us-west-2`. If any are missing, that itself is a finding — log it and stop.

## Validation (≈ 5 min)

The validation step has two halves: AWS-side (the cluster came up healthy) and data-side (the schema and rows match the source). Run both; AWS-side is the hard pass criterion, data-side is the soft one.

### AWS-side (operator outside the VPC: always run)

```bash
aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" \
  --query "DBClusters[0].{Status:Status,Members:DBClusterMembers,Engine:EngineVersion}"
aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" \
  --query "DBInstances[0].{Status:DBInstanceStatus,AZ:AvailabilityZone}"
```

Expect `Status=available`, one member, `EngineVersion=8.0.mysql_aurora.3.08.0`, instance status `available`.

### Data-side (operator inside the VPC: run when feasible)

From a bastion or VPC-reachable host with `mysql` client and the cluster master credentials (Secrets Manager: `scholars/staging/aurora/master`):

```sql
SELECT VERSION();
SHOW DATABASES;
USE scholars;
SHOW TABLES;
SELECT COUNT(*) FROM Person;
SELECT COUNT(*) FROM Publication;
SELECT * FROM etl_run ORDER BY started_at DESC LIMIT 5;
```

Compare each count to the same query against the live cluster; deltas should be 0 (or, for tables that wrote between the snapshot point and the live query, off by a small known amount).

**Empty-cluster caveat (current state, 2026-05-21).** The staging cluster has no data loaded yet. Until the first ETL completes, the data-side validation collapses to "tables exist with row counts matching the source (probably 0 across the board)." Rerun this drill within 1 week of the first production-grade data load; that is the run that actually exercises restore-correctness.

**Outside-VPC operator.** If the operator is running from a non-VPC shell (e.g., laptop), record the data-side as "deferred — operator outside VPC" and log the AWS-side as the only validation. The drill still passes if AWS-side is green and the data-side is deferred for a known reason.

## Cleanup (≈ 5 min)

Skipping cleanup is the #1 way drills become #415-style zombies. Cleanup is mandatory.

```bash
# Instance first
aws rds delete-db-instance --db-instance-identifier "$DRILL_ID-1" --skip-final-snapshot
until ! aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" >/dev/null 2>&1; do
  sleep 30
done

# Then the cluster
aws rds delete-db-cluster --db-cluster-identifier "$DRILL_ID" --skip-final-snapshot

# Verify only the live staging cluster remains
aws rds describe-db-clusters \
  --query "DBClusters[?contains(DBClusterIdentifier, 'staging')].{Id:DBClusterIdentifier,Status:Status,Members:length(DBClusterMembers)}" \
  --output table
```

The restored cluster inherits deletion-protection from the source if it's set — if `delete-db-cluster` errors with `InvalidParameterCombination: Cannot delete protected DB Cluster`, run `aws rds modify-db-cluster --db-cluster-identifier "$DRILL_ID" --no-deletion-protection --apply-immediately` first.

Automated backups (`rds:automated:…`) generated during the drill are deleted with the cluster when `--skip-final-snapshot` is set. AWS Backup vault recovery points (`awsbackup:…`) are NOT created during a PITR drill, so the vault is unaffected.

## Pass / fail

| Outcome | Criterion |
|---|---|
| **Pass** | AWS-side validation green, cluster + instance reached `available`, cleanup completes without error, total wall-clock ≤ 4 h (RTO target). |
| **Soft pass** | AWS-side validation green, but data-side deferred (empty cluster or outside-VPC operator). Acceptable until the cluster has production-grade data; track in the Drills log. |
| **Fail** | Restore did not reach `available`, validation queries diverge from the source, or cleanup left orphaned resources. Open an issue, do NOT delete the failed cluster until cause is captured. |

## Drills

| Date (UTC) | Variant | Operator | Wall-clock | Outcome | Notes |
|---|---|---|---|---|---|
| 2026-05-21 14:23 | PITR | Paul Albert | 19 min | Soft pass | First drill. AWS-side green; data-side deferred (empty cluster + outside-VPC operator). RTO target ≤ 4 h: comfortably met. |

### 2026-05-21 14:23 UTC drill — detail

| Step | Time (UTC) | Elapsed | Result |
|---|---|---|---|
| `restore-db-cluster-to-point-in-time` issued | 14:23:31 | 0 | cluster status `creating` |
| Cluster status `available` | 14:27:36 | 4 m 05 s | poll-interval 60 s |
| `create-db-instance` issued | 14:27:54 | 4 m 23 s | instance status `creating` |
| Instance status `available` | 14:32:54 | 9 m 23 s | poll passed through `configuring-enhanced-monitoring` |
| AWS-side validation | 14:33:43 | 10 m 12 s | cluster status `available`, members=1, engine `8.0.mysql_aurora.3.08.0`; instance status `available`, class `db.serverless`, AZ `us-east-1a` |
| `delete-db-instance` issued | 14:33:57 | 10 m 26 s | instance status `deleting` |
| Instance fully deleted (`DBInstanceNotFound`) | ~14:42:12 | 18 m 41 s | poll-interval 30 s |
| `delete-db-cluster` issued | 14:42:24 | 18 m 53 s | cluster transitioned to `deleting`; only the live cluster remains in `available` |

**Restore identifier:** `sps-data-staging-drill-20260521-1418` (cluster) + `…-1` (instance).
**Source PITR window at restore time:** Earliest 2026-05-20 17:10 UTC, Latest 2026-05-21 14:16 UTC. Used `--use-latest-restorable-time`.
**Outcome:** Soft pass. Mechanism verified end-to-end. Data-side validation deferred until the staging cluster carries non-empty data — rerun this drill within 1 week of the first production-grade data load to convert the soft pass to a hard pass.
