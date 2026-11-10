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
3. **Resolve the live source cluster and its network/parameter settings.** Never hardcode these: the
   cluster was rebuilt from a snapshot (new id, new SG/subnet group) and the 2026-05 values in this
   file went stale. The restore must reuse the cluster's **custom parameter group** — it carries
   `require_secure_transport=ON`; `default.aurora-mysql8.0` would silently restore a plaintext-accepting DB.
   ```bash
   SRC=$(aws rds describe-db-clusters --query "DBClusters[?starts_with(DBClusterIdentifier,'sps-data-staging-auroracluster')].DBClusterIdentifier | [0]" --output text)
   read SG SUBNETS PARAMS MAXACU <<<"$(aws rds describe-db-clusters --db-cluster-identifier "$SRC" \
     --query 'DBClusters[0].[VpcSecurityGroups[0].VpcSecurityGroupId,DBSubnetGroup,DBClusterParameterGroup,ServerlessV2ScalingConfiguration.MaxCapacity]' --output text)"
   aws rds describe-db-clusters --db-cluster-identifier "$SRC" \
     --query "DBClusters[0].{Engine:EngineVersion,Earliest:EarliestRestorableTime,Latest:LatestRestorableTime,Retention:BackupRetentionPeriod}"
   ```
4. **No in-flight clusters using the drill identifier:**
   ```bash
   aws rds describe-db-clusters \
     --query "DBClusters[?contains(DBClusterIdentifier, 'staging-drill')].DBClusterIdentifier"
   ```
   Expect empty. If non-empty, finish or delete the leftover before starting.

Record the recovery point ARN, the `LatestRestorableTime`, and the chosen drill timestamp in the Drills log at the bottom of this file.

## Source-cluster reference values

Resolved live in pre-flight step 3 (`$SRC`, `$SG`, `$SUBNETS`, `$PARAMS`, `$MAXACU`). As of 2026-11-09:
engine `aurora-mysql 8.0.mysql_aurora.3.10.5`, Serverless v2 0.5–4.0 ACU, port 3306, storage encrypted
(KMS), custom cluster parameter group (TLS required), deletion protection on.

## Variant A — PITR restore (preferred, ≈ 20–40 min)

PITR is the default drill path: it exercises the continuous-backup window without depending on the AWS Backup vault state. Use this every quarter.

```bash
STAMP=$(date -u +%Y%m%d-%H%M)
DRILL_ID=sps-data-staging-drill-$STAMP

# 1. Create the cluster (~5-10 min to reach `available`)
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier "$SRC" \
  --db-cluster-identifier "$DRILL_ID" \
  --use-latest-restorable-time \
  --vpc-security-group-ids "$SG" \
  --db-subnet-group-name "$SUBNETS" \
  --db-cluster-parameter-group-name "$PARAMS" \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=$MAXACU \
  --engine-mode provisioned --no-deletion-protection \
  --tags Key=purpose,Value=dr-drill

# 2. Wait for the cluster (poll every 60s)
until [ "$(aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" --query 'DBClusters[0].Status' --output text)" = "available" ]; do
  sleep 60
done

# 3. Add a writer instance (~10-15 min to reach `available`)
aws rds create-db-instance \
  --db-instance-identifier "$DRILL_ID-1" \
  --db-cluster-identifier "$DRILL_ID" \
  --db-instance-class db.serverless \
  --engine aurora-mysql --no-publicly-accessible

# 4. Wait for the instance
until [ "$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" --query 'DBInstances[0].DBInstanceStatus' --output text)" = "available" ]; do
  sleep 60
done
```

When step 4 returns, the cluster is restored and reachable from inside the VPC. Move to Validation.

## Variant B — Cross-region restore from the DR vault (≈ 15–30 min)

Used when (a) PITR is unavailable (corrupted continuous-backup state, source cluster lost), (b) `us-east-1` is
unavailable, or (c) we're explicitly drilling cross-region recovery. The restore creates the new cluster in `us-west-2`
from the daily copy in `sps-dr-backup-vault-<env>`.

**`us-west-2` has no SPS network** (only the account's default VPC) and no SPS KMS key, so two things from the
recovery point's stored metadata must be overridden: the subnet group / SG (stored values are `us-east-1`
resources) and the KMS key (use the key the DR copy is encrypted with). For a drill, a temporary DB subnet group in
the default VPC is enough. In a real regional recovery, stand up the network first (see
[`OPERATIONS-RUNBOOK.md`](./OPERATIONS-RUNBOOK.md) § Failover guide) and restore into it.

```bash
ENV=staging
STAMP=$(date -u +%Y%m%d-%H%M)
DRILL_ID=sps-data-$ENV-dr-drill-$STAMP
VAULT=sps-dr-backup-vault-$ENV
RP=$(aws backup list-recovery-points-by-backup-vault --region us-west-2 --backup-vault-name $VAULT \
  --query 'sort_by(RecoveryPoints,&CreationDate)[-1].RecoveryPointArn' --output text)
KMS=$(aws backup describe-recovery-point --region us-west-2 --backup-vault-name $VAULT \
  --recovery-point-arn "$RP" --query EncryptionKeyArn --output text)
ENGINE=$(aws backup get-recovery-point-restore-metadata --region us-west-2 --backup-vault-name $VAULT \
  --recovery-point-arn "$RP" --query RestoreMetadata.EngineVersion --output text)

# Drill only: temporary subnet group in the default VPC (delete in Cleanup).
VPC=$(aws ec2 describe-vpcs --region us-west-2 --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --region us-west-2 --filters Name=vpc-id,Values=$VPC --query 'Subnets[].SubnetId' --output text)
DSG=$(aws ec2 describe-security-groups --region us-west-2 --filters Name=vpc-id,Values=$VPC Name=group-name,Values=default --query 'SecurityGroups[0].GroupId' --output text)
aws rds create-db-subnet-group --region us-west-2 --db-subnet-group-name sps-dr-drill-tmp \
  --db-subnet-group-description "temporary DR drill subnet group (delete after drill)" --subnet-ids $SUBNETS

META=$(python3 -c "import json;print(json.dumps({'DBClusterIdentifier':'$DRILL_ID','DBSubnetGroupName':'sps-dr-drill-tmp',
  'VpcSecurityGroupIds':json.dumps(['$DSG']),'Engine':'aurora-mysql','EngineMode':'provisioned','EngineVersion':'$ENGINE',
  'DatabaseName':'scholars','Port':'3306','KmsKeyId':'$KMS','CopyTagsToSnapshot':'true',
  'EnableIAMDatabaseAuthentication':'false','EnableCloudwatchLogsExports':'[]'}))")
JOB=$(aws backup start-restore-job --region us-west-2 --recovery-point-arn "$RP" --resource-type Aurora \
  --iam-role-arn arn:aws:iam::665083158573:role/service-role/AWSBackupDefaultServiceRole \
  --metadata "$META" --query RestoreJobId --output text)
until [ "$(aws backup describe-restore-job --region us-west-2 --restore-job-id $JOB --query Status --output text)" = COMPLETED ]; do sleep 60; done

# AWS Backup restores the cluster only; add a writer so the engine actually mounts the volume.
aws rds create-db-instance --region us-west-2 --db-instance-identifier "$DRILL_ID-1" --db-cluster-identifier "$DRILL_ID" \
  --db-instance-class db.serverless --engine aurora-mysql --no-publicly-accessible
aws rds wait db-instance-available --region us-west-2 --db-instance-identifier "$DRILL_ID-1"
```

The restored cluster carries no Serverless v2 scaling config and the default parameter group; in a real recovery set
both (`modify-db-cluster --serverless-v2-scaling-configuration … --db-cluster-parameter-group-name …`) before the app
connects. Data-side validation needs compute inside `us-west-2` (none exists today), so a drill records it as deferred.

**Cleanup (Variant B, all `--region us-west-2`):** `delete-db-instance --skip-final-snapshot` → wait → `delete-db-cluster
--skip-final-snapshot` → wait → `delete-db-subnet-group --db-subnet-group-name sps-dr-drill-tmp`.

## Validation (≈ 5 min)

The validation step has two halves: AWS-side (the cluster came up healthy) and data-side (the schema and rows match the source). Run both; AWS-side is the hard pass criterion, data-side is the soft one.

### AWS-side (operator outside the VPC: always run)

```bash
aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" \
  --query "DBClusters[0].{Status:Status,Members:DBClusterMembers,Engine:EngineVersion}"
aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" \
  --query "DBInstances[0].{Status:DBInstanceStatus,AZ:AvailabilityZone}"
```

Expect `Status=available`, one member, `EngineVersion` equal to the source cluster's, instance status `available`.

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
| 2026-11-09 23:39 | PITR (A) | Paul Albert | 17 min to validated | **Pass** | Restored, then every table counted live vs restore in-VPC: 127/127 tables, 1,753,055 rows identical except `etl_run` (+12 live rows written after the restore point). TLS enforcement carried over. |
| 2026-11-09 23:40 | DR vault, us-west-2 (B) | Paul Albert | 12 min to running writer | Pass (AWS-side) | First cross-region drill. Restored the 11-09 daily copy into `us-west-2`, writer `available`. Data-side deferred: no compute in `us-west-2`. |

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

### 2026-11-09 drills — detail

Run back-to-back on staging the evening before the public launch (CAB approved).

**Variant A (PITR, us-east-1)**

| Step | Time (UTC) | Elapsed |
|---|---|---|
| `restore-db-cluster-to-point-in-time` issued (custom TLS parameter group) | 23:39:36 | 0 |
| Cluster `available`; writer requested | 23:44:26 | 4 m 50 s |
| Writer `available` | 23:51:40 | 12 m 04 s |
| In-VPC row-count comparison (`run-staging-probe.sh`, SELECT-only user) | ~23:56 | ~17 m |

Result: `version=8.0.42`, `require_secure_transport=1` on both; 127 tables on both; only `etl_run` differed
(live 58,869 vs restore 58,857, written after the restore point). `scholar` 11,331, `publication` 202,691, `grant` 14,134
identical.

**Variant B (DR vault → us-west-2)**

| Step | Time (UTC) | Elapsed |
|---|---|---|
| `start-restore-job` issued against the 2026-11-09 05:00 UTC copy | 23:40:08 | 0 |
| Restore job `COMPLETED`, cluster `available` | 23:44:32 | 4 m 24 s |
| Writer requested | 23:47:38 | 7 m 30 s |
| Writer `available` (us-west-2c, 3.10.5) | 23:51:58 | 11 m 50 s |

Findings: the stored restore metadata points at `us-east-1` subnet group/SG/KMS and must be overridden (now in the
procedure above); `us-west-2` has no SPS network or compute, so data-side validation and an app rebuild there are
not yet possible. Both drill clusters and the temporary subnet group were deleted after the run.
