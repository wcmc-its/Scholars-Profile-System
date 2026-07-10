# RePORTER grants matcher — spec

**Status:** draft 2026-06-26, NOT built. Companion to `docs/scholar-cv-generator-spec.md`
(worktree branch `docs/scholar-cv-generator-spec`). This spec covers ONLY the grants
backfill that feeds the CV generator's grants section.

Code refs are `origin/master` (this branch is ~317 commits behind — re-ground before coding).

---

## 1. Problem

The CV generator has a faithful publication record (PubMed) but an incomplete grant
record. SPS grant rows come exclusively from **InfoEd** (`Grant.source` default `"InfoEd"`,
`etl/infoed/index.ts`), which only contains **WCM-administered** awards. For:

- lateral recruits (e.g. a dean) with NIH grants held at a **prior institution**, and
- affiliates whose grants are administered **elsewhere** (e.g. Memorial Sloan Kettering),

the federal portion of their grant history is absent from SPS and therefore from the CV.
NIH RePORTER has it — keyed to the investigator across institutions.

## 2. What does NOT work (verified, not assumed)

Probed `api.reporter.nih.gov/v2` live, 2026-06-26:

- **No email.** `principal_investigators[]` returns `profile_id, first_name, middle_name,
  last_name, full_name, is_contact_pi, title` — and nothing else. The "email" field in NIH's
  data-elements PDF is **not populated** in the v2 response. So there is no PII handshake.
- **No ORCID** field at all.
- `org_ipf_codes` / `core_project_nums` as *project* criteria are unreliable (IPF returned the
  whole 2.94M-row corpus). Use `org_names`, `pi_names`, `pi_profile_ids` for projects;
  `core_project_nums` is valid on the **publications** endpoint.

The only stable person key is the eRA Commons **`profile_id`**. So the design resolves a
`profile_id` once per person, then pulls everything.

## 3. Design decision — DECIDED 2026-06-26: persist via ETL, surface on profile + CV

**Decision (user):** RePORTER grants surface on the **public profile + search**, not just the CV,
with sensible defaults and user overrides. That requires persisting them as `Grant` rows
(`source='RePORTER'`) materialized by ETL — NOT the CV-time ephemeral fetch below.

Why this is the right trade despite re-opening #767: persisting into the existing `Grant` table
makes the existing machinery work for free —
- `funding-card.tsx` + `Suppression` → hide / un-hide (both directions, see §6c)
- `lib/funding-projection.ts` → search index
- `components/profile/grants-section.tsx` → Active/Completed rendering
- `field-source-line.tsx` → the provenance marker

Cost, accepted deliberately: a second grant source (the #767 concern), so the public
*"InfoEd = system of record for all sponsors"* statement must be updated, and the matcher (#1306)
+ dedup (§6a) run in **ETL** (extend `etl/nih-profile`/`etl/reporter`), using `person_nih_profile`
+ local PMID sets — all available there. The CV then just reads the materialized rows.

### 3a. Rejected alternative — fetch-at-generation, zero persistence (kept for reference)

The CV-only version: fetch live at CV time, dedup in-memory, render into one document, persist
nothing — sidestepping #767 entirely. Superseded by the profile-scope decision above; still the
right fallback if the profile rollout is ever deferred. `// ponytail: don't build both — profile path subsumes the CV path.`

## 4. profile_id resolution (the only hard part)

Three sources, in priority order. **v1 ships sources 1–2 only.**

| # | Source | Covers | Reliability | Build |
|---|--------|--------|-------------|-------|
| 1 | Existing `person_nih_profile` (cwid→nihProfileId, `prisma/schema.prisma:453-489`, populated by `etl/nih-profile`) | WCM PIs already mapped | High (already curated, #766 cleanup applied) | reuse |
| 2 | Manual entry — curator/person pastes RePORTER profile URL or eRA Commons ID; extract `profile_id` | external/MSK/prior-institution people not in #1 | Authoritative (human-asserted) | v1 |
| 3 | PMID-overlap auto-suggester (§5) | unmatched people, to pre-fill #2 | Medium; **suggest only, never auto-lock** | **v2, deferred** |

`person_nih_profile` PK is `(cwid, nihProfileId)` — already supports a person having **multiple**
profile_ids; union projects across all confirmed ids for that cwid.

v1 store: persist manual (source-2) ids in `person_nih_profile` with a `source` marker
(`'reporter-walk' | 'manual'`) so they survive the next `etl:nih-profile` reconcile instead of
being tombstoned. `// ponytail: one column, not a new table.`

## 5. PMID-overlap matcher (v2, deferred — spec'd so v1 manual entry has an upgrade path)

Disambiguates a name to a profile_id using the pub record we already trust. **Suggests; a human
confirms before the id is stored.**

```
Input:  P = person's PubMed PMID set (from SPS pub data); name = {last, first}
1. candidates ← POST /v2/projects/search {pi_names:[{last_name,first_name}]}
                include ProjectNum, Organization, PrincipalInvestigators
                → distinct {profile_id, orgs[]}        # orgs give the reviewer context
2. for each candidate c:
     coreNums_c ← distinct core_project_num over c's projects
     pmids_c    ← union POST /v2/publications/search {core_project_nums: coreNums_c} .pmid
     overlap_c  ← | pmids_c ∩ P |
3. pick c* = argmax overlap_c IF overlap_c* ≥ K (default 3)
            AND overlap_c* ≥ 2 × overlap_(2nd)   # clearly separated from runner-up
   else → no suggestion, fall back to manual entry
Output: suggested profile_id + the matched PMIDs as evidence (shown to confirmer)
```

Verified API behavior backing this: `/publications/search {core_project_nums:["R01AI176943"]}`
returns `{coreproject, pmid, applid}` rows; `pi_profile_ids` returns a person's full project set.

Tunables (constants, not config): `K`, separation `2×`. `// ponytail: hard-coded; surface only if a real false-match shows up.`

**Empirical calibration (prototype, N=50 WCM scholars w/ ground-truth profile_ids, 2026-06-26):**
- **0 wrong suggestions at every K from 1–5. Precision 100% throughout.**
- **In 50 people, a runner-up candidate NEVER scored any PMID overlap (0/50 contested).** A
  same-name different person's grants cite *their* pubs, disjoint from ours — PMID is a near-perfect
  discriminator. The 2× separation gate never had to fire (free insurance, keep it).
- Recall 70% (K=1–2) → 62% (K=3) → 58% (K=5). Lowest *correct* overlap was 2, so **K=2 captures
  all available recall at 100% precision**; K=3 is the conservative silent-auto-lock floor.
- **Recall is capped at ~70% by NAME RESOLUTION, not by K.** The 4 misses were name-parse failures
  (`van Besien`→"Besien", maiden/married surname, 0 candidates), not bad matches. Two levers, both
  free here: (a) use ReCiter's structured first/last, not full_name token-splitting; (b) seed
  candidates from existing `person_nih_profile` (resolution source #1) — which already holds the
  exact profile_ids the name-matcher missed. **The matcher is the fallback for people NOT already
  mapped (i.e. external/MSK), where #1 is empty.**
- Caveat: ground truth here is WCM people (in prod, resolved by source #1 anyway). PMID overlap is
  institution-agnostic so it should transfer to external people, but that recall is unmeasured.
- **Recommendation: K=3 for silent auto-lock (100%/62%); show ranked candidates down to K=2 for
  human confirm (100%/70%).**

## 6. Fetch + assemble (at CV generation, given confirmed profile_id[s])

```
projects ← POST /v2/projects/search {pi_profile_ids: ids}
           include ProjectNum, CoreProjectNum, FiscalYear, ActivityCode,
                   ProjectStartDate, ProjectEndDate, AwardAmount,
                   AgencyIcAdmin, Organization, PrincipalInvestigators, ProjectTitle
           paginate by fiscal_year if a set exceeds the 14,999 offset cap   # see §8
dedupe:   see §6a — core-match alone is WRONG (verified). Use family+org rule.
label:    net-new = grants InfoEd lacks; carry organization.org_name + fiscal years.
          A net-new grant at a NON-WCM org → "prior-institution"; at a WCM org →
          "WCM history InfoEd dropped" (both are real value — see §6b).
group:    by family key (§6a), collapse renewal years (same as grants-section.tsx does)
render:   into the CV grants section, sorted by most-recent fiscal_year
```

Bonus over InfoEd: RePORTER returns `award_amount` (the SPS `Grant` schema has no `$`), so
external grants can show amounts if the CV template wants them.

### 6a. Dedup rule (validated against real grant data 2026-06-26 — DO NOT simplify to core-only)

Tested on Liston/Glesby/Fei Wang local grant rows. Core-project-num alone produces wrong CVs:

1. **Fix the key first.** `lib/award-number.coreProjectNum()` has a bug: its regex
   `(?:[-\s]\w+)?$` allows only ONE trailing token, so `5 R34 HL117352-02 EW` (annotation
   suffix) returns `null` → the grant looks net-new when InfoEd has it. **This also breaks the
   existing `etl/reporter` enrichment join today** (those grants get no abstract/keywords). Fix:
   `?` → `*` (`(?:[-\s]\w+)*`). One char, separate small PR — see §11.
2. **Exact `core_project_num` match → drop** (true duplicate; InfoEd wins, richer role/sponsor).
3. **Phased-family check.** Compute `family = IC + serial` (drop the activity code). NIH phased
   awards share a family but differ by activity code, so step 2 misses them:
   - RePORTER `UH3HL154944` vs InfoEd `UG3 HL154944` (DEPTH trial) — **same org (WCM) → drop**, one grant.
   - RePORTER `K99MH097822` (Stanford) vs InfoEd `R00 MH097822` (WCM) — **different org → KEEP**
     as a distinct prior-institution line (the K99 mentored phase is a real separate CV entry).
   Rule: same family in InfoEd AND same grantee org → drop; different org → keep as net-new.
4. Everything else RePORTER-only → net-new.

`// ponytail: family+org is the minimum that's actually correct — verified core-only mislabels real grants. Don't shrink it.`

### 6b. The value is bigger than "prior institution" — InfoEd has a historical floor (confirmed)

Glesby's pre-2012 WCM grants (e.g. `R01DK065515` 2004-07, `K24AI078884` 2008-12) are in RePORTER
but ABSENT from InfoEd's current export (his earliest InfoEd row is a 2008 budget period of a
1990s grant). So RePORTER backfills WCM's own dropped history, not just lateral-recruit grants.
This kills the earlier "only import non-WCM org" shortcut — it would discard real WCM awards.

### 6c. Profile/CV UI — defaults & overrides (DECIDED 2026-06-26)

Two default gates, then user overrides. All reuse existing machinery — no new models.

**Default gate 1 — confidence.** Only auto-materialize grants from a **K=3 auto-locked**
profile_id (§5). K=2 candidate profile_ids surface in `/edit` as "Is this you?" and materialize
only on confirm (the `core-claim` accept/reject pattern, one domain over).

**Default gate 2 — recency. `RECENCY_YEARS = 25`** (decided from data, not guessed). Net-new grants
are inherently OLD — measured median age **16y** across a 30-scholar sample (prior-institution
median 14y, InfoEd-dropped WCM history median 20y), because earlier-career/prior grants are the
whole point. So a tight window guts the feature: 15y shows only 43% of net-new (9/14 people keep
any), 20y → 69% (13/14), 25y → 82% (13/14). The real objection is the **1980s–90s tail** (~18%
are 20y+), not "anything old". So: **materialize ALL net-new grants** (cheap, ~10–30 rows/person,
RePORTER floor FY1985 — Petsko 1985–2026) but **default-display only those with last fiscal year
within 25 years** (since ~2001). Older → `/edit` "N earlier grants found — add to profile?".
Metric = `NOW − max(fiscal_year)`, so a long-running grant (ran 1995–2025) stays visible; one that
ended 1990 is hidden. `// ponytail: RECENCY_YEARS is one constant; rolling, not a calendar anchor. RePORTER rows only — InfoEd keeps Active/Completed. Optional most-recent-3 floor if blanking a recruit (1/14 here) ever matters.`

**Overrides — `Suppression` already does both directions:**
- Hide a shown grant → create a `Suppression` row (existing funding-card behavior).
- Show a default-hidden old grant → it's materialized with a system `Suppression`
  (`createdBy='system-recency'`); the user **revokes** it to surface. One table, both ways.
- "Not mine" (matching error) → same Remove action with a structured `reason`; a RePORTER
  "not mine" feeds matcher QA, and rejecting most of a profile_id's grants signals to unlink it.

**Provenance:** `field-source-line` marks RePORTER vs InfoEd. Correction path differs by source:
InfoEd → `request-change` to Sponsored Research (SOR); RePORTER → in-app "not mine" reject.
Update the public About provenance statement to stop claiming InfoEd is the sole grant source.

## 7. Edge cases

| Case | Behavior |
|---|---|
| No NIH awards for person | No profile_id; CV grants = InfoEd-only (or empty). Expected, not an error. |
| Common name, few pubs | Matcher can't separate → no suggestion → manual entry required. |
| Person split across multiple profile_ids | Union projects across all confirmed ids (PK already allows it). |
| RePORTER project == existing InfoEd grant | Dedup per §6a (family+org), not core-only; InfoEd wins. |
| Co-I / Key-Personnel-only grant | RePORTER reliably attributes PI/MPI only → under-covered. Documented limit, not fixable here. |
| Phased award (UG3↔UH3, K99↔R00, R61↔R33) | Different core_project_num, same family (IC+serial). §6a: same org → drop; different org → keep (cross-institution phase is a real CV line). |
| Non-NIH grant (NSF/DoD/foundation/industry/MSK-internal) | Out of scope — RePORTER is NIH-family only. CV grants section is the *federal* slice; label accordingly. |

## 8. Operational limits

- **NIH-family only**: NIH/CDC/FDA/ACF. Set CV-section expectations ("Federal (NIH) grants").
- **Rate limit**: ≤1 req/s, large jobs off-hours. A single CV = a few requests; fine. If a
  profile_id→projects cache is added, key it by profile_id (projects change ~yearly).
- **Offset cap**: 14,999 per result set; per-person sets are tiny, so only the candidate-by-name
  step could approach it for very common names — chunk by fiscal_year there (the existing
  `etl/nih-profile/fetcher.ts` already does this).
- **Live dependency at export time**: if RePORTER is down, CV still generates with InfoEd grants
  + a "federal grants unavailable" note. Never block the whole CV on this.

## 9. Files (v1)

- `lib/edit/reporter-grants.ts` — resolver (sources 1–2), fetch, dedup, assemble. ~1 file.
- consumed by `lib/edit/cv-export.ts` (CV spec) grants section.
- profile_id input + (v2) confirm UI: a field in `components/edit/cv-tool.tsx` (CV spec).
- No new flag (rides the CV generator's `EDIT_CV_EXPORT`). No schema change in v1 beyond the
  `person_nih_profile.source` marker if not already present — verify on origin/master first.

Self-check: one `test_*` asserting (a) dedup drops a core_project_num present in InfoEd, and
(b) the matcher rejects a candidate below K overlap.

## 10. Open decisions

1. **v1 scope** — ship manual profile_id entry only, defer the PMID matcher (recommended), or
   build the matcher now?
2. **Amounts** — show RePORTER `award_amount` on external grants, or omit $ for parity with the
   InfoEd-sourced (amount-less) grants already on the CV?
3. **Confirm authority** — who may confirm/enter a profile_id for a given scholar: the scholar
   only, or the same actor set as the biosketch/CV tool?
4. **Cache** — fetch-every-time (simplest) vs cache profile_id→projects (faster, one more moving
   part). Default: fetch-every-time until latency complains.

## 11. Found bug — `coreProjectNum` regex (standalone, ship independently)

`lib/award-number.ts` `NIH_AWARD_RE` suffix group `(?:[-\s]\w+)?` matches only ONE trailing
token, so award numbers with an annotation suffix (`5 R34 HL117352-02 EW`) return `null` from
`coreProjectNum()`/`parseNihAward()`. Impact **today** (not just this spec): `etl/reporter` joins
InfoEd grants to RePORTER on `coreProjectNum`, so these grants silently get NO abstract/keyword/MeSH
enrichment. Fix = `?`→`*`: `…(\d{6,7})(?:[-\s]\w+)*\s*$`. Add a parse test for the `… -02 EW` shape.
Independent of the CV work — worth a tiny PR on its own.

## 12. ETL materialization (the build, given the profile-scope decision)

New ETL step `etl/reporter-grants` (own module — `etl/reporter` is enrichment of existing rows;
`etl/nih-profile` resolves profile_ids; this one CREATES grant rows). It turns confirmed
RePORTER profile_ids into `Grant` rows the existing profile/search/edit stack already renders.

**Inputs per scholar:**
- Confirmed profile_id(s) — from `person_nih_profile`. Gate by confidence: materialize only
  `resolution_source ∈ {auto-lock (K=3), manual, confirmed}`. A K=2 candidate stays a `/edit`
  "Is this you?" prompt until confirmed (it is NOT written by ETL). For scholars NOT in
  `person_nih_profile` at all (pure external/MSK — e.g. a brand-new recruit with no WCM grant
  yet), resolution runs the matcher (#1306 `rankByPmidOverlap`) over local PMID sets; auto-locks
  feed materialization, suggestions feed the `/edit` prompt.
- That scholar's InfoEd `Grant` rows (for dedup) and PubMed PMID set (for matcher only).

**Per scholar:**
1. Fetch `pi_profile_ids` projects (paginate by FY past the 14,999 cap; reuse `etl/nih-profile/fetcher`).
2. Group by `core_project_num`, collapse fiscal years → min/max dates, sum `award_amount`, org.
3. `dedupeAgainstInfoEd` (#1306, §6a) → net-new only.
4. Build a `Grant` row per net-new core:
   - `id = "reporter:" + cwid + ":" + coreProjectNum` (deterministic → idempotent upsert)
   - `source = "RePORTER"`, `cwid`, `title`, `role = "PI"` (RePORTER attributes PI/MPI only),
     `funder`/`nihIc`/`mechanism` via `parseNihAward`, `startDate`/`endDate` from project dates,
     `awardNumber = project_num`, `awardAmount` (bonus — InfoEd rows have none), org for labeling.
5. **Recency (§6c):** if `NOW − maxFiscalYear > RECENCY_YEARS (25)`, also write a system
   `Suppression` (`entityType=grant`, `entityId=id`, `contributorCwid=cwid`,
   `createdBy="system-recency"`, `reason`) → default-hidden, user-revocable to surface.
6. **Reconcile (ADR-005 pattern):** upsert by deterministic id; delete `source='RePORTER'` rows
   for this cwid no longer returned (profile_id unlinked, or grant aged out of fetch). Never
   touch `source='InfoEd'` rows. A user "not mine" `Suppression` survives reconcile (and on
   re-add the row stays suppressed).

**Orchestration (`etl/orchestrate.ts`):** insert AFTER `infoed` (dedup needs InfoEd rows) and
`nih-profile` (needs profile_ids), BEFORE `funding-projection` + search rebuild (so new rows index).
Per-source try/catch — a RePORTER outage must not fail the nightly.

**Rollup exclusion (REQUIRED):** dept/division Grants tabs (`lib/api/dept-lists.ts`) and the center
collaboration grant axis (`lib/center-collaboration/grants.ts`) assume WCM-administered active
awards. They MUST filter `source='InfoEd'` (exclude RePORTER) — these are individual-profile
history, not WCM-administered grants, and prior-institution rows would corrupt the rollups.
Person-card grant COUNTS likewise count InfoEd only (or label the RePORTER delta separately).

**Provenance:** update the public About line ("InfoEd … system of record for all sponsors") to
name RePORTER as a second grant source; `field-source-line` already distinguishes per row.

**Search-suppression reflection:** system-recency `Suppression` rows must reflect into the funding
index via the existing reconciler so default-hidden grants don't surface in `/search?type=funding`.

`// ponytail: ONE new ETL module + a source filter on 2 rollup queries + 1 About edit. Everything else (Grant table, Suppression, funding-projection, grants-section, funding-card) already exists.`

## Appendix — runnable probes (sanity-check the mechanism)

```bash
# PI object has no email/orcid — only profile_id + name + title:
curl -4 -s -X POST https://api.reporter.nih.gov/v2/projects/search \
  -H 'Content-Type: application/json' \
  -d '{"criteria":{"org_names":["WEILL MEDICAL COLL OF CORNELL UNIV"]},"include_fields":["PrincipalInvestigators"],"limit":1}'

# grant → PMID links (the disambiguator):
curl -4 -s -X POST https://api.reporter.nih.gov/v2/publications/search \
  -H 'Content-Type: application/json' \
  -d '{"criteria":{"core_project_nums":["R01AI176943"]},"limit":5}'

# full project history for one person (org varies per award if they moved):
curl -4 -s -X POST https://api.reporter.nih.gov/v2/projects/search \
  -H 'Content-Type: application/json' \
  -d '{"criteria":{"pi_profile_ids":[10502557]},"include_fields":["ProjectNum","FiscalYear","Organization"],"limit":50}'
```
