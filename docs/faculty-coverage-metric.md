# Faculty coverage metric — how much of the faculty the algorithmic surfaces reach

**Question this answers.** *"What share of full-time faculty does the Scholars Profile
System actually surface in one of its algorithmic contexts — a Spotlight, a methods/tools
expertise listing, or a research-area expert ranking?"* Use it for About-page copy,
stakeholder/leadership questions, and as a coverage health check as the data grows.

It is a **measured** number with a **repeatable method**, not a marketing estimate. The
probe reuses the app's own scoring/eligibility/suppression code, so the counts match what a
visitor actually sees rather than a re-derived approximation.

---

## The three signals

All three are restricted to the **full-time-faculty population** (the denominator):
`scholar.role_category = 'full_time_faculty' AND deleted_at IS NULL AND status = 'active'`
(the carve in `lib/eligibility.ts`).

| Signal | What it means | Backing (grounded in code) |
|---|---|---|
| **A. Spotlight** | Author on a surviving (non-suppressed) paper in any `spotlight` row — the home "Selected research" rotation. | `spotlight.papers[]` → `publication_author`, minus dark/suppressed pmids (`lib/api/home.ts`, `lib/api/manual-layer.ts`). |
| **B. Methods / tool expertise** | Has ≥1 method-family or tool row with `pmid_count > 0` — the **Methods & tools** lens. | `scholar_family` / `scholar_tool` (`lib/api/methods.ts`). |
| **C1. Research-area expert** | Ranks in a topic's **Top scholars** list — top 7, hidden if fewer than 3 qualify. The *selective* "expert" surface. | `publication_topic`, FT-only, first/last author, year ≥ 2020, recency-weighted `top_scholars` curve (`getTopScholarsForTopic`, `lib/api/topics.ts`). |
| **C2. Subtopic rail** | Ranks in a subtopic's scholar rail — top 10, floor 1. The *inclusive* "ranked contributor" surface (broader than C1; **not** "expert"). | Same carve, per-subtopic (`getSubtopicScholars`). |

The denominator and the C-signal ranking use the same constants the app uses
(`TOP_SCHOLARS_TARGET = 7`, `TOP_SCHOLARS_FLOOR = 3`, `RECITERAI_YEAR_FLOOR = 2020`,
`scorePublication(…, "top_scholars", …)`), so a row counts only if the scholar is actually
displayed on that surface.

---

## Results — staging, 2026-06-19 (n = 2,416 full-time faculty)

| Signal | Count | % of FT faculty |
|---|---|---|
| A. Spotlight snippet | 184 | 7.6% |
| B. Methods / tool expertise | 1,311 | 54.3% |
| C1. Research-area expert (topic top-7) | 240 | 9.9% |
| C2. Subtopic rail (ranked contributor) | 1,201 | 49.7% |
| **Union A∪B∪C1∪C2 (any surface)** | **1,362** | **56.4%** |
| Union A∪B∪C1 (selective) | 1,324 | 54.8% |
| Union without methods-lens (A∪C1∪C2) | 1,213 | 50.2% |
| Union without methods-lens, selective (A∪C1) | 361 | 14.9% |

**Headline: ~56% of full-time faculty surface in at least one algorithmic context on
staging.**

### Reading it honestly

- **Not an additive stack.** Methods/tools alone is 54.3% and largely subsumes the
  others — the full union adds only ~2 points. Phrase it as "more than half," never as
  "X% + Y% + Z%."
- **"Expert" means the top-7 surface (10%), not the subtopic rail (50%).** Calling the
  ~50% C2 figure "experts" overstates it; that population is "ranked contributor in a
  research area." Reserve "expert" for C1.
- **Methods-lens is environment-dependent.** Signal B only populates where the
  methods-lens backfill has run — **staging yes, prod not yet** (see
  `methods-lens-prod-golive-runbook.md`). If a public claim must reflect prod before that
  rollout, use the *without methods-lens* rows (~50% any-surface, ~15% selective). The
  probe prints both so you can pick the row matching the live environment at publish time.
- **Local ≈ staging.** A local snapshot reports the same denominator (2,416), so quick
  iteration can run locally; the authoritative number comes from staging.

---

## Recompute

Authoritative (against staging RDS, no image roll — injects the read-only script into the
staging ETL task's existing image):

```bash
scripts/run-staging-probe.sh scripts/faculty-coverage-metric.ts
```

Once this ships in the deployed image, the same run-task can call it by name
(`npm run metrics:faculty-coverage`). Against a local staging snapshot:

```bash
npm run metrics:faculty-coverage   # needs DATABASE_URL → a populated db
```

- Metric script: [`scripts/faculty-coverage-metric.ts`](../scripts/faculty-coverage-metric.ts)
- Generic staging-probe runner: [`scripts/run-staging-probe.sh`](../scripts/run-staging-probe.sh)
  (read-only scripts only; staging network config per `OPERATIONS-RUNBOOK.md §4`).
