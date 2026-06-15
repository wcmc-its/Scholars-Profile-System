# Curated-tables logical backup — runbook

Staging is the **system-of-record** for data that humans curate by hand through
`/edit` — org-unit structure/names/leaders/descriptions and the methods-&-tools
family-visibility overlays — including edits made by external Comms
collaborators. This runbook covers the small, durable, **logical** backup of
just those tables, which complements (does not replace) the cluster-level
protection already in place.

## What already protects this data

| Layer | What | Window | Granularity |
|---|---|---|---|
| Aurora PITR | continuous point-in-time recovery | 14 days (staging & prod) | whole cluster → new cluster |
| AWS Backup | daily snapshot 01:00 ET, cross-region copy to `us-west-2` | 14 days staging / 35 days prod | whole cluster → new cluster |
| **This export** | gzipped SQL dump of the curated tables → S3 | as long as you keep the objects | per-table / per-row, diffable |

The first two are whole-cluster restores capped at 14 days. This export is the
belt-and-suspenders: long-lived, diffable, and restorable row-by-row.

## What it captures

Defined in `scripts/backups/export-curated-tables.ts` (`CURATED_TABLES`):

- **Org units:** `department`, `division`, `center`, `center_program`,
  `center_membership`, `division_membership`, `unit_admin` (membership
  research/clinical type is a `membership_type` enum column on
  `center_membership`, not a separate table)
- **Methods & tools visibility overlays:** `family_suppression_overlay`,
  `family_sensitivity_overlay`
- **Cross-cutting manual curation** (org-unit descriptions, leader overrides,
  "overview for others", hand suppress/show decisions live here):
  `field_override`, `suppression`

**Deliberately excluded** (ETL-regenerable from upstream, not hand-entered):
`scholar_tool`, `scholar_family`, `spotlight`, topics/subtopics, the search
index. To add or drop a table, edit the single `CURATED_TABLES` list.

## Format

A `mysqldump`-compatible `.sql` produced **in-process** via Prisma raw queries
(`SHOW CREATE TABLE` + `SELECT`) — no `mysqldump`/`mariadb-dump` binary is
required (the `sps-etl-<env>` image is Node-only). Each table is emitted as
`DROP TABLE IF EXISTS` + `CREATE TABLE` + batched `INSERT`s, with
`FOREIGN_KEY_CHECKS=0` and `time_zone='+00:00'` in the header. **Replay it into a
scratch schema, never onto the live database.**

Each run uploads four objects to the backup bucket (`CURATION_BACKUP_BUCKET`):

```
sps-curation-backups/<env>/<YYYY-MM-DD>/curated-tables-<stamp>.sql.gz
sps-curation-backups/<env>/<YYYY-MM-DD>/curated-tables-<stamp>.manifest.json
sps-curation-backups/<env>/latest/curated-tables.sql.gz          # newest pointer
sps-curation-backups/<env>/latest/curated-tables.manifest.json
```

The manifest records per-table row counts, byte sizes, and a sha256 of the gzip.

---

## 1. Activate (one-time, per env)

The bucket + the task role's `PutObject` grant + the `CURATION_BACKUP_BUCKET`
env var are defined in `cdk/lib/etl-stack.ts`. A normal CD image roll does **not**
apply CDK changes, so this needs an explicit deploy:

```bash
cd cdk
npx cdk diff Sps-Etl-staging      # review: new S3 bucket, PutObject policy, env var
npx cdk deploy Sps-Etl-staging --exclusively
```

This creates `sps-curation-backups-…` (versioned, SPS-account-owned, RETAIN) and
re-rolls the `sps-etl-staging` task definition with the bucket name injected.
Find the generated bucket name afterward from the stack output
`CurationBackupBucketName` (or `aws s3 ls | grep curation-backups`).

> Prod: same steps with `Sps-Etl-prod` once staging is exercised. The prod ETL
> stack may be behind master — read the **full** `cdk diff` before deploying.

## 2. Run on demand (in-VPC run-task)

The deployed task has `DATABASE_URL` and `CURATION_BACKUP_BUCKET` baked in, so the
command override is just the npm script:

```bash
# Discover the private subnets + ETL security group from a recent ETL run, or
# reuse the values the scheduled ETL state machine uses, then:
aws ecs run-task \
  --cluster sps-cluster-staging \
  --task-definition sps-etl-staging \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[SUBNET_A,SUBNET_B],securityGroups=[ETL_SG],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","backup:curated"]}]}'
```

Watch the task logs (`/aws/…` ETL log group, stream prefix `etl`) for the
`Uploaded to s3://…` line.

## 3. Verify a backup

```bash
aws s3 cp s3://<bucket>/sps-curation-backups/staging/latest/curated-tables.manifest.json - | jq
```

Check `generatedAt` is recent, `tables` lists all 12 (none silently missing —
the script errors on a missing configured table unless `--allow-missing`), and
`totalRows` looks sane.

## 4. Restore (into a scratch schema — NEVER the live DB)

The dump contains `DROP TABLE IF EXISTS`, so replaying it onto `scholars` would
**destroy** live tables. Always restore into a throwaway schema, then copy out
only the rows you need.

```bash
# In a run-task shell (mariadb client is in the image) or locally:
aws s3 cp s3://<bucket>/sps-curation-backups/staging/latest/curated-tables.sql.gz .
gunzip curated-tables.sql.gz

mariadb "$DATABASE_URL" -e "CREATE DATABASE IF NOT EXISTS scholars_restore;"
mariadb "$DATABASE_URL" --database scholars_restore < curated-tables.sql

# Inspect / diff a specific table, e.g. recover one center's curation:
mariadb "$DATABASE_URL" -e \
  "SELECT * FROM scholars_restore.center WHERE slug='meyer-cancer-center';"

# Copy specific rows back into the live schema with a targeted INSERT…SELECT or
# UPDATE — reviewed by hand. Do NOT bulk-replace live tables.
```

This was validated end-to-end on the local dev DB: dump → gunzip → replay into a
scratch schema → row counts matched source exactly.

## 5. (Optional) Put it on a small schedule

Left as an opt-in so we don't run recurring infra without intent. A standalone
weekly EventBridge Scheduler → ECS RunTask is the lightest option. Add to
`cdk/lib/etl-stack.ts` (sketch):

```ts
new scheduler.CfnSchedule(this, "CurationBackupSchedule", {
  scheduleExpression: "cron(0 6 ? * MON *)",   // Mondays 06:00 UTC
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: `arn:aws:ecs:${this.region}:${this.account}:cluster/${ecsCluster.clusterName}`,
    roleArn: /* a role allowed to ecs:RunTask + iam:PassRole the task roles */,
    ecsParameters: {
      taskDefinitionArn: this.etlTaskDefinition.taskDefinitionArn,
      launchType: "FARGATE",
      networkConfiguration: { /* private subnets + ETL SG */ },
    },
    input: JSON.stringify({
      containerOverrides: [{ name: "etl", command: ["npm", "run", "backup:curated"] }],
    }),
  },
});
```

Alternatively, add `backup:curated` as a step in the existing nightly Step
Functions cadence — at the cost of coupling backup success to the ETL run.

## Local / dev usage

```bash
# Dry run — build everything, print the manifest, write nothing:
npm run backup:curated -- --dry-run --allow-missing

# Write a local file instead of uploading (dev DB lacks the overlay tables):
DATABASE_URL=… npm run backup:curated -- --out /tmp/spsbackup --allow-missing
```

`--allow-missing` is dev-only — on staging a configured table that is absent must
fail loudly rather than produce a partial backup labelled complete.
