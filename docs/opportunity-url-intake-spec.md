# Opportunity URL intake — spec (v2: ReciterAI-processed)

**Status:** IMPLEMENTED — SPS PR #1496 + ReciterAI PR wcm-its/ReciterAI#285 (both flag-dark/inert until the §9 rollout)
**Date:** 2026-07-06 (v2 same day; v1's SPS-local pipeline dropped per review — see §2)
**Code refs:** SPS grounded against `origin/master` @ `55906d9c`; ReciterAI against its `main` @ `53462e2`.

## 1. Problem

Development-office staff find foundation funding opportunities on the web (example:
<https://www.skincancer.org/about-us/research-grants/>) and want researcher
recommendations for them. Today the corpus is ingest-only: ReciterAI pipelines
(grants.gov / SPIN / WCM-curated CSV) → DynamoDB `GRANT#` → nightly `etl:dynamodb` →
`opportunity` table → `/edit/find-researchers`. The only "manual" path is editing a CSV
someone later runs through a laptop CLI. There is no in-app way to say "here's a URL,
add it."

No prior art: no issue/PR/spec covers in-app submission (checked 2026-07-06; closest
are #1218 Track A.2 — CSV ingest, upstream — and #1203 rollout).

## 2. Decision

**Split by ownership.** SPS owns the *submission* (UI, SAML authz, audit, instant
duplicate check, status visibility). **ReciterAI owns all processing** — scrape,
extraction, research/non-research judge, topic scoring, prestige, honorific, dedup,
persist — exactly as it does for every other source. The round trip is a `SUBMISSION#`
queue item in the existing `reciterai` DynamoDB table.

**Alternative considered — SPS-local pipeline (v1 of this spec):** scrape + LLM-extract
in the SPS app via AI Gateway, write `source="manual"` rows straight to the
`opportunity` table, get recommendations in ~30 s. Rejected:

- **Calibration.** The matcher's topicAffinity is a cosine between the opportunity's
  topic vector and scholar vectors derived from ReciterAI's publication scorer
  (`pipeline_grants/scoring.py` reuses `score_publications.score_one_publication`).
  Vectors from a different prompt/model aren't calibrated against that space — rankings
  would be silently miscalibrated with no way to see it in a preview.
- **Source of truth.** DDB `GRANT#` is the corpus SOR; the MySQL table is a projection.
  Rows existing only in the projection survive today's ETL only because it happens to be
  upsert-only — an incidental property, not a contract. Any rebuild-from-DDB or new
  S3-artifact consumer would silently drop them.
- **Parity debt.** Manual rows would lack prestige/`match_dsl` and miss every upstream
  enrichment that lands later; extraction logic would be duplicated across two repos.

Cost accepted: recommendations arrive after the next ReciterAI run + nightly SPS ETL
(typically next morning) instead of interactively. If minutes-latency matters later, an
on-demand trigger (run-task + single-item projection) can be added without changing the
contract — the seams are the queue item and the `GRANT#` record.

## 3. Users & authz

Same gate as `/edit/find-researchers` and `/api/opportunities`
(`getEffectiveEditSession()` → `isSuperuser || isDeveloper`, surface gated by
`DEVELOPMENT_ENABLED`). New behavior additionally behind `OPPORTUNITY_URL_INTAKE` (§9).

## 4. Flow

```
[/edit/find-researchers panel]                       SPS
  URL + optional note
    ├─ instant checks: https-only URL shape; normalized-URL dedup vs
    │  opportunity.sourceUrl (projection) AND pending SUBMISSION# items
    ├─ PutItem SUBMISSION#<uuid> {url, submitted_by, note, status: pending}
    └─ audit append: opportunity_submission
  panel lists submissions w/ status chips (pending / processed→links / rejected+reason)

[pipeline_grants.ingest_submissions]                 ReciterAI  (manual CLI today;
  drain pending SUBMISSION# items:                    nightly once #269 lands)
    fetch URL (stdlib urllib, SSRF-guarded; JS-rendered pages reject as
      content_too_thin — no headless browser in v1, the WCM funding-DB Playwright
      scrape was external to the repo) → extract 1..N award programs (Bedrock; one
      page can carry several — the example URL has three: $50k/$50k/$25k, no
      deadline on page)
    → existing pipeline per program: normalize → denoise judge (is_research,
      appeal_by_stage) → topic scorer → prestige/honorific → title-Jaccard dedup
      vs corpus → persist GRANT#manual_url:<slug>-<sha1[:6]>
    → update SUBMISSION# status: processed {produced_opportunity_ids} | rejected {reason}

[nightly etl:dynamodb]                               SPS
  GRANT# projection upserts the new rows — zero new read-side code; the reverse
  matcher, browse picker, and next index rebuild all pick them up as ordinary rows.
```

No human preview gate before persist (v1 had one; it moved out with the processing).
Replacement: the denoise judge filters junk upstream, and the submitter sees the
outcome (or rejection reason) on the panel next day.

## 5. SPS side

### `POST /api/edit/opportunity-intake`

Request: `{ url: string, note?: string }` (note ≤ 500 chars, shown to the pipeline
operator and stored on the item).

Checks, in order:

1. authz (§3) → 403; flag off → 404.
2. URL shape: `https:` only, ≤ 512 chars → 400 `https_required` / `invalid_url`.
   (No server-side fetch happens in SPS — SSRF surface lives upstream, §8.)
3. Normalize (lowercase scheme+host, strip fragment, trailing slash, `utm_*`/`fbclid`)
   and compare against (a) all `opportunity.sourceUrl` (~900 rows, in-process) and
   (b) pending/processed `SUBMISSION#` items → 409 `duplicate_url` /
   `duplicate_submission`, payload includes the existing opportunityId or submission so
   the UI links to it.
4. `PutItem` to the `reciterai` table + audit append (action `opportunity_submission`,
   `targetEntityType: "opportunity_submission"`, `targetEntityId` = submission id,
   `afterValues` = {url, note}) → `201 { submissionId }`.

### `GET /api/edit/opportunity-intake`

Same authz. Scans `SUBMISSION#` (tiny), returns all submissions newest-first:
`{ submissionId, url, note, submittedBy, submittedAt, status, producedOpportunityIds?,
rejectReason? }`. Whole team sees all submissions — prevents duplicate effort.

### `SUBMISSION#` item schema (new, in the existing `reciterai` table)

```
PK: SUBMISSION#<uuid>   SK: META
url, normalized_url, note?, submitted_by (cwid), submitted_at (ISO)
status: pending | processed | rejected
processed_at?, produced_opportunity_ids?: string[], reject_reason?
```

### IAM (cdk `app-stack.ts`)

App task role gains `dynamodb:PutItem`/`Query`/`Scan` on the `reciterai` table
**scoped with a `dynamodb:LeadingKeys = ["SUBMISSION#*"]` condition** — the app can
never touch `GRANT#` items. (The ETL task's existing read stays as-is.)

### UI

Panel on `/edit/find-researchers` (flag-gated): "Can't find an opportunity? Submit its
URL." — URL input, optional note, Submit → inline confirmation
("Queued — appears in this list once processed, typically the next business day"),
plus the submissions table with status chips; `processed` links each produced
opportunity into the matcher picker; `rejected` shows the reason.

## 6. ReciterAI side

New `pipeline_grants/ingest_submissions.py` (CLI: `python -m
pipeline_grants.ingest_submissions [--dry-run]`), reusing existing stages:

1. Query pending `SUBMISSION#` items.
2. Fetch page (`safe_fetch.py`, stdlib `urllib` — no new dependency): SSRF guard per
   §8, tags stripped. Text < 500 chars (JS-rendered/empty) → reject
   `content_too_thin`; PDF/paywalled → reject with reason. No headless browser in
   v1 — the WCM funding-DB Playwright scrape was external to the repo, so there is
   no fallback to reuse; rejected submitters see the reason and can escalate.
3. **New stage — page → programs:** Bedrock extraction returning 1..N
   `{title, sponsor, synopsis, award amounts, dates?, eligibility_raw}` (structured
   output; most fields nullable — the example page has no deadlines).
4. Per program, the existing pipeline: `normalize.py` (source `manual_url`,
   `opportunity_id = manual_url:<slug(title)>-<sha1(url+title)[:6]>`, mirroring the
   `wcm_curated:` format) → `denoise.py` LLM judge (curated-style: skip the regex gate,
   keep the judge — a dev officer's submission deserves the human-trust path, but
   `is_research=false` still rejects with the judge's reason) → `scoring.py` topic
   vector → `prestige.py` + honorific regex → title-Jaccard dedup vs corpus (funding-db
   runbook measure; token-identical drops, near-dups kept) → `persist.py` `GRANT#`.
5. Update the `SUBMISSION#` item: `processed` + produced ids, or `rejected` + reason
   (fetch failed / not research / all programs duplicate / extraction empty).
   One try/except per submission (resilient, per the #270 pattern).

Ops: until wcm-its/ReciterAI#269 (scheduler) lands, the drain runs manually alongside
the other ingests; #269 makes it nightly. Docs: committed runbook
`docs/opportunity-url-submissions-runbook.md` (the workflow handoff doc is untracked
in that repo, so the runbook stands alone).

## 7. Dedup summary

| When | Where | Rule | Outcome |
|---|---|---|---|
| Submit time | SPS | normalized URL vs `opportunity.sourceUrl` + existing submissions | 409, link to existing |
| Process time | ReciterAI | token-identical title (stopword-stripped) vs corpus | program dropped; submission notes it |
| Process time | ReciterAI | near-dup title (Jaccard 0.6–0.9) | kept, consistent with cross-source policy |

## 8. Security

- **SSRF (upstream fetch).** `ingest_submissions` fetches user-supplied URLs from
  ReciterAI compute: `https:` only; resolve DNS and reject private/reserved ranges
  (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `::1`,
  `fc00::/7`, `fe80::/10`); redirects re-validated per hop (max 3); 15 s timeout; 2 MB
  cap; no cookies/auth sent. (Implemented as "every DNS answer must be globally
  routable" — `ipaddress.is_global` — which covers all the listed ranges.) Known
  ceiling: resolve-then-connect leaves a DNS-rebinding TOCTOU; IP-pinning the
  connection is the upgrade if the submitter population ever becomes adversarial —
  today it is audited WCM staff.
- **Prompt injection.** Page text is untrusted input to the extraction/judge prompts; a
  page could instruct the model. Mitigations: structured-output schemas (no free-form
  actions), the denoise judge as an independent second pass, and dev-role review of
  what lands (submissions panel + the matcher surface itself).
- **Queue abuse.** Submissions are dev-role/superuser-gated, audit-logged with actor,
  URL-shape-validated, and deduped; the app's DDB write is `LeadingKeys`-scoped to
  `SUBMISSION#` so a compromised app credential cannot alter the corpus.
- **Stored XSS.** Extracted `title`/`synopsis` render as text in existing components;
  never `dangerouslySetInnerHTML` on pipeline-derived fields.

Out of scope: authenticated/paywalled scraping; PDF parsing (reject with reason);
malicious-staff DoS (trusted, audited population).

## 9. Flags & rollout

- `OPPORTUNITY_URL_INTAKE` (SPS, default off, ships dark). Static-literal read
  (`process.env.OPPORTUNITY_URL_INTAKE`) per the flag-parity gate; wire `.env.local`
  **and** `cdk/lib/app-stack.ts` per-env; regenerate the cdk snapshot
  (`cd cdk && npm test -- -u`).
- The IAM change (§5) ships in the same `cdk deploy Sps-App-<env>`.
- Rollout: staging flag on → submit skincancer.org URL → run the ReciterAI drain against
  staging DDB → staging nightly ETL → verify 3 opportunities in Find Researchers →
  dev-office user validates → prod flip (post-#475 approval).
- Zero SPS migrations; zero SPS read-side changes (rows arrive as ordinary `GRANT#`
  projections, `source = "manual_url"`). Optional one-liner: add `manual_url: 0` to
  `SOURCE_RANK` in `app/api/opportunities/route.ts:22` so submissions sort with the
  curated tier in the picker.

## 10. Edge cases (test table)

| Input | Expected |
|---|---|
| skincancer.org example URL | 1 submission → 3 `GRANT#manual_url:*` items; amounts 50000/50000/25000; `due_date` null; research, non-honorific; visible in Find Researchers after ETL |
| URL already in corpus (any source, normalized match) | SPS 409 `duplicate_url` + link; nothing queued |
| URL already pending | SPS 409 `duplicate_submission` + link to the submission |
| `http://` or malformed URL | SPS 400; nothing queued |
| JS-rendered page (< 500 chars of text) | submission `rejected: content_too_thin` — headless-browser fallback is a noted v1 ceiling |
| PDF URL / paywalled page | submission `rejected: fetch/content unusable` — visible on panel |
| Travel/conference/symposium page | judge `is_research=false` → `rejected` with judge reason |
| Prize/lectureship page | persisted with `is_honorific=true`; hidden from matcher/browse by existing gates |
| Program title token-identical to corpus row | that program dropped; submission notes the drop |
| Near-dup title (Jaccard 0.6–0.9) | persisted (cross-source policy), near-dup noted |
| Host resolving to private IP / redirect to `169.254.169.254` | upstream fetch blocked; `rejected: ssrf_blocked` |
| Deadline in the past | denoise drops it (expired-deadline gate) → rejected with reason |
| Bedrock unavailable mid-drain | per-item try/except; item stays `pending`, retried next run |
| Unauthorized (no dev role) | SPS 403; no write |
| Flag off | panel absent; routes 404 |

## 11. Audit / verification SQL & queries (runnable)

```sql
-- projected manual submissions (SPS MySQL, after nightly ETL)
SELECT opportunity_id, title, sponsor, due_date, status, is_research, ingested_at
FROM opportunity WHERE source = 'manual_url' ORDER BY ingested_at DESC;

-- who submitted what (SPS audit DB)
SELECT ts, actor_cwid, target_entity_id, action
FROM scholars_audit.manual_edit_audit
WHERE action = 'opportunity_submission' ORDER BY ts DESC;
```

```bash
# queue state (DDB)
aws dynamodb scan --table-name reciterai \
  --filter-expression "begins_with(PK, :p)" \
  --expression-attribute-values '{":p":{"S":"SUBMISSION#"}}' \
  --query 'Items[].{id:PK.S,status:status.S,url:url.S}'
```

## 12. Out of scope / ceilings (v1)

- **Interactive latency** — next-run + nightly-ETL (~next morning; until ReciterAI#269,
  "next run" is a manual drain). Upgrade path: on-demand run-task trigger + single-item
  SPS projection; contract unchanged.
- **Paste-text fallback for unfetchable pages** — rejected submissions name the reason;
  add a `pasted_text` field on the submission only if rejections show real demand.
- **Edit/withdraw UI for submissions** — resubmission after rejection covers it.
- **PDF extraction** — reject with reason; upstream can add later.
- **`match_dsl`/`match_query` for manual rows** — arrives automatically if/when
  ReciterAI backfills the corpus; nothing here blocks it (that's the point of v2).

## 13. Work split

- **SPS PR** (flag-dark, off fresh `origin/master`): panel component, the two
  `/api/edit/opportunity-intake` routes, URL normalizer + dedup check, audit action
  `opportunity_submission`, cdk IAM + flag wiring + snapshot. Tests: URL
  normalizer/dedup units, route authz/409 paths, panel render — full vitest
  `--maxWorkers=4` + tsc + cdk snapshot before push.
- **ReciterAI PR**: `pipeline_grants/ingest_submissions.py` (drain + fetch + page→programs
  extraction + status writes), SSRF guard, handoff-doc section. Tests: extraction schema
  parse on a saved skincancer.org fixture, SSRF unit cases, dry-run mode.
- **Ops**: staging validation per §9; drain added to the manual-run checklist until #269.
