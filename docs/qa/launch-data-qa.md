# Launch data-QA runbook — content smoke pass on the populated corpus

**Status:** Pre-launch gate (#576). Run after the prod corpus is populated (#483 / #443 / #488) and indices are built, **before** the public flip. Repeatable; also run before each staging cutover. Closes the Gate A "launch data-QA" technical item on [#506](https://github.com/wcmc-its/Scholars-Profile-System/issues/506) and feeds the Gate B functional-owner sign-off.

The rest of the launch chain proves the **pipes** work — #554 (latency/throughput), #426/#488 (deploy + indices exist + 200s), #574 (SEO baseline). This runbook is the only thing that verifies the **content is presentable**: real profiles render correctly, attributions aren't obviously wrong, counts are sane, and the suppression / hiding / exclusion rules actually took. For a faculty-facing launch the first impression is reputational — a green health check is not the same as good-looking content.

This is a **sample-based** smoke pass, not an exhaustive audit. It is **read-only** except where a section is explicitly marked *staging-only round-trip*. Do not write test data to prod.

> **⚠️ Launch precondition — retracted papers (#63 / #604).** The read-side exclusion of `Retraction` / `Erratum` is fully implemented, but in **prod** the `PubMedRetractions` ETL that *stamps* the type onto retracted originals does **not auto-run** — Step Functions schedules are disabled by design until launch (`docs/retracted-publications.md:100-104`). Until that step runs, residual retracted originals **stay visible in prod**. **Before this QA pass on prod, run `npm run etl:pubmed-retractions` then rebuild the search index**, or enable the nightly schedule. Confirm the residual count is zero (§4) before sign-off.

---

## When to run

- **Before the prod public flip** — the primary use; gates #506.
- **Before each staging cutover** — to catch corpus regressions early in the same environment the dashboard is enabled in.
- **After any ETL mapping / suppression-logic / index-schema change** that could alter what renders.

## Dependencies

- Populated prod Aurora + built OpenSearch indices — #483 (interim) / #443 / #488.
- `PubMedRetractions` run + reindex on the target env (see precondition callout above).
- Absorbs the real-data verification half of **#63**.

## Environment setup

```bash
export ENV=staging                 # or prod
export BASE=https://scholars-staging.weill.cornell.edu   # prod: https://scholars.weill.cornell.edu
export ACCOUNT=665083158573
export REGION=us-east-1
```

Record the **search-flag state** at QA time — ranking and evidence rendering are flag-dependent, so a result that looks wrong may just be a flag difference. Capture the values of at least: `SEARCH_PUB_MESH_ONLY_FILTER`, `SEARCH_RESULT_EVIDENCE`, `SEARCH_PEOPLE_MATCH_EXPLAIN`, `SEARCH_PUB_TAB_IMPACT`, `COAUTHOR_HIDDEN_STUDENT_CHIPS`, `EDIT_DATA_QUALITY_DASHBOARD` (from the running task-def env, e.g. `aws ecs describe-task-definition --task-definition sps-app-${ENV}` → `containerDefinitions[?name=='app'].environment`).

---

## 1. Select the sample set (reproducibly)

The sample must span roles, unit sizes, and completeness so the pass is representative. **Record the exact selection criteria** in the sign-off (§ sample-set record) so the sample is auditable and re-runnable.

**Preferred tool — the Data Quality dashboard (#1081), `/edit/data-quality`.** It is the operational tool for sourcing the sample. Its filters map directly onto the dimensions below:

- `?gap=no-overview` — sparse profiles (overview only seeded from VIVO, never edited).
- `?overviewAge=gt2yr` — stale overviews.
- `?gap=no-headshot` — leaders/faculty without photos.
- `?type=full_time_faculty` / `affiliate` / `emeritus` / `postdoc` — role strata.
- `?unit=dept:CODE` / `div:CODE` / `center:CODE` — unit strata.
- Default sort is by **prominence** (Dean → Deanery → Chair/Chief → score), so the top of the list is the highest-visibility, highest-reputational-risk set — sample those first.

> **Note — dashboard is prod-dark at launch.** `EDIT_DATA_QUALITY_DASHBOARD` is `on` for staging, `off` for prod. If it is still off at prod launch, source the sample from **staging** (same corpus shape) or fall back to `/browse` + manual `/edit` discovery on prod. Decide and record which you used.

**Sample dimensions to cover** (≈ 12–20 profiles total; roles from `lib/eligibility.ts`):

| Dimension | Target | How to find |
|---|---|---|
| Role — full-time faculty | 3–4 | dashboard `type=full_time_faculty`, top by prominence + a couple mid-list |
| Role — affiliated faculty | 1–2 | `type=affiliate` |
| Role — emeritus | 1 | `type=emeritus` |
| Role — postdoc / fellow | 1 | `type=postdoc` / `fellow` |
| Unit — large department | 2 | a chair/chief in the largest dept |
| Unit — small / sparse department | 1–2 | a one- or two-person unit |
| Org — a center | 1 | a center member (`unit=center:CODE`) |
| Completeness — full profile | 2 | overview + ≥3 pubs + active grants |
| Completeness — sparse profile | 1–2 | `gap=no-overview` |
| Prominence — a Dean / chair | 1–2 | top of the prominence sort |

Direct DB sampling (staging, read-only) is an alternative when the dashboard is unavailable — query the `Scholar` Prisma model on `roleCategory`, `deptCode`/`divCode`, center membership, `overview IS NULL`, `deletedAt IS NULL`. Treat any snippet as a starting point and confirm field names against `prisma/schema.prisma`.

---

## 2. Per-profile render correctness

For each sampled profile, open `${BASE}/scholars/<slug>` (or `${BASE}/<slug>` when `PROFILE_CANONICAL=root`) and eyeball the items below. The render targets live in `components/profile/profile-view.tsx` (loader `lib/api/profile.ts`).

- [ ] **Identity** — published name, primary title, post-nominal degrees, department/division correct.
- [ ] **Headshot** — present and correct person (or a clean placeholder, not a broken image).
- [ ] **Appointments** — active appointments only; title / org / year-range plausible.
- [ ] **Publications** — author-order badges correct (first / senior / middle, from `PublicationAuthor.position`); titles render; no obviously-foreign papers (wrong-person disambiguation).
- [ ] **Counts** — publication count and active-grant count are sane for the person (not 0 for a prolific PI, not absurdly high).
- [ ] **Research areas / topics** — present and on-topic; no empty or garbled chips.
- [ ] **Overview / synopsis** — reads cleanly; no truncation mid-word, no template artifacts, no obviously-stale facts.
- [ ] **Publication modal** — open one publication; author order and Impact render (Impact only when `SEARCH_PUB_TAB_IMPACT=on`).

Log any defect as a follow-on issue (see § follow-on issues) with the slug, the surface, and a screenshot. Defects do **not** block the flip unless egregious — they are filed and triaged.

---

## 3. Suppression round-trips (#160)

Suppressions are whole-entity or per-author takedowns in the `Suppression` table (`prisma/schema.prisma`), enforced per-request (never cached, ADR-005). Read-path enforcement: `lib/api/manual-layer.ts` (`loadPublicationSuppressions`, `isAuthorHidden`, `isPublicationDark`, `resolveDarkPmids`), grant suppression via `resolveActiveGrantSuppression` (used by `departments.ts` / `divisions.ts` / `centers.ts`), and the index build via `etl/search-index/index.ts` + `lib/search-index-docs.ts`.

**Read-only verify (use a *known-already-suppressed* entity):** from the `/edit` audit trail or a known case, pick one suppressed publication, one suppressed grant, and one suppressed (whole-scholar `status` ≠ `active`) person. Confirm each is absent from **every** surface:

- [ ] Suppressed **publication / author** — absent from the author's profile pub list, from `${BASE}/api/search?q=<title>&type=publications`, and not counted in the profile's pub count.
- [ ] Suppressed **grant** — absent from the scholar's profile and from the department/division/center grant listings and counts.
- [ ] Suppressed **person** — `${BASE}/scholars/<slug>` returns 404; absent from people search and browse.

**Optional staging-only round-trip:** on **staging**, suppress a throwaway entity via the `/edit` UI (not raw SQL), confirm it disappears from the surfaces above, then **revoke** it and confirm it reappears. Do **not** do this on prod.

> **Spot-check — search-reflection sentinel.** Suppression immediacy on the OpenSearch fast-path depends on `Suppression.searchReflectedAt` (the #393 reconciler). If a suppressed item still appears in *search* (but is correctly gone from the profile), confirm the reconciler ran / the index was rebuilt after the suppression write. File a follow-up if search lags the profile.

---

## 4. Retraction / Erratum exclusion (#63 / #604)

`Retraction` and `Erratum` publication types are excluded everywhere via `NEVER_DISPLAY_TYPES` (`lib/publication-types.ts:17`), applied in `lib/api/profile.ts`, `lib/api/topics.ts`, `lib/api/home.ts`, `lib/api/methods.ts`, and the index build `lib/search-index-docs.ts`. The exclusion only fires once a retracted original has been **stamped** with the type by the `PubMedRetractions` ETL (`cdk/lib/etl-stack.ts:773`).

- [ ] **Precondition met** — `npm run etl:pubmed-retractions` has run on this env and the index was rebuilt since (see launch-precondition callout). Confirm residual count:
  ```sql
  -- against the target env DB (read-only); expect ~0 (only arrivals since the last run)
  SELECT COUNT(*) FROM publication WHERE publication_type IN ('Retraction','Erratum');
  ```
- [ ] **Read-side holds** — pick a known-retracted PMID (recent examples in `docs/retracted-publications.md`) and confirm it does **not** appear on any scholar profile, in the home feed, in topic pages, or in `${BASE}/api/search?q=<title>&type=publications`, and is not in any pub count.
- [ ] **Spotlight defense-in-depth** — confirm the live Spotlight artifact carries no retracted papers (§8). The SPS read path trusts the upstream artifact to be pre-clean; if a retracted paper surfaces in a spotlight, file a defense-in-depth follow-up to add an explicit type filter to `getSpotlights()`.

---

## 5. Doctoral-student hiding (#536) + co-author chip exception (#1026)

Doctoral students and `affiliate_alumni` are hidden from directed surfaces by `isPubliclyDisplayed()` (`lib/eligibility.ts`, prefix-hardened for `doctoral_student*`) and soft-delete (`Scholar.deletedAt`); the people index excludes them via `PEOPLE_INDEX_WHERE = { deletedAt: null, status: "active" }`. By design (#1026, flag `COAUTHOR_HIDDEN_STUDENT_CHIPS`) they may still appear as **non-linked** co-author chips on publications.

Pick a known doctoral-student CWID who co-authors with a faculty member:

- [ ] **No standalone profile** — `${BASE}/scholars/<student-slug>` returns 404.
- [ ] **Not in search / browse** — people search for the student's name and the relevant department/division listing do not surface them as a standalone scholar.
- [ ] **Not in algorithmic surfaces** — absent from home "recent contributions" / top-scholars and from spotlight author lists.
- [ ] **Allowed as a non-linked chip (only if `COAUTHOR_HIDDEN_STUDENT_CHIPS=on`)** — on the faculty co-author's profile, the shared publication lists the student as **plain text, not a link** (inspect the chip: no `<a>`/`<Link>`). If the flag is `off`, the student should be absent from the chip row entirely.
- [ ] **Record the flag state** — note whether `COAUTHOR_HIDDEN_STUDENT_CHIPS` is on/off in this env so the expected behavior above is unambiguous.

---

## 6. Impact is global, never author-relative (#316)

Impact is a single per-publication value (`Publication.impactScore`), rendered identically for every co-author — no per-author rescaling (`lib/api/profile.ts`, index fields in `lib/search-index-docs.ts`, modal in `lib/api/publication-detail.ts`).

- [ ] Pick a paper with ≥3 WCM co-authors. Confirm the Impact shown on co-author A's profile equals the value on co-author B's profile **and** the value in the search result for the same paper (identical, not merely similar).
- [ ] DB cross-check (read-only): `SELECT DISTINCT impact_score FROM publication WHERE pmid = '<PMID>'` returns exactly one value.

---

## 7. Search-result quality (no `match_all` regression)

Surfaces: `${BASE}/search?q=…&type=people|publications|funding`, the JSON `${BASE}/api/search`, and `${BASE}/browse`. A `match_all` regression looks like an undifferentiated dump — every hit at the same score, alphabetical/arbitrary order, facet counts that don't move with the query. "Good" is a ranked, query-specific, highlighted result set.

Run these canonical queries and confirm each looks ranked and relevant (record the flag state from § environment setup alongside the results):

- [ ] **Person name** — `?q=<a real faculty name>&type=people` → that person ranks at/near top; not the whole directory.
- [ ] **Department** — `?q=<a department>&type=people` → members of that department, ranked; facet counts reflect the query.
- [ ] **Topic / research area** — `?q=<a topic, e.g. immunotherapy>&type=publications` → on-topic papers, BM25-ranked, highlighted.
- [ ] **Method / family** — `?q=<a method, e.g. CRISPR>&type=people` → scholars tagged with that family (when methods-lens is enabled), ranked by match strength.
- [ ] **Misspelling** — `?q=<one char off, e.g. onclagy>&type=people` → fuzzy match or a graceful "no results / did you mean" affordance, not a silent empty dump.
- [ ] **Empty query / browse** — `?q=&type=people` → A–Z directory sorted by last name (#1107), **not** a relevance sort on an empty query.

---

## 8. Spotlight / Selected Research

The home "Selected research" section is a weekly ReciterAI editorial artifact loaded by `etl/spotlight/index.ts` into the `Spotlight` table and rendered by `getSpotlights()` (`lib/api/home.ts`); see `docs/spotlight-runbook.md`. Read-path exclusions confirmed in code: suppressions + `resolveDarkPmids`, per-author hides (`isAuthorHidden`), deleted/inactive scholars (`deletedAt: null, status: "active"`), and per-spotlight drop when no WCM authors resolve.

- [ ] **No retracted / suppressed papers** in any spotlight card (ties to §3/§4). Verify the live artifact is clean (per `docs/spotlight-runbook.md`, e.g. inspect the published `spotlight.json` for retracted titles).
- [ ] **Attribution correct** — each card's WCM author list matches the publication's actual confirmed, active, non-hidden WCM authors.
- [ ] **No half-empty cards** — a spotlight whose papers all get filtered is hidden entirely, not rendered sparse.

---

## 9. `/edit` loads for a real faculty CWID (#474)

- [ ] `${BASE}/edit/scholar/<cwid>` (a real faculty CWID) loads as a superuser (mode `superuser`) without error — the scholar's profile, suppression / highlights / COI panels, and editor lists render (route `app/edit/scholar/[cwid]/page.tsx`, loader `loadEditContext`). A logged-out request should redirect to SAML login, not 500.

---

## Done criteria (Gate A item on #506)

- [ ] Sample set selected and **recorded** (§ sample-set record) — stratified by role, unit size, prominence, completeness.
- [ ] §2 per-profile render correctness passed across the sample.
- [ ] §3 suppression round-trips verified (publication/author, grant, person).
- [ ] §4 retraction precondition met (residual count ~0) and read-side exclusion verified.
- [ ] §5 doctoral-student hiding verified (404 standalone; non-linked chip behavior matches flag state).
- [ ] §6 Impact identical across co-authors.
- [ ] §7 search quality verified on the canonical queries; no `match_all` regression.
- [ ] §8 spotlight exclusions + attribution verified.
- [ ] §9 `/edit` loads for a real CWID.
- [ ] Flag state at QA time recorded.
- [ ] Discrete follow-on issues filed for every content defect found (these do not block the flip; they are triaged).

## Sign-off (sample-based; feeds #506 Gate B functional-owner approval)

| Role | Name | Date | Env | Sample size | Result | Follow-on issues |
|---|---|---|---|---|---|---|
| Functional owner (Scholars) | Terrie | | | | ✅ pass / ⚠️ issues filed | |
| Engineering | | | | | | |
| Content / comms (optional) | | | | | | |

The functional-owner sign-off here is the artifact that feeds Terrie's Gate B approval on [#506](https://github.com/wcmc-its/Scholars-Profile-System/issues/506).

## Sample-set record (fill in — makes the pass auditable & re-runnable)

- **Environment / date:** _______
- **Flag state captured:** `SEARCH_PUB_MESH_ONLY_FILTER=…`, `SEARCH_RESULT_EVIDENCE=…`, `SEARCH_PEOPLE_MATCH_EXPLAIN=…`, `SEARCH_PUB_TAB_IMPACT=…`, `COAUTHOR_HIDDEN_STUDENT_CHIPS=…`, `EDIT_DATA_QUALITY_DASHBOARD=…`
- **Selection method:** dashboard filters used (e.g. `gap=no-overview&overviewAge=gt2yr`, prominence top-N) / `/browse` fallback.
- **Profiles sampled (slug / cwid · role · unit · why chosen):**
  1. _______

## Follow-on issues

File a discrete issue per content defect (slug + surface + screenshot). Do **not** hold the flip on individual content defects — they are triaged after. Hold the flip only on a systemic failure (e.g. retraction precondition not met, a suppression leak, a corpus-wide `match_all` regression).

## Known gaps / watch-items (revisit each run)

- **#63 prod ETL schedule** — retracted-original stamping does not auto-run in prod until launch (`docs/retracted-publications.md:100-104`); the §4 precondition covers it, but confirm it became part of the prod cutover sequence.
- **Spotlight retraction filter** — `getSpotlights()` trusts the upstream artifact; if §8 ever surfaces a retracted paper, harden with an explicit `NEVER_DISPLAY_TYPES` filter at read time.
- **Suppression search-reflection** — if search lags the profile on a suppressed item, the #393 reconciler / reindex is the cause (§3 spot-check).

---

*Pairs with `docs/data-population-runbook.md` (corpus load), `docs/spotlight-runbook.md` (spotlight artifact), and the #506 go-live tracker.*
