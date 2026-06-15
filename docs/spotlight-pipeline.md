# How Spotlight Is Generated and Updated

> **In one line:** ReciterAI ranks and selects subtopics monthly and writes LLM-generated ledes to
> S3 (`spotlight/latest`); this app's weekly ETL ingests the artifact by full replacement into the
> `Spotlight` table (a SHA256 check makes it a no-op when nothing changed), and pages render it
> read-only with live author re-resolution and dark-publication suppression.

Spotlight is a two-system pipeline: **ReciterAI** (Python/Bedrock) *generates* the editorial
cards and publishes them to S3; the **Scholars Profile System** (this repo) *ingests, stores,
and renders* them. There is no manual curation layer — Spotlight is read-only from the artifact.

## 1. Generation (ReciterAI → S3)

A 6-stage pipeline, orchestrated by `cli/backfill_spotlight.py` in the ReciterAI repo:

| Stage | Module | What it does |
|---|---|---|
| 1. Rank | `spotlight/pool_ranker.py` | Scans `TOPIC#` rows (DynamoDB) from the last **24 months**, sums the top papers' blended **article scores** (see below) per subtopic → top ~150 subtopics |
| 2. Select | `spotlight/rotation_selector.py` | Picks ~25 subtopics with **exponential decay** (τ = 12 weeks) against rotation history, plus parent-topic diversity |
| 3a. Lede | `spotlight/lede_generator.py` | Generates a 25–35 word institutional-voice lede via **Bedrock Opus** (`us.anthropic.claude-opus-4-7`), grounded in 2–3 papers' synopses. Prompt: `prompts/spotlight_synopsis_v0.md` |
| 3b. Critic | `spotlight/critic.py` | Validates each lede with deterministic regex + a **Haiku** LLM judge; retries up to 3×, else routes to a `SPOTLIGHT_REVIEW#` queue |
| 4. Gate | `spotlight/sensitive_gate.py` | Filters politically sensitive topics (vaccines, abortion, etc.) |
| 5/6. Assemble + Publish | `spotlight/assembler.py`, `publish.py` | Composes the artifact JSON, validates against `docs/spotlight.schema.json`, uploads to S3 |

### Scoring: impact, relevance, and the blend

Ranking and per-page selection lean on three ReciterAI scores. They mean different things and
are easy to conflate, so:

- **Impact score** — *"How important is this paper, in any field?"* A **global, per-publication**
  integer on a **0–100** scale, LLM-generated (Bedrock Sonnet 4.6, `IMPACT_PROMPT_V2`). It weighs
  originality, methodology, translational relevance, evidence of uptake, citation signals
  (NIH iCite percentile, RCR, counts), and venue prestige — with an explicit parity constraint so
  clinical and basic work are scored on the same bar. It is **not topic-specific**: one paper has
  one impact score everywhere. This is the only score that surfaces to users (rendered inline as
  `Impact: NN`).

- **Relevance score** — *"How well does this paper fit **this** topic?"* A **per-(publication,
  subtopic)** float on a **0.0–1.0** scale, LLM-generated (Haiku screening pass → Sonnet dense
  pass), stored as the `score` attribute on each `TOPIC#` row. Calibrated roughly as: 0.1–0.2
  tangential mention, 0.3–0.5 secondary relevance, 0.6–0.8 a core theme, 0.9–1.0 the paper's
  primary focus. It measures **topic-fit only, never importance**, and is **internal ranking math
  — never displayed**.

- **Article score (the blend)** — the single source of truth for *"how good is this paper **for
  this topic**?"*, used to rank papers within a subtopic. Multiplicative, in `utils/scoring.py`:

  ```
  article_score = (impact_score / 100) ** 1.2 * relevance_score ** 1.4
  ```

  Because it multiplies, a paper scores zero if **either** impact or relevance is zero — so a
  high-impact paper that merely *mentions* a topic cannot outrank a genuinely on-topic paper
  inside that topic's surfaces. A subtopic's pool score (Stage 1) is the **sum of its top papers'
  article scores**. The formula is a locked cross-repo contract and must match byte-for-byte in
  the TypeScript consumer.

**Output (S3 `wcmc-reciterai-artifacts`):** `spotlight/v{date}/{spotlight,spotlight.schema,manifest}.json`,
with a `spotlight/latest/` pointer and an immutable `spotlight/runs/{run_id}/` archive. A
**shrink guard** aborts a publish if the new card count drops below ~66% of the prior one.
After upload, it writes back rotation decay state to `SPOTLIGHT_HISTORY#` rows.

**Generation cadence:** EventBridge fires `reciterai-spotlight-orchestrator` **monthly**
(1st at 13:00 UTC). The orchestrator only regenerates if a "dirty gate" is met (enough subtopics
with enough new publications since the last success); otherwise it skips.

## 2. Ingestion & Update (S3 → this app)

**ETL:** `etl/spotlight/index.ts`

1. Fetches `spotlight/latest/manifest.json`; **short-circuits on unchanged SHA256** (no-op if
   ReciterAI hasn't republished).
2. Fetches the versioned schema + artifact, validates with AJV (2020-12, additive-tolerant).
3. **Upserts** up to 25 rows, then **deletes any rows from a prior `artifactVersion`** (full replacement).

**Schedule:** the CDK `EtlStack` Step Function runs **weekly, Sundays 08:00 UTC**
(`cdk/lib/etl-stack.ts`), with Spotlight as one step (`etl:spotlight`) reading
`s3://wcmc-reciterai-artifacts/spotlight/*` via the Fargate task role. Net effect: generation is
monthly, but the weekly ETL picks up whatever `latest` points to (and no-ops when nothing changed).

**Storage:** `Spotlight` model (`prisma/schema.prisma`) — PK `subtopicId` (intentionally *not* a
FK), with `parentTopicId`, `label`/`displayName`, `lede`, a JSON `papers` blob (PMIDs + first/last
author payload), `artifactVersion`, and `refreshedAt`.

## 3. Display

- **Home carousel** — `getSpotlights()` (`lib/api/home.ts`) → `components/home/spotlight-section.tsx`.
  Re-resolves WCM authors live from `PublicationAuthor`→`Scholar` (not the artifact's author
  payload), applies dark-publication suppression, seed-samples 3 papers per card (#286), and
  **hides the whole section if fewer than 6 cards survive**.
- **Topic / dept / division / center pages** — `lib/api/spotlight.ts`, rendered by
  `components/shared/spotlight.tsx`: 1–3 cards filtered to active full-time faculty, first/last
  author, impact ≥ 40, year ≥ 2020, with middle-author top-up if sparse.
- **Freshness to users:** the home page is ISR-revalidated (6h TTL / on-demand `/api/revalidate`)
  after the ETL lands.

**No feature flag and no per-scholar override** — Spotlight isn't in `EDITABLE_FIELDS`, so the
`/edit` surface can't change it. Visibility is governed only by the ≥6-card floor on home and the
per-page scoring filters elsewhere.

## 4. Inclusion criteria

A publication and its author have to clear filters in **two places**: upstream when ReciterAI
builds the pool, and again in this app when a page selects what to render. They are deliberately
different, so a paper in the artifact may still not appear on a given surface.

### Articles

| Where | Criteria |
|---|---|
| **Generation pool** (`spotlight/pool_ranker.py`) | Publication has a subtopic assignment (a `TOPIC#` row); **published within the last 24 months** (`year ≥ currentYear − 2`); has usable author identity (rows with a first/last author are preferred, and the lede generator drops papers with no author identity). Ranked by **article score**; only the top N per subtopic (`pool_top_papers_per_subtopic`) are kept. |
| **Topic / dept / division / center pages** (`lib/api/spotlight.ts`) | `publicationType = "Academic Article"`; **year ≥ 2020** (`RECITERAI_YEAR_FLOOR`); **impact score ≥ 40** (`HIGHLIGHTS_IMPACT_FLOOR`); the scholar is a **first or last author**; not dark/suppressed. If a surface yields fewer than 3 cards, it is topped up with **middle-author** publications (Issue #68), same impact floor. |
| **Home carousel** (`lib/api/home.ts`) | Papers come from the card's artifact pool (already ReciterAI-ranked), then filtered to **first/last author**, **year ≥ 2020**, and **non-dark** (suppression check, #356). 3 papers per card are seed-sampled deterministically per publish cycle (#286). |

### Faculty (authors)

Authors are always resolved **live from the app's `PublicationAuthor → Scholar` join**, not from the
artifact's stored author payload, and must be **active** and **not soft-deleted** (`deletedAt = null`).
The eligible role set differs by surface:

| Where | Eligible roles |
|---|---|
| **Topic / dept / division / center pages** | **Full-time faculty only** (`role_category = "full_time_faculty"`). |
| **Home carousel** | Broader — **full-time faculty, postdocs, and fellows** (`ELIGIBLE_ROLES` in `lib/eligibility.ts`); the author must hold a **first/senior** position (last or penultimate counts as senior). |

Net effect: postdoc-/fellow-led work can headline the home carousel but will not appear on a
topic or unit page, which are faculty-only.

## 5. How changes happen (triggers → what we do)

Spotlight is regenerated upstream and pulled in downstream; there is no in-app editing, so **to
change a card you regenerate the artifact**, you don't edit the database.

**Automatic triggers**

| Trigger | Cadence | What it does |
|---|---|---|
| EventBridge → `reciterai-spotlight-orchestrator` | **Monthly**, 1st @ 13:00 UTC | Checks the **dirty gate** (≥ `spotlight_dirty_subtopic_min` subtopics, each with ≥ `spotlight_dirty_pubs_per_subtopic_min` new publications since the last success). If met, runs the full 6-stage pipeline and publishes a new artifact to S3; otherwise records a "skipped" stage and does nothing. |
| SPS ETL step `etl:spotlight` (CDK `EtlStack` state machine) | **Weekly**, Sun @ 08:00 UTC | Reads `spotlight/latest/manifest.json`; if the **SHA256 is unchanged it no-ops**; otherwise full-replaces the `Spotlight` table from the new artifact. ISR revalidation then refreshes the pages. |

**Manual actions (operator)**

In the ReciterAI repo:

- **Regenerate + publish everything:** `python3 backfill_spotlight.py --publish`
- **Preview the pool/selection only (no Bedrock spend):** `python3 backfill_spotlight.py --dry-run`
- **Full pipeline to a local file (does spend on Bedrock):** `python3 backfill_spotlight.py --dry-run-full`
- **Re-roll a single card's lede:** `python3 backfill_spotlight.py --regen-only <SUBTOPIC_ID>`

Ledes that fail the critic or sensitive-topic gate are routed to a `SPOTLIGHT_REVIEW#` queue rather
than published. A publish that would shrink the card count below ~66% of the prior run is aborted by
the shrink guard.

In this repo, to pull a freshly published artifact in **before** the weekly cron, run the
`etl:spotlight` step manually — but it only changes anything if ReciterAI has actually republished
(the SHA256 check). The full-replacement semantics mean stale cards are deleted automatically; there
is nothing to clean up by hand.
