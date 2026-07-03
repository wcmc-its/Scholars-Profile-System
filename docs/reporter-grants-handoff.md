# RePORTER historical-grants backfill — handoff (2026-06-26)

How to continue the RePORTER → SPS grant-backfill work. Full design is in
`docs/reporter-grants-matcher-spec.md`; this is the orientation + next steps.

## Why this exists

The CV generator (and the public profile) need a *complete* grant list per scholar.
SPS `Grant` rows come only from **InfoEd = WCM-administered awards**, so they miss:
- grants a **lateral recruit** held at a prior institution (e.g. a dean from Stanford), and
- **older WCM history** InfoEd dropped (its export has a real floor — confirmed: senior PIs'
  pre-2010 grants are absent from InfoEd but present in RePORTER).

NIH RePORTER has both, keyed to the investigator across institutions. We backfill from it.

## Decisions locked (don't relitigate)

| Topic | Decision | Why |
|---|---|---|
| Blanket import? | **No.** Only for the CV/profile use case. | #767 (closed) no-built a general import. |
| Scope | **Public profile + search + CV**, with sensible defaults + user overrides. | User call 2026-06-26. |
| Persistence | **Persist as `Grant` rows (`source='RePORTER'`) via ETL** — NOT CV-time ephemeral fetch. | Reuses funding-card/Suppression/projection/grants-section for free. Re-opens #767 deliberately. |
| Person key | eRA `profile_id`. **RePORTER API exposes NO email, NO ORCID** (probed — don't re-probe). | profile_id is the only stable cross-institution key. |
| v1 resolution | `person_nih_profile` confirmed profile_ids only. | Safe; matcher needs a confirm UI first. |
| Matcher (v2) | PMID-overlap: intersect a candidate's grant-linked PMIDs with the scholar's trusted PubMed set. | Validated 100% precision (see below). |
| Confidence | K=3 auto-lock; K=2 → `/edit` "Is this you?" confirm. | From the validation sweep. |
| Recency | `RECENCY_YEARS = 25` — default-display grants whose last FY is within 25y; older default-hidden, revocable. | Data-driven: net-new grants median age 16y; 25y keeps ~82%, hides the 1980s–90s tail the user objected to. |
| Overrides | Reuse `Suppression` **both directions** — user hides; system-recency hides are user-revocable. | No new model. |
| Rollups | RePORTER grants **excluded** from every unit-level aggregation/count. | They're individual history, not WCM-administered. User-agreed hard requirement. |

## Verified facts (don't re-derive)

- **RePORTER API** (`api.reporter.nih.gov/v2`): `principal_investigators[]` = profile_id / names /
  title / is_contact_pi only (no email, no ORCID). `pi_profile_ids` → full cross-institution
  history. `/publications/search {core_project_nums}` → `{coreproject, pmid, applid}` (the
  matcher's disambiguator). Coverage floor **FY1985**. Offset cap 14,999 → paginate by FY.
- **Matcher validation** (N=50 WCM scholars, ground truth = `person_nih_profile` +
  `publication_author` PMID sets): **0 wrong suggestions at every K=1–5 (precision 100%)**; a
  runner-up candidate scored PMID overlap in **0/50** (PMID is a near-perfect discriminator);
  top-1 rank 46/50 (92%); the 4 misses were **name-resolution** failures (`van Besien`→0
  candidates), not mismatches. Recall is name-resolution-bound, not K-bound.
- **Dedup** (`§6a`, verified on real rows): exact `core_project_num` → drop; then phased-family
  (IC+serial, drop activity code) + org — same-org sibling drops (UG3/UH3, Glesby DEPTH trial),
  different-org sibling kept (K99@Stanford vs R00@WCM, Liston). Core-only dedup is WRONG.
- **Bug found + fixed:** `lib/award-number.coreProjectNum()` regex matched only one trailing
  suffix token, so `5 R34 HL117352-02 EW` returned null — silently breaking the *existing*
  `etl/reporter` enrichment join. Fixed in #1305.

## Shipped this session

| PR | What | State | Base |
|---|---|---|---|
| **#1305** | `coreProjectNum` regex fix + tests | **ready, CI-green** | master |
| **#1306** | `lib/edit/reporter-grants.ts` — matcher + dedup core (pure, tested) | draft, CI-green | master |
| **#1307** | `etl/reporter-grants` materialization + rollup exclusion + provenance | draft | **#1306** (stacked) |

**Merge order:** #1305 → un-draft + merge #1306 → retarget #1307 to master + merge.
After #1306 merges, retarget: `gh pr edit 1307 --base master` (GitHub usually auto-retargets).

## What's left, in priority order

1. **Per-row provenance label (PUBLIC-ROLLOUT BLOCKER).** #1307 deferred showing "via RePORTER /
   prior-institution" per grant — it needs plumbing `Grant.source` through
   `ProfilePayload → grants-section.tsx` (and `edit-context → funding-card`), which don't carry it
   today. Until then a materialized Stanford grant renders indistinguishably from a WCM one. The
   About page is updated, but the **per-row** marker is the transparency half of §6c and must land
   before flipping this on publicly. Reuse `field-source-line.tsx`.
2. **Live-DB run + verify.** #1307 is unit-tested only. Run `npm run etl:reporter-grants` against a
   real DB (or a one-off `run-task` per `project_sps_prod_db_readonly_query` pattern — but this
   WRITES, so staging) and confirm: net-new rows materialize, recency suppressions created, a
   known recruit (e.g. check Liston's K99 Stanford row), rollups still exclude them, reconcile is
   idempotent on a second run.
3. **CI on #1307** once #1306 is mergeable.
4. **v2 — matcher in ETL + `/edit` confirm UI.** Wire `rankByPmidOverlap` (#1306) into the ETL for
   scholars NOT in `person_nih_profile` (the pure-external/recruit case). Auto-lock (K=3)
   materializes; K=2 surfaces an "Is this you?" card in `/edit` (reuse the `core-claim` pattern)
   before materializing. This is what actually serves the Harrington/recruit case end-to-end.
5. **CV generator integration.** The CV work (`docs/scholar-cv-generator-spec.md`, separate
   worktree branch) reads these materialized rows for its grants section. Coordinate.
6. **Structured "not mine" reason** feeding matcher QA (reject most of a profile_id → unlink it),
   and update the About data-dictionary correction cell to mention the in-app hide for RePORTER
   rows (currently only routes to Sponsored Research, the InfoEd path).

## Landmines

- **Stacked PRs:** #1307 imports #1306's `dedupeAgainstInfoEd`. Branch #1307 off #1306, not master.
- **Stale generated Prisma client:** a local full `tsc` shows pre-existing `prestige`-column errors
  from the symlinked `lib/generated` (built off an older schema). CI regenerates the client, so
  those are noise — filter tsc output to your touched files. Don't `npx prisma generate` through a
  symlinked worktree (it writes into the canonical checkout).
- **Rollup exclusion is ~10 sites, not 2.** The reviewer found dept-lists, center-collaboration,
  centers, departments, divisions, dept-highlights, unit-members, search-index-docs,
  data-quality, and popover-context (hover `_count` + active-grants). Any NEW grant aggregation
  must also filter `source != 'RePORTER'`. Grep for `.grant.` aggregations before adding one.
- **`RECENCY_YEARS = 25`** lives in `etl/reporter-grants/transform.ts` (one constant, rolling).
- **Worktrees on this Dropbox repo:** symlink `node_modules` + `lib/generated` from the canonical
  checkout; commit explicit paths only (never the symlinks); `git worktree remove --force` +
  `pkill -f 'vitest|esbuild|tinypool'` when done. Branch off fresh `origin/master`.
- **Subagents must not merge/push** — only the main loop commits.
- **Branch drift:** this doc + the spec sit on `docs/spotlight-pipeline` (behind master). Re-ground
  code refs via `git show origin/master:<path>` for anything that's merged.

## Pointers

- Spec: `docs/reporter-grants-matcher-spec.md` (§3 scope, §5 matcher+calibration, §6a dedup,
  §6b InfoEd floor, §6c defaults/overrides, §11 regex bug, §12 ETL).
- Matcher core: `lib/edit/reporter-grants.ts` (#1306). ETL: `etl/reporter-grants/` (#1307).
- Validation prototypes (Python, stdlib, ephemeral scratchpad — methodology, not committed):
  `reporter_match.py` (matcher), `cohort_run.py`/`analyze.py` (the N=50 sweep),
  `dedup_demo.py` (dedup on real rows), `recency_analysis.py` (the age distribution). Re-derive
  from the spec if gone.
- Memory: `project_scholar_cv_generator_spec.md` (grants section).
