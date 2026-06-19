# Clinical Trials — export/import bridge runbook

The direct `etl:clinical-trials` needs one runner that reaches BOTH reciterdb
(read) and the Sps Aurora (write). Until the SPS↔WCM networking lands (#443) no
single environment can do both: the in-VPC ETL task can't reach reciterdb
(`failed to create socket after 2000ms`), and reciterdb-reachable hosts can't
reach the in-VPC Aurora. This bridge splits the work, mirroring the ED
email-visibility bridge (#1100).

## Shape

```
reciterdb  ──(export, reciterdb-reachable host)──▶  s3://<bucket>/clinical-trials/bridge.ndjson
                                                              │
Sps Aurora ◀──(import, in-VPC run-task)──────────────────────┘
```

- **export** (`etl:clinical-trials:export`) — reads `clinical_trials` +
  `clinical_trials_enriched`, writes raw discriminated NDJSON (`{t:"i"|"e",…}`)
  to S3. No DB write. Run where reciterdb is reachable (scholars-dev /
  TGW-attached host with `SCHOLARS_RECITERDB_*` set).
- **import** (`etl:clinical-trials:import`) — reads the NDJSON, applies the SAME
  join/role/build as the direct ETL (`etl/clinical-trials/shared.ts`), and
  full-replaces `clinical_trial` + `person_clinical_trial`. Run in-VPC as a
  normal `run-task`. Idempotent. REFUSES to run on an empty/corrupt export
  (would wipe good data) unless `--allow-empty`.

S3: `CLINICAL_TRIALS_BUCKET ?? ARTIFACTS_BUCKET ?? wcmc-reciterai-artifacts`,
key `CLINICAL_TRIALS_KEY` / `--key` (default `clinical-trials/bridge.ndjson`),
region `AWS_DEFAULT_REGION` (default us-east-1).

## Staging rollout

1. **Export** from a reciterdb-reachable host (dry-run first):
   ```
   npm run etl:clinical-trials:export -- --dry-run
   npm run etl:clinical-trials:export
   ```
2. **Import** in-VPC via `run-task` on `sps-cluster-staging`, task-def
   `sps-etl-staging`, container `etl`, command `npm run etl:clinical-trials:import`,
   network config from the `scholars-nightly-staging` Step Function
   (subnets `subnet-019afebef588ee4b3`,`subnet-03de6e3dfe190288b`,
   SG `sg-09b494047547ea148`). Dry-run first:
   ```
   ...command: ["npm","run","etl:clinical-trials:import","--","--dry-run"]
   ...command: ["npm","run","etl:clinical-trials:import"]
   ```
3. **Flip the flag**: `CLINICAL_TRIALS_SECTION` is already staging-on in
   app-stack; activate via `cdk deploy --exclusively Sps-App-staging`
   (CD image-roll alone does NOT change task-def env).
4. **Verify** a known-PI profile renders the Clinical trials section.

## After #443 lands

The bridge becomes optional: a single in-VPC `npm run etl:clinical-trials`
reads reciterdb and writes Aurora directly. Keep the bridge for environments
that stay split.
