# Grants Bulk Export

Nightly NDJSON export of **every scholar's complete grant history** from the
Scholars Profile System (SPS) to S3, for the Research Informatics
cross-account consumer.

This replaces an earlier live "bulk API" idea, rejected on measured
performance grounds: a full-cohort JSON response runs ~58-67 MB, too heavy for
a synchronous web-tier route. This export instead writes one snapshot file
nightly; the consumer pulls it on their own schedule.

For a single scholar on demand instead of the whole cohort, see
[`faculty-review-grants-api.md`](./faculty-review-grants-api.md) — the
Bearer-token `GET /api/faculty-review/{cwid}/grants` route. Both surfaces
share one field-mapping implementation
(`lib/grants/faculty-review-grant-record.ts`), so they can't drift.

## What's in the bucket

| | |
|---|---|
| Bucket | Per-env, CFN-generated name (`Sps-Etl-<env>` stack output `GrantsExportBucketName`) |
| Key | `grants.ndjson` — a **single persistent key, overwritten every run**. No dated keys, no version history: the object is always the latest full snapshot, never a delta. |
| Format | Newline-delimited JSON (NDJSON) — one grant record per line |
| Content-Type | `application/x-ndjson` |
| Schedule | Daily, ~05:30 UTC (staging only today — see Rollout status below) |
| Producer | `scripts/exports/grants-bulk-export.ts` (`npm run export:grants-bulk`), run as an ECS task on `sps-etl-<env>` by the `scholars-grants-export-<env>` Step Function |

## Access

The task role writes the object (`s3:PutObject`, scoped to the one bucket).
Research Informatics' role is granted **read-only** access to the one object
key — `s3:GetObject` on `grants.ndjson` only, never `ListBucket` and never the
rest of the bucket — via a cross-account S3 bucket policy. Read the object
directly with your AWS credentials:

```bash
aws s3 cp s3://<bucket>/grants.ndjson - --profile <your-role-profile> | head
```

There is no API, no auth token, and no live endpoint to poll — this is a
plain S3 object read. Fetch it on whatever cadence you need; the object
changes at most once a day, right after the nightly write.

## NDJSON line schema

Each line is one JSON object — the **same `GrantRecord` shape**
[`faculty-review-grants-api.md`](./faculty-review-grants-api.md#grant-object)
documents field-by-field (`externalId`, `source`, `title`, `role`,
`roleLabel`, `isPrincipalInvestigator`, `awardNumber`, `funder`,
`primeSponsor`, `directSponsor`, `isSubaward`, `programType`, `mechanism`,
`nihIc`, `applId`, `startDate`, `endDate`, `isActive`) — **plus one added
field, `cwid`**, since this export has no per-request path parameter to carry
the scholar identity out of band the way the single-cwid API's response
envelope does.

Identical fields, plus `cwid`, for **all scholars instead of one**. See that
doc's field table for the full description of every field, including why
`Co-PI` means "Multiple Principal Investigator (MPI)" and not
"co-principal-investigator."

```jsonc
{"cwid":"abc1001","externalId":"INFOED-1234567","source":"InfoEd","title":"Mechanisms of Tumor Immune Evasion","role":"PI","roleLabel":"Principal Investigator","isPrincipalInvestigator":true,"awardNumber":"R01 CA123456","funder":"NCI","primeSponsor":"NCI","directSponsor":"NCI","isSubaward":false,"programType":"Grant","mechanism":"R01","nihIc":"NCI","applId":9988776,"startDate":"2021-04-01","endDate":"2026-03-31","isActive":true}
{"cwid":"abc1001","externalId":"REPORTER-7654321","source":"RePORTER","title":"...","role":"Co-I", ...}
{"cwid":"def2002","externalId":"INFOED-9988776","source":"InfoEd","title":"...","role":"Co-PI", ...}
```

- Lines are grouped by `cwid` (the query orders by `cwid ASC`) but this is an
  implementation detail, not a contract — don't rely on row ordering across
  runs; group client-side if you need per-scholar cohorts.
- A scholar with zero grants contributes zero lines — there is no per-scholar
  placeholder row.
- **No dollar amounts.** Same caveat as the per-cwid API: SPS never ingests
  award `$` from InfoEd, so no funding totals or direct-cost figures are in
  this export. For authoritative award financials, the system of record is
  InfoEd, not SPS.

## Rollout status

Staging-first. The nightly schedule and the cross-account read grant are both
gated by one deploy-time flag (`grantsExportScheduleEnabled`,
`cdk/lib/config.ts`): `true` in staging, `false` in prod. Prod does not yet
run the schedule and Research Informatics' role does not yet have prod read
access — both flip together once staging is hand-verified. Contact the SPS
operator for status.
