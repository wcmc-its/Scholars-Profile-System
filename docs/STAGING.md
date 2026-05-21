# Staging environment

Staging is a structural mirror of production: same CDK stacks, same Aurora engine + version, same OpenSearch engine + version, same secret layout, same backup posture, in the same AWS account (`665083158573`, `us-east-1`). Isolation is by **env-prefix**, not by separate accounts. This document is the operator reference for that arrangement.

Closes the documentation half of [#112](https://github.com/wcmc-its/Scholars-Profile-System/issues/112). Companion to [ADR-008 — Infrastructure-as-Code](./ADR-008-infrastructure-as-code.md) and [PRODUCTION_ADDENDUM.md](./PRODUCTION_ADDENDUM.md).

## Env-prefix naming convention

Every shared resource carries the env name as a suffix (CDK stack scope) or in the consumer-facing identifier. The contract is:

| Layer | Pattern | `prod` example | `staging` example |
|---|---|---|---|
| CloudFormation stack | `Sps-{Stack}-{env}` | `Sps-Data-prod` | `Sps-Data-staging` |
| BackupVault | `sps-backup-vault-{env}` | `sps-backup-vault-prod` | `sps-backup-vault-staging` |
| BackupPlan | `sps-aurora-daily-{env}` | `sps-aurora-daily-prod` | `sps-aurora-daily-staging` |
| Aurora cluster | CDK-generated under env-scoped stack | `sps-data-prod-auroracluster23d869c0-…` | `sps-data-staging-auroracluster23d869c0-…` |
| OpenSearch domain | CDK-generated under env-scoped stack | `opensearch58799-fquptd67j2so` | `opensearch58799-9dwko5mxr7bu` |
| Secrets Manager (DB) | `scholars/{env}/db/{master,app-rw,app-ro,etl}` | `scholars/prod/db/master` | `scholars/staging/db/master` |
| Secrets Manager (OpenSearch) | `scholars/{env}/opensearch/{app,etl}` | `scholars/prod/opensearch/app` | `scholars/staging/opensearch/app` |
| Secrets Manager (ISR token) | `scholars/{env}/revalidate-token` | `scholars/prod/revalidate-token` | `scholars/staging/revalidate-token` |
| Tag | `Environment={env}` | `Environment=prod` | `Environment=staging` |

**Rule for any new infra PR:** if a resource name doesn't contain `${envConfig.envName}` (literally or via stack scoping), the PR is wrong. Both `Sps-Data-staging` and `Sps-Data-prod` get every resource via the same CDK construct tree — diverging here is what cost PR #404.

To inventory the staging surface in one call:

```sh
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Environment,Values=staging \
  --query 'ResourceTagMappingList[].ResourceARN' \
  --output text | tr '\t' '\n'
```

Swap `staging` for `prod` to inventory the other side. The two lists should be near-symmetric in structure (same kinds of ARNs, env-suffixed); a structural delta usually means one side missed a deploy.

## Aurora prod → staging snapshot restore

Prod runs continuous backup (RDS `BackupRetentionPeriod=14`) plus a daily AWS Backup plan (`sps-aurora-daily-prod`, vault `sps-backup-vault-prod`, 30-day retention). To refresh staging from a recent prod snapshot:

### 1. Identify the source snapshot

```sh
# Most recent automated snapshot from prod
aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier "$(aws rds describe-db-clusters \
      --query 'DBClusters[?contains(DBClusterIdentifier, `sps-data-prod`)].DBClusterIdentifier' \
      --output text)" \
  --snapshot-type automated \
  --query 'reverse(sort_by(DBClusterSnapshots,&SnapshotCreateTime))[:1].{id:DBClusterSnapshotIdentifier,created:SnapshotCreateTime}' \
  --output table
```

For an AWS Backup recovery point instead (preferred once the daily plan has fired, since recovery points are immutable and live in a separate vault):

```sh
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name sps-backup-vault-prod \
  --query 'reverse(sort_by(RecoveryPoints,&CreationDate))[:1].{arn:RecoveryPointArn,created:CreationDate,status:Status}' \
  --output table
```

### 2. Take staging out of service

Before the rename, confirm no AppStack tasks are running against the staging cluster (`aws ecs list-services` once AppStack lands; until then, this is a no-op). Then rename the current staging cluster out of the way — you cannot restore on top of an existing cluster identifier.

```sh
# Capture the current staging cluster id
STAGING_ID=$(aws rds describe-db-clusters \
  --query 'DBClusters[?contains(DBClusterIdentifier, `sps-data-staging`)] | [0].DBClusterIdentifier' \
  --output text)

# Park it under a dated archive name so it's obvious it's stale
aws rds modify-db-cluster \
  --db-cluster-identifier "$STAGING_ID" \
  --new-db-cluster-identifier "${STAGING_ID}-archive-$(date -u +%Y%m%d)" \
  --apply-immediately
```

### 3. Restore from snapshot into the staging slot

The restore call recreates the cluster under the original logical identifier. Engine, version, parameter group, subnet group, and KMS key all come from the source — keep them aligned with what CDK provisions for staging so the next `cdk deploy --exclusively Sps-Data-staging` doesn't see drift.

```sh
SNAPSHOT_ARN="arn:aws:rds:us-east-1:665083158573:cluster-snapshot:<from step 1>"
TARGET_ID="<original sps-data-staging-... id captured above>"

aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier "$TARGET_ID" \
  --snapshot-identifier "$SNAPSHOT_ARN" \
  --engine aurora-mysql \
  --vpc-security-group-ids "$(aws ec2 describe-security-groups \
      --filters Name=tag:Environment,Values=staging Name=group-name,Values=*Aurora* \
      --query 'SecurityGroups[0].GroupId' --output text)" \
  --db-subnet-group-name "$(aws rds describe-db-clusters \
      --db-cluster-identifier "${TARGET_ID}-archive-$(date -u +%Y%m%d)" \
      --query 'DBClusters[0].DBSubnetGroup' --output text)" \
  --tags Key=Environment,Value=staging Key=Project,Value=scholars-profile-system Key=ManagedBy,Value=cdk-restore
```

The cluster's writer/reader instances are **not** created by the restore — you must add them back to match prod's topology:

```sh
aws rds create-db-instance \
  --db-instance-identifier "${TARGET_ID}-writer" \
  --db-cluster-identifier "$TARGET_ID" \
  --db-instance-class db.t4g.medium \
  --engine aurora-mysql \
  --tags Key=Environment,Value=staging
```

(Match the writer/reader instance class and count to whatever `cdk/lib/data-stack.ts` specifies for staging at the time of restore.)

### 4. Refresh secrets pointing at the new cluster

The restored cluster gets a new internal endpoint host. The CDK-managed `scholars/staging/db/master` rotation secret was created against the **previous** cluster's writer endpoint, so the credential itself remains valid (same master user/password baked into the snapshot) but the secret JSON's `host` field is stale.

Update the host in-place rather than re-bootstrapping the secret (rotation history matters):

```sh
NEW_HOST=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$TARGET_ID" \
  --query 'DBClusters[0].Endpoint' --output text)

CURRENT=$(aws secretsmanager get-secret-value \
  --secret-id scholars/staging/db/master \
  --query SecretString --output text)

UPDATED=$(echo "$CURRENT" | jq --arg h "$NEW_HOST" '.host=$h')

aws secretsmanager put-secret-value \
  --secret-id scholars/staging/db/master \
  --secret-string "$UPDATED"
```

Repeat for `scholars/staging/db/app-rw`, `scholars/staging/db/app-ro`, and `scholars/staging/db/etl`. The reader endpoint goes into the `-ro` secret; the writer endpoint goes into `-rw`, `-master`, and `-etl`.

### 5. Verify

```sh
# Cluster is healthy and writable
aws rds describe-db-clusters \
  --db-cluster-identifier "$TARGET_ID" \
  --query 'DBClusters[0].{status:Status,endpoint:Endpoint,restoreSource:DBClusterIdentifier}' \
  --output table

# App-rw credential works against the new endpoint
mysql -h "$NEW_HOST" -u app_rw -p"$(aws secretsmanager get-secret-value \
  --secret-id scholars/staging/db/app-rw --query SecretString --output text | jq -r .password)" \
  -e "SELECT COUNT(*) FROM person;"
```

The row count should match a fresh prod query within the snapshot's freshness window.

### 6. Tear down the archived cluster

After 7 days of confidence, drop the parked cluster to recover storage:

```sh
aws rds delete-db-cluster \
  --db-cluster-identifier "${TARGET_ID}-archive-$(date -u +%Y%m%d)" \
  --skip-final-snapshot
```

(Skip-final-snapshot is acceptable here — the source recovery point still lives in `sps-backup-vault-prod`.)

## Smoke-test target for downstream workstreams

These open B-series workstreams name `staging` as their pre-prod smoke-test target. Each one's PR description should reference this section as the dry-run gate before any prod-facing deploy:

| B-id | Issue | Workstream | Why staging is its smoke target |
|---|---|---|---|
| **B01** | [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) | SSO on `/api/edit` (Shibboleth/SAML SP wiring) | First-party SAML against the staging SP cert (`scholars-staging.weill.cornell.edu`) before production cert is bound. Closes criterion 2 of #112 once `scholars-staging` DNS + EdgeStack land. |
| **B07** | [#106](https://github.com/wcmc-its/Scholars-Profile-System/issues/106) | EdgeStack: CloudFront cache-behavior split | Cache-key + behavior changes ride staging through real CDN edges before flipping prod. |
| **B08** | [#107](https://github.com/wcmc-its/Scholars-Profile-System/issues/107) | EtlStack: Step Functions + `etl_run` checkpoint | Step Function state machines deploy `staging` first; cadence + alarm wiring exercised against staging Aurora before prod. Closes criterion 4 of #112. |
| **B09** | [#108](https://github.com/wcmc-its/Scholars-Profile-System/issues/108) | AppStack: migration pipeline (part of B05+B06+B09+B17) | Prisma migrations run staging-first; rollback verified against staging Aurora before prod cuts over. |
| **B12** | [#111](https://github.com/wcmc-its/Scholars-Profile-System/issues/111) | Deploy strategy + rollback runbook | Rolling-vs-blue/green pattern proven on staging deploys, captured in `docs/DEPLOY-RUNBOOK.md`. |

Operating principle: a prod deploy without a recent (≤72 h) successful staging run is the deploy that fails. The B12 deploy runbook will codify this — until it lands, treat the staging deploy as a manual prerequisite.

## Open follow-ups

- **First scheduled BackupPlan execution** — `sps-aurora-daily-prod` was provisioned 2026-05-20 and has not yet fired (`LastExecutionDate: None`, vault has 0 recovery points). Verify within 48 h of that date that the daily window actually ran. Until it does, prod recovery is via RDS PITR (14-day window), not the AWS Backup vault.
- **Stale staging cluster ARNs** — `aws rds describe-db-clusters` lists more than one staging cluster identifier (likely orphan restore-test artifacts). Audit and reap any that aren't the live CDK-managed cluster before AppStack starts pointing at staging.
- **Operator-facing identifiers** — Aurora cluster IDs and OpenSearch domain names currently carry CDK auto-suffixes (`-naxambgndood`, `-fquptd67j2so`). Env-segregation is preserved via parent stack scope, but if Phase 2 work routinely targets these by ID, consider replacing the CDK default with an explicit `sps-aurora-{env}` / `sps-opensearch-{env}` name in a future stack rev.
