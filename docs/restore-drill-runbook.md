# SPS Database Restore Runbook

Restore drills and real recoveries for the Aurora database · Scholars Profile System

| | | | |
|---|---|---|---|
| **Last updated** | **2026-11-09** | **Version** | 2.0 |
| **Owner** | Paul Albert, SPS service owner (paa2013@med.cornell.edu) | **Last drill** | 2026-11-09: Variant A **Pass** (17 min); Variant B **Pass** AWS-side (12 min) |
| **Audience** | On-call staff running the quarterly drill, or anyone recovering from data loss | **Next drill due** | 2027-01-05 (first Tuesday of the quarter) |

| **Data you could lose (RPO)** | **Time to recover (RTO)** | **Where drills run** | **Pass mark** |
|---|---|---|---|
| 24 hours or less (daily backups plus 5-minute point-in-time recovery) | 4 hours or less, from the decision to restore to a validated database | Staging only. Prod is never test-restored; its commands are used only in a real recovery | Database reaches available, checks pass, cleanup leaves nothing behind, all within 4 hours |

> [!WARNING]
> **Real data loss right now?**
>
> Read [Real recovery: what changes](#real-recovery-what-changes) first, then use Variant A (or Variant B if us-east-1 or point-in-time recovery is unavailable). **Do not run the cleanup step.**

**Contents**

- [When to run](#when-to-run)
- [Choose a variant](#choose-a-variant)
- [Step 1. Pre-flight checks](#step-1-pre-flight-checks-about-5-minutes)
- [Step 2A. Variant A: point-in-time restore](#step-2a-variant-a-point-in-time-restore-about-20-to-40-minutes)
- [Step 2B. Variant B: restore from the DR vault in us-west-2](#step-2b-variant-b-restore-from-the-dr-vault-in-us-west-2-about-15-to-30-minutes)
- [Step 3. Validate](#step-3-validate-about-5-minutes)
- [Step 4. Clean up](#step-4-clean-up-drills-only-about-5-minutes)
- [Step 5. Record the result](#step-5-record-the-result)
- [Real recovery: what changes](#real-recovery-what-changes)
- [Drill log](#drill-log)
- [Revision history](#revision-history)

## When to run

| **Trigger** | **Details** |
|---|---|
| **Every quarter** | First Tuesday of each calendar quarter, as part of the on-call rotation |
| **After a change** | Whenever [`cdk/lib/data-stack.ts`](../cdk/lib/data-stack.ts), [`cdk/lib/dr-backup-vault-stack.ts`](../cdk/lib/dr-backup-vault-stack.ts), the backup plan rule or the database engine version changes |
| **During an incident** | In a real data-loss event the same steps are the recovery, not a drill. See [Real recovery](#real-recovery-what-changes) |

**Between drills, two protections run on their own.** A backup-failure alert: any AWS Backup or cross-region copy job for the cluster that fails, aborts or expires posts a P2 card to Teams (rule `sps-aws-backup-failure-<env>`, topic `etl-failures-<env>`). And Vault Lock on both backup vaults (governance mode): recovery points can't be deleted before 35 days in prod or 14 in staging unless someone deliberately removes the lock.

## Choose a variant

| | **A. Point-in-time restore (PITR)** | **B. DR vault restore** |
|---|---|---|
| **Use for** | The routine quarterly drill, and most real recoveries | Point-in-time recovery is unavailable, us-east-1 is down, or you are deliberately drilling cross-region recovery |
| **Restores from** | Aurora's continuous backup: any moment in the last 14 days | The daily copy in `sps-dr-backup-vault-<env>` |
| **Region** | us-east-1, into the existing SPS network | us-west-2, which has **no SPS network or compute** yet |
| **Time** | About 20 to 40 minutes | About 15 to 30 minutes |
| **Data check possible?** | Yes, from inside the VPC | Not yet: nothing in us-west-2 can reach the database |

Overall flow: **pre-flight** → **restore (A or B)** → **validate** → **clean up** (drills only) → **record**.

## Step 1. Pre-flight checks (about 5 minutes)

Use a shell with the SPS AWS credentials loaded (the same ones you use for `cdk deploy`).

1. Find the newest recovery point in the staging vault (us-east-1):

   ```bash
   aws backup list-recovery-points-by-backup-vault \
     --backup-vault-name sps-backup-vault-staging \
     --query "RecoveryPoints | sort_by(@, &CreationDate) | [-1].{Arn:RecoveryPointArn,Created:CreationDate,Size:BackupSizeInBytes,Status:Status}" \
     --output json
   ```

2. Confirm the cross-region copy exists in us-west-2. For the routine drill, only check it; don't restore from it:

   ```bash
   aws backup list-recovery-points-by-backup-vault --region us-west-2 \
     --backup-vault-name sps-dr-backup-vault-staging \
     --query "RecoveryPoints | sort_by(@, &CreationDate) | [-1].{Arn:RecoveryPointArn,Created:CreationDate,Size:BackupSizeInBytes}" \
     --output json
   ```

3. Look up the live source cluster and its network and parameter settings. **Never hardcode these:** the cluster was rebuilt from a snapshot (new ID, new security group and subnet group), and hardcoded values go stale.

   ```bash
   SRC=$(aws rds describe-db-clusters \
     --query "DBClusters[?starts_with(DBClusterIdentifier,'sps-data-staging-auroracluster')].DBClusterIdentifier | [0]" \
     --output text)
   read SG SUBNETS PARAMS MAXACU <<<"$(aws rds describe-db-clusters --db-cluster-identifier "$SRC" \
     --query 'DBClusters[0].[VpcSecurityGroups[0].VpcSecurityGroupId,DBSubnetGroup,DBClusterParameterGroup,ServerlessV2ScalingConfiguration.MaxCapacity]' \
     --output text)"
   aws rds describe-db-clusters --db-cluster-identifier "$SRC" \
     --query "DBClusters[0].{Engine:EngineVersion,Earliest:EarliestRestorableTime,Latest:LatestRestorableTime,Retention:BackupRetentionPeriod}"
   ```

4. Make sure no leftover drill cluster exists. Expect an empty list; if not, finish or delete the leftover first:

   ```bash
   aws rds describe-db-clusters \
     --query "DBClusters[?contains(DBClusterIdentifier, 'staging-drill')].DBClusterIdentifier"
   ```

5. Write down the recovery point ARN, the `LatestRestorableTime` and your drill start time for the [log](#drill-log).

> [!IMPORTANT]
> **The restore must use the cluster's custom parameter group**
>
> It carries `require_secure_transport=ON`. Restoring with `default.aurora-mysql8.0` silently produces a database that accepts unencrypted connections. That is why `$PARAMS` is passed below.

For reference, as of 2026-11-09 the staging source is engine `aurora-mysql 8.0.mysql_aurora.3.10.5`, Serverless v2 0.5 to 4.0 ACU, port 3306, encrypted with KMS, TLS required, deletion protection on.

## Step 2A. Variant A: point-in-time restore (about 20 to 40 minutes)

The default drill. It tests the continuous-backup window without relying on the AWS Backup vault.

1. Name the drill cluster:

   ```bash
   STAMP=$(date -u +%Y%m%d-%H%M)
   DRILL_ID=sps-data-staging-drill-$STAMP
   ```

2. Create the cluster (about 5 to 10 minutes to become available):

   ```bash
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
   ```

3. Wait until the cluster is available:

   ```bash
   until [ "$(aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" \
     --query 'DBClusters[0].Status' --output text)" = "available" ]; do sleep 60; done
   ```

4. Add a writer instance (about 10 to 15 minutes). The cluster has no compute until you do:

   ```bash
   aws rds create-db-instance \
     --db-instance-identifier "$DRILL_ID-1" \
     --db-cluster-identifier "$DRILL_ID" \
     --db-instance-class db.serverless \
     --engine aurora-mysql --no-publicly-accessible
   ```

5. Wait until the instance is available:

   ```bash
   aws rds wait db-instance-available --db-instance-identifier "$DRILL_ID-1"
   ```

The restored database is now reachable from inside the VPC. Go to [Step 3](#step-3-validate-about-5-minutes).

## Step 2B. Variant B: restore from the DR vault in us-west-2 (about 15 to 30 minutes)

> [!NOTE]
> **Why this variant needs extra settings**
>
> us-west-2 has no SPS network (only the account's default VPC) and no SPS encryption key. The recovery point remembers us-east-1 subnet, security group and key settings, so all three must be overridden. For a drill, a temporary subnet group in the default VPC is enough. In a real regional recovery, build the network first (Operations Runbook, Playbook 19) and restore into it.

1. Set the names:

   ```bash
   ENV=staging
   STAMP=$(date -u +%Y%m%d-%H%M)
   DRILL_ID=sps-data-$ENV-dr-drill-$STAMP
   VAULT=sps-dr-backup-vault-$ENV
   ```

2. Find the newest recovery point, its encryption key and engine version:

   ```bash
   RP=$(aws backup list-recovery-points-by-backup-vault --region us-west-2 --backup-vault-name $VAULT \
     --query 'sort_by(RecoveryPoints,&CreationDate)[-1].RecoveryPointArn' --output text)
   KMS=$(aws backup describe-recovery-point --region us-west-2 --backup-vault-name $VAULT \
     --recovery-point-arn "$RP" --query EncryptionKeyArn --output text)
   ENGINE=$(aws backup get-recovery-point-restore-metadata --region us-west-2 --backup-vault-name $VAULT \
     --recovery-point-arn "$RP" --query RestoreMetadata.EngineVersion --output text)
   ```

3. **Drill only:** create a temporary subnet group in the default VPC (deleted in cleanup):

   ```bash
   VPC=$(aws ec2 describe-vpcs --region us-west-2 --filters Name=isDefault,Values=true \
     --query 'Vpcs[0].VpcId' --output text)
   SUBNETS=$(aws ec2 describe-subnets --region us-west-2 --filters Name=vpc-id,Values=$VPC \
     --query 'Subnets[].SubnetId' --output text)
   DSG=$(aws ec2 describe-security-groups --region us-west-2 \
     --filters Name=vpc-id,Values=$VPC Name=group-name,Values=default \
     --query 'SecurityGroups[0].GroupId' --output text)
   aws rds create-db-subnet-group --region us-west-2 --db-subnet-group-name sps-dr-drill-tmp \
     --db-subnet-group-description "temporary DR drill subnet group (delete after drill)" \
     --subnet-ids $SUBNETS
   ```

4. Build the restore settings and start the restore job:

   ```bash
   META=$(python3 -c "import json;print(json.dumps({'DBClusterIdentifier':'$DRILL_ID','DBSubnetGroupName':'sps-dr-drill-tmp',
     'VpcSecurityGroupIds':json.dumps(['$DSG']),'Engine':'aurora-mysql','EngineMode':'provisioned','EngineVersion':'$ENGINE',
     'DatabaseName':'scholars','Port':'3306','KmsKeyId':'$KMS','CopyTagsToSnapshot':'true',
     'EnableIAMDatabaseAuthentication':'false','EnableCloudwatchLogsExports':'[]'}))")
   JOB=$(aws backup start-restore-job --region us-west-2 --recovery-point-arn "$RP" --resource-type Aurora \
     --iam-role-arn arn:aws:iam::665083158573:role/service-role/AWSBackupDefaultServiceRole \
     --metadata "$META" --query RestoreJobId --output text)
   ```

5. Wait for the job to complete:

   ```bash
   until [ "$(aws backup describe-restore-job --region us-west-2 --restore-job-id $JOB \
     --query Status --output text)" = COMPLETED ]; do sleep 60; done
   ```

6. AWS Backup restores the cluster only. Add a writer so the database actually starts:

   ```bash
   aws rds create-db-instance --region us-west-2 --db-instance-identifier "$DRILL_ID-1" \
     --db-cluster-identifier "$DRILL_ID" --db-instance-class db.serverless \
     --engine aurora-mysql --no-publicly-accessible
   aws rds wait db-instance-available --region us-west-2 --db-instance-identifier "$DRILL_ID-1"
   ```

> [!WARNING]
> **In a real recovery, fix two settings before the app connects**
>
> The restored cluster has no Serverless scaling settings and uses the default parameter group (so TLS isn't enforced). Set both with `aws rds modify-db-cluster --serverless-v2-scaling-configuration … --db-cluster-parameter-group-name …`.

## Step 3. Validate (about 5 minutes)

There are two halves. The AWS-side check is the hard pass criterion and always runs. The data check is the soft criterion and runs whenever you can reach the database from inside the VPC.

### AWS-side check (always)

```bash
aws rds describe-db-clusters --db-cluster-identifier "$DRILL_ID" \
  --query "DBClusters[0].{Status:Status,Members:DBClusterMembers,Engine:EngineVersion}"
aws rds describe-db-instances --db-instance-identifier "$DRILL_ID-1" \
  --query "DBInstances[0].{Status:DBInstanceStatus,AZ:AvailabilityZone}"
```

**Expect:** cluster status `available`, one member, the same engine version as the source, and instance status `available`. Add `--region us-west-2` for Variant B.

### Data check (from inside the VPC)

1. **Preferred:** run [`scripts/run-staging-probe.sh`](../scripts/run-staging-probe.sh) with the SELECT-only user against both the live cluster and the restore, and compare row counts for every table. This is how the 2026-11-09 drill compared all 127 tables.

2. **Alternative:** from a host inside the VPC with the `mysql` client and the master credentials (Secrets Manager `scholars/staging/db/master-its`, since the live cluster was restored from a snapshot):

   ```sql
   SELECT VERSION();
   SHOW VARIABLES LIKE 'require_secure_transport';
   USE scholars;
   SELECT COUNT(*) FROM scholar;
   SELECT COUNT(*) FROM publication;
   SELECT COUNT(*) FROM `grant`;
   SELECT * FROM etl_run ORDER BY started_at DESC LIMIT 5;
   ```

3. Run the same queries against the live cluster. Counts should match exactly, except tables written after the restore point (for example `etl_run`), which may differ by a small, explainable amount.

> [!TIP]
> **Can't reach the VPC?**
>
> If you're working from outside the VPC (for example a laptop), record the data check as "deferred: operator outside VPC". The drill is then a soft pass, which is acceptable if the reason is known and logged.

## Step 4. Clean up (drills only, about 5 minutes)

> [!WARNING]
> **Cleanup is mandatory after a drill, and forbidden after a real recovery**
>
> Leftover drill clusters keep costing money and confuse the next operator (see #415). After a **real** recovery, the restored cluster is your database: don't delete it.

### Variant A

1. Delete the instance and wait until it's gone:

   ```bash
   aws rds delete-db-instance --db-instance-identifier "$DRILL_ID-1" --skip-final-snapshot
   aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID-1"
   ```

2. Delete the cluster:

   ```bash
   aws rds delete-db-cluster --db-cluster-identifier "$DRILL_ID" --skip-final-snapshot
   ```

3. Confirm only the live staging cluster remains:

   ```bash
   aws rds describe-db-clusters \
     --query "DBClusters[?contains(DBClusterIdentifier, 'staging')].{Id:DBClusterIdentifier,Status:Status,Members:length(DBClusterMembers)}" \
     --output table
   ```

If deleting the cluster fails with `Cannot delete protected DB Cluster`, remove protection first: `aws rds modify-db-cluster --db-cluster-identifier "$DRILL_ID" --no-deletion-protection --apply-immediately`.

Automated backups made during the drill are deleted with the cluster. A point-in-time drill creates no AWS Backup vault recovery points, so the vault is unaffected.

### Variant B (add `--region us-west-2` to every command)

1. `aws rds delete-db-instance --db-instance-identifier "$DRILL_ID-1" --skip-final-snapshot`, then wait until it's deleted.
2. `aws rds delete-db-cluster --db-cluster-identifier "$DRILL_ID" --skip-final-snapshot`, then wait until it's deleted.
3. `aws rds delete-db-subnet-group --db-subnet-group-name sps-dr-drill-tmp`

## Step 5. Record the result

Add a row to the [Drill log](#drill-log) with the date, variant, operator, wall-clock time, outcome and anything you learned, and update **Last drill** and **Next drill due** in the table at the top of this page.

| **Outcome** | **Criterion** |
|---|---|
| **Pass** | AWS-side check green, cluster and instance reached available, data check matched, cleanup finished without errors, all within 4 hours |
| **Soft pass** | AWS-side check green, but the data check was deferred for a known reason (for example, no VPC access). Log the reason |
| **Fail** | The restore never reached available, the data check didn't match, or cleanup left resources behind. **Open an issue and don't delete the failed cluster until the cause is captured** |

## Real recovery: what changes

| **Drill** | **Real recovery** |
|---|---|
| Staging cluster (`sps-data-staging-auroracluster…`) | Prod cluster: use the prefix `sps-data-prod-auroracluster` in pre-flight step 3 |
| `--use-latest-restorable-time` | Usually `--restore-to-time <UTC timestamp>`: the last moment the data was known to be good |
| `--no-deletion-protection`, tag `purpose=dr-drill` | Keep deletion protection on; tag it as the recovery cluster |
| Clean up afterwards | **Don't.** The restored cluster replaces the damaged one |
| Ends at validation | Then switch the app to the restored cluster (see below) |

> [!IMPORTANT]
> **Switching the app to the restored cluster isn't documented yet**
>
> [`PRODUCTION.md`](./PRODUCTION.md) budgets about 15 minutes for this step within the 4-hour RTO, but there is no written procedure. The live clusters were themselves adopted from snapshots through `auroraSnapshotIdentifier` and `auroraClusterIdentifier` in [`cdk/lib/config.ts`](../cdk/lib/config.ts), so that is the likely route. Work it out with the service owner, then add it here.

Related: [`PRODUCTION.md`](./PRODUCTION.md) (RPO and RTO) · [`cdk/lib/data-stack.ts`](../cdk/lib/data-stack.ts) and [`cdk/lib/dr-backup-vault-stack.ts`](../cdk/lib/dr-backup-vault-stack.ts) (the backup plan) · [`OPERATIONS-RUNBOOK.md`](./OPERATIONS-RUNBOOK.md) (Playbooks 18 and 19) · [`curation-backup-runbook.md`](./curation-backup-runbook.md) (row-level backup of hand-curated tables) · issues #414, #109

## Drill log

| **Date (UTC)** | **Variant** | **Operator** | **Wall-clock** | **Outcome** | **Notes** |
|---|---|---|---|---|---|
| 2026-11-09 23:39 | A: PITR | Paul Albert | 17 min to validated | **Pass** | Every table counted live vs restore from inside the VPC: 127 of 127 tables and 1,753,055 rows identical except `etl_run` (12 rows written after the restore point). TLS enforcement carried over. |
| 2026-11-09 23:40 | B: DR vault, us-west-2 | Paul Albert | 12 min to running writer | **Pass** (AWS-side) | First cross-region drill. Restored the 11-09 daily copy. Data check deferred: no compute in us-west-2. |
| 2026-05-21 14:23 | A: PITR | Paul Albert | 19 min | Soft pass | First drill. AWS-side green; data check deferred (empty cluster, operator outside VPC). |

### 2026-11-09 drills: detail

Run back to back on staging the evening before the public launch (CAB approved).

#### Variant A (point-in-time, us-east-1)

| **Step** | **Time (UTC)** | **Elapsed** |
|---|---|---|
| `restore-db-cluster-to-point-in-time` issued (custom TLS parameter group) | 23:39:36 | 0 |
| Cluster available; writer requested | 23:44:26 | 4 m 50 s |
| Writer available | 23:51:40 | 12 m 04 s |
| Row-count comparison inside the VPC (`run-staging-probe.sh`, SELECT-only user) | about 23:56 | about 17 m |

Result: `version=8.0.42` and `require_secure_transport=1` on both; 127 tables on both; only `etl_run` differed (live 58,869 vs restore 58,857, written after the restore point). `scholar` 11,331, `publication` 202,691 and `grant` 14,134 identical.

#### Variant B (DR vault to us-west-2)

| **Step** | **Time (UTC)** | **Elapsed** |
|---|---|---|
| `start-restore-job` issued against the 2026-11-09 05:00 UTC copy | 23:40:08 | 0 |
| Restore job `COMPLETED`, cluster available | 23:44:32 | 4 m 24 s |
| Writer requested | 23:47:38 | 7 m 30 s |
| Writer available (us-west-2c, 3.10.5) | 23:51:58 | 11 m 50 s |

Findings: the stored restore settings point at us-east-1 subnet group, security group and key, and must be overridden (now part of Step 2B). us-west-2 has no SPS network or compute, so a data check and an app rebuild there aren't possible yet. Both drill clusters and the temporary subnet group were deleted afterwards.

### 2026-05-21 drill: detail

| **Step** | **Time (UTC)** | **Elapsed** |
|---|---|---|
| `restore-db-cluster-to-point-in-time` issued | 14:23:31 | 0 |
| Cluster available | 14:27:36 | 4 m 05 s |
| `create-db-instance` issued | 14:27:54 | 4 m 23 s |
| Instance available | 14:32:54 | 9 m 23 s |
| AWS-side check passed (engine `8.0.mysql_aurora.3.08.0`, `db.serverless`, us-east-1a) | 14:33:43 | 10 m 12 s |
| `delete-db-instance` issued | 14:33:57 | 10 m 26 s |
| Instance fully deleted | about 14:42:12 | 18 m 41 s |
| `delete-db-cluster` issued; only the live cluster remains | 14:42:24 | 18 m 53 s |

Restore ID `sps-data-staging-drill-20260521-1418`. Source window at restore time: 2026-05-20 17:10 to 2026-05-21 14:16 UTC. Soft pass: the mechanism worked end to end, but the staging cluster was still empty. Superseded by the 2026-11-09 full pass.

## Revision history

| **Version** | **Date** | **Changes** |
|---|---|---|
| 2.0 | 2026-11-09 | Rewritten as numbered steps with a variant chooser, pass marks, a real-recovery section and a dated drill schedule. Corrections:<br>• Data check uses current table names (`scholar`, `publication`, `grant`) and the `run-staging-probe.sh` method from the 2026-11-09 drill.<br>• Master credentials secret is `scholars/<env>/db/master-its` (was `scholars/staging/aurora/master`).<br>• Removed the out-of-date "empty cluster" caveat; the staging cluster now holds full data (confirmed by the 2026-11-09 drill).<br>• Flagged that switching the app to a restored cluster isn't documented. |
| 1.0 | Earlier | Original runbook (closes #414) with drills from 2026-05-21 and 2026-11-09. |
