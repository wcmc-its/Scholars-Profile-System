# POPS clinical fields in people search — scope

**Status:** scope for review (not approved to build)
**Date:** 2026-06-28
**Goal:** Index POPS / weillcornell.org **board certifications**, **specialties**, and **clinical expertise** so a people search for a specialty (e.g. "cardiology") surfaces the matching clinician *and* explains why ("Board certified in Cardiology"). Three deliverables: (1) a POPS ETL ingestion job, (2) search relevance, (3) search explanation.

Grounded on `origin/master` (working branch is drifted; symbol names are load-bearing, exact line numbers are not).

---

## 0. The thing that makes this non-trivial

POPS clinical fields are **zero-persist today**: `fetchPops()` (`lib/edit/pops.ts`) is an on-demand GET to `POPS_BASE_URL` keyed by cwid, called **only** in the CV-generation route when `hasClinicalProfile` is true. There are **no DB columns** for them and the search indexer never sees them. So there is no UI-only shortcut to searchability — the data has to be persisted and reindexed first. That's deliverable (1), and it's the only large piece; (2) and (3) are cheap once the data is in the doc.

## 1. Hard gate (decide first)

Privacy is **resolved (non-issue)** — POPS is the public weillcornell.org directory; no data-owner sign-off and no `is_hidden` honoring required. One gate remains:

| # | Gate | Why |
|---|------|-----|
| G1 | **Coverage probe before reindex.** Field-level coverage is unmeasured (only "42% of clinical providers absent from POPS" + "~18% honors" exist). | Don't reindex + ship a feature that lights up for a small fraction of clinicians. Run the ETL job, measure (§2 audit SQL), then go/no-go on §3/§4. If coverage is poor, stop after the ETL job and reassess. |

## 2. Deliverable 1 — POPS ETL job

**New file `etl/pops/index.ts`** — clones the ReCiter/NIH-Profile step shape (cohort → per-cwid external fetch → batched upsert).

- **Cohort:** `scholar` where `hasClinicalProfile = true`, not soft-deleted, active. Page with `findMany({ select: { cwid: true } })`. Size ~600–800.
- **Fetch:** reuse `fetchPops(cwid)` per scholar. **`fetchPops` has no throttling** (built for one-off CV calls) — add an explicit inter-request sleep (~100–200 ms, mirror the NIH-Profile step's throttle). Returns `null` on 404/unreachable → leave columns untouched, count as a miss, continue (best-effort; never abort the chain).
- **Transform:** from `mapProfile()` output, take `boardCertifications` (→ `[{board, specialty}]`), `specialties`, `expertise`. Dedup specialty strings across board-cert + `primary_specialties` (case-insensitive). (No `is_hidden` filtering — privacy resolved, §1.)
- **Persist:** update the scholar row's new columns + `popsRefreshedAt = now()`. Idempotent.
- **Orchestration:** add `["POPS", "etl/pops/index.ts"]` to the sources loop in `etl/orchestrate.ts`, positioned **after ED** (depends on `hasClinicalProfile`) and **before the search-index reindex**. Per-source failure stays isolated.
- **npm script:** `"etl:pops": "tsx etl/pops/index.ts"` in `package.json` for manual runs.

**Schema — new columns on `Scholar` (`prisma/schema.prisma`)**, JSON per project convention (`Publication.meshTerms` is the precedent; MySQL Prisma has no native `String[]`):

```prisma
popsBoardCertifications Json?     @map("pops_board_certifications") // [{ board, specialty }]
popsSpecialties         Json?     @map("pops_specialties")          // string[]
popsExpertise           Json?     @map("pops_expertise")            // string[]
popsRefreshedAt         DateTime? @map("pops_refreshed_at")
```

Migration `prisma/migrations/<ts>_add_pops_clinical_data/migration.sql`: `ALTER TABLE scholar ADD COLUMN ... JSON NULL` ×3 + `DATETIME(3) NULL`.

**Coverage probe (G1) — run after the first ETL pass** (read-only Aurora run-task pattern):

```sql
SELECT
  COUNT(*)                                                          AS clinical_scholars,
  SUM(JSON_LENGTH(COALESCE(pops_specialties, JSON_ARRAY())) > 0)    AS with_specialties,
  SUM(JSON_LENGTH(COALESCE(pops_board_certifications, JSON_ARRAY())) > 0) AS with_board_cert,
  SUM(JSON_LENGTH(COALESCE(pops_expertise, JSON_ARRAY())) > 0)      AS with_expertise,
  SUM(pops_refreshed_at IS NULL)                                    AS never_fetched
FROM scholar
WHERE has_clinical_profile = 1 AND deleted_at IS NULL;
```

> The ETL job + migration are **flag-independent and harmless** — they only populate columns nothing reads yet. Land and run them first; gate the decision to proceed to §3/§4 on the probe result.

## 3. Deliverable 2 — search relevance

Pattern: clone `methodFamily` (cheap, indexed, query-time `multi_match` boost). **Stays on the cheap OpenSearch path — must NOT touch `matchQueryToTaxonomy`** (the ~25-Prisma-count/request bottleneck). Marginal query cost ~1–2%.

- **Index doc** (`lib/search-index-docs.ts`): add the columns to `PEOPLE_INDEX_SELECT`; in `buildPeopleDoc` emit two `text` fields (omit-on-empty):
  - `clinicalSpecialties` — board-cert specialties ∪ `primary_specialties`, deduped.
  - `clinicalExpertise` — `expertise` / `problem_procedure`.
  - ponytail: two `text` fields, not keyword facets — no faceting was requested. Add keyword sub-fields only if a specialty filter UI lands later.
- **Mapping** (`lib/search.ts` `peopleIndexMapping`): both as `type: text, analyzer: scholar_text` (same as `areasOfInterest`). Adds ~0.5–2 KB/doc — within the ~53 KB/doc budget but **verify against the byte-aware 8 MB chunker** (#485/#626); keep expertise a single short blob, don't repeat it.
- **Query** — ~~add the two fields to the people `cross_fields multi_match` field set~~. **Superseded.** An in-VPC A/B proved the text-field path inert: `cross_fields` blends the clinical field into the same blob as publication text, so a clinician who also publishes on the topic gets no lift. The shipped mechanism is an additive **`function_score`** weight on docs whose board-derived `clinicalSpecialties` match the query (Track B / B2). The `SEARCH_PEOPLE_CLINICAL` flag, its `^N` field boost, and the `clinicalFields` spread have all been removed.
- **Flag:** `SEARCH_PEOPLE_CLINICAL_FN` (function_score weight, prod-on since 2026-07-05). **Reindex must land before the flag flips** (field has to be in the doc first). `clinicalExpertise` remains indexed but is read by no live query path.

## 4. Deliverable 3 — search explanation (match reason only)

Add a `"clinical"` evidence kind, mirroring `"method"`. Data reads from the hit `_source` — **no extra DB query** (cheaper than `method`, which hits `scholarFamily`). Zero marginal reason-agg-cache cost (that cache is publications-only). **Match reason only — no static card display** (per decision).

### 4.1 The pecking-order strategy (the crux)

`selectEvidence()` is a first-match-wins precedence list; today it already ranks by *match precision* (tagged > concept > mention). Clinical is **two signals, not one**, and obeys the same law:

- **`clinical:exact`** — the searcher asked for exactly this specialty. **The only clinical case that earns a reason line.** It sits at **rank 3/4 against `publications:tagged`, COUNT-GATED** (below): it beats a *weak* tagged-pub signal but loses to a *strong* one. Above `publications:concept` / `selfDescription` / `publications:mention` / `topic` regardless.
- **`clinical:loose`** — query tokens fuzzily overlap a specialty/expertise string. **Contributes to ranking only** (via the §3 `function_score` weight); generates **no** clinical reason. Conservative: under-claim rather than mislabel.

**Count-gated `clinical:exact` vs `publications:tagged`** (env-tunable). `clinical:exact` outranks a `tagged` reason only when the tagged pub **count is below a threshold** — higher for a board certification than a bare specialty (`SEARCH_PEOPLE_CLINICAL_BOARD_OVER_TAGGED` default **6**, `…_SPECIALTY_OVER_TAGGED` default **4**):
- board-cert match beats ≤5 tagged pubs, loses to ≥6;
- specialty-only match beats ≤3 tagged pubs, loses to ≥4 ("5 pubs > 1 specialty; 3 → specialty wins; board cert > specialty").
- With no tagged pubs, `clinical:exact` wins outright. Thresholds absent ⇒ original behavior (tagged always wins when present).

Resulting order (▸ = new):

```
1  name (not rendered)
2  method
3⇄4  publications:tagged ⇄ ▸ clinical:exact   (count-gated: strong pubs win, weak pubs lose to the credential)
5  publications:concept
6  selfDescription (full-bio)
7  publications:mention
8  topic
   …  (clinical:loose produces no reason; affiliation / concepts / areas / none follow)
```

Rationale: in a **research** profile system, *substantial* publication on the topic (`tagged`, high count) is the most on-mission reason and still wins. But an authoritative board certification should beat a thin pub signal or an incidental *mention* — which fixes the failure mode where a board-certified cardiologist with one tangential paper would otherwise read "1 of 99 publications mention cardiology" instead of "Board certified in Cardiology."

**Exact-tier detection (cheap, JS over `_source` + query, no taxonomy/LLM):** a hit is `clinical:exact` iff, for some single specialty string `s` in the hit's board-cert ∪ specialty set, **every content token of the query is contained in `s`** (token-subset), **or** `s` appears as a phrase in the query.
- `"cardiology"` vs `"Cardiology"` → exact ✓
- `"interventional cardiology"` vs `"Interventional Cardiology"` → exact ✓
- `"pediatric cardiology"` vs `"Cardiology"` → not exact (query is narrower) → loose, no reason
- `"heart surgery"` vs `"Cardiac Surgery"` → not exact (no token overlap) → loose, no reason

Known v1 gap (accepted): synonym/abbreviation specialty queries ("heart" → cardiology) won't earn a clinical reason, though they still help ranking. Revisit only if it matters.

**Label honesty:** the evidence variant carries `boardCertified: boolean` (is `s` in the board-cert set vs primary-specialties only). Render **"Board certified in {s}"** when true, else **"Clinical specialty: {s}"** — never claim a board certification we don't have.

### 4.2 Change footprint

| File | Change |
|------|--------|
| `lib/api/result-evidence.ts` | Add union variant `{ kind: "clinical"; specialty: string; boardCertified: boolean }`; add `clinical?: { specialty; boardCertified }` to `SelectEvidenceInput`; insert the count-gated rank-3/4 precedence clause in `selectEvidence()`. |
| `lib/api/search.ts` | In `resolveHitEvidence()`, run the §4.1 exact-tier check against the hit's `_source` clinical specialties + the content query; pass `clinical` (or nothing for loose) to `selectEvidence`. Gate on `SEARCH_PEOPLE_CLINICAL_FN`. |
| `components/search/result-evidence.tsx` | Add `case "clinical": return <MatchAwareReason kind="clinical" label={evidence.boardCertified ? \`Board certified in ${evidence.specialty}\` : \`Clinical specialty: ${evidence.specialty}\`} … />`. |
| `components/search/match-reason.tsx` | Extend `MatchAwareReason` kind union with `"clinical"`; add `Stethoscope` icon + teal badge branch; import the icon. |

**Icon/badge (confirmed):** `Stethoscope` (lucide; available — Method=`Wrench`, Topic=`Shapes`, Pubs=`FileText`, Concept=`Waypoints`) + teal badge `border-[#c5e4eb] bg-[#e8f4f8] text-[#1a5f7a]`. One canonical icon across all surfaces (#1073).

## 5. Rollout order (mirrors the methodFamily lifecycle)

1. Schema migration + `etl/pops/index.ts` + orchestrate wiring → land, run on staging.
2. **Coverage probe (G1)** → go/no-go on the rest.
3. Index mapping + `buildPeopleDoc` fields → full reindex (field in doc, nothing queries it yet).
4. Query boost + `"clinical"` reason kind, behind `SEARCH_PEOPLE_CLINICAL_FN` (the text-field variant and its flag are removed).
5. Flag parity: wire `SEARCH_PEOPLE_CLINICAL_FN` and the two `…_OVER_TAGGED` thresholds in `cdk/lib/app-stack.ts` per-env (not just `.env.local`) + regenerate the app-stack snapshot (`cd cdk && npm test -- -u`).
6. Flip flag **on staging** → verify a specialty query surfaces the right clinician with the clinical reason → soak → prod.

## 6. Edge cases / tests

| Case | Expected |
|------|----------|
| `hasClinicalProfile` true, POPS 404/empty | columns null → no clinical field in doc → no clinical reason. |
| Research-only faculty (no clinical profile) | never fetched, never indexed, never a reason. |
| Specialty duplicated across board-cert + `primary_specialties` | deduped before indexing; board-cert membership still recoverable for the `boardCertified` label. |
| Exact specialty query + `tagged` pub match on same hit | `tagged` (rank 3) wins → "publishes on it"; clinical not shown (intended). |
| Exact specialty query + only a pub `mention`/`topic` | `clinical:exact` (rank 4) wins → "Board certified in X" (the fix). |
| Loose/synonym specialty query ("heart" → Cardiology) | no clinical reason; still contributes to ranking; falls through to other evidence. |
| Specialty present but not board-certified | label "Clinical specialty: X", never "Board certified". |
| POPS specialty changed since last run | refreshed nightly; `popsRefreshedAt` tracks staleness. |
| `SEARCH_PEOPLE_CLINICAL_FN` OFF | identical to today (fields indexed but unqueried, no reason emitted). |

## 7. Decisions

Resolved: privacy non-issue (§1); icon/badge `Stethoscope` + teal (§4.2); conservative boost (§3); **match reason only**, no static display (§4); pecking-order strategy = exact-only at rank 4 (§4.1).

Remaining: **G1 coverage probe is the only go/no-go** — run the ETL job, measure, then proceed to §3/§4 (or stop). Nothing else blocks the build.

---

**Effort:** ETL job + schema = the bulk (new external-source step + migration + one reindex). Relevance + explanation are small once the data is in the doc. No new dependency; everything clones an existing pattern (`methodFamily` for relevance, `"method"` evidence kind for explanation, ReCiter/NIH-Profile for the ETL step).
