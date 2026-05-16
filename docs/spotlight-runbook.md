# Spotlight system — operator runbook

How the home-page **Selected research** section gets its data, how to re-publish it, and where to look when something breaks.

## What you're looking at

The home page Selected research section is driven by an **editorial spotlight artifact** generated weekly in the `wcmc-its/ReCiterAI` pipeline and consumed by SPS via S3 + a sha256-gated ETL. Each spotlight is one subtopic with a 25–35 word LLM-authored lede and 2–3 representative WCM publications.

Two repos, two halves:

| Repo | What it owns |
|---|---|
| `wcmc-its/ReciterAI` (cloned to `~/Dropbox/GitHub/ReciterAI`) | Lede generation (Bedrock), critic gates, artifact publish to `s3://wcmc-reciterai-artifacts/spotlight/`, DynamoDB review queue + rotation history. |
| `wcmc-its/Scholars-Profile-System` (this repo) | S3 ETL into `Spotlight` MySQL table, `getSpotlights()` DAL, `<SpotlightSection>` home-page component. |

Authoritative cross-repo contract: `~/Dropbox/GitHub/ReciterAI/docs/spotlight-contract.md`. SPS adapter brief: `…/docs/sps-spotlight-handoff.md`.

## End-to-end flow

```
ReciterAI side                                                 SPS side
                                                            
  backfill_spotlight.py --publish                            etl/spotlight/index.ts
       │                                                          │
       ▼                                                          ▼
  Bedrock (Opus) lede gen                                    Fetch latest/manifest.json
       │                                                          │
       ▼                                                          ▼
  Critic regex + LLM-as-judge                                Compare manifest.sha256
       │                                                          │
       ▼                                                          ▼
  Sensitive-tag check ─ fail ─▶ DDB SPOTLIGHT_REVIEW#         Validate v{date}/spotlight.schema.json
       │                                                          │
       ▼                                                          ▼
  Pass ─▶  s3://wcmc-reciterai-artifacts/spotlight/           Upsert prisma.spotlight rows
              v{ISO-date}/spotlight.json                          │
              latest/spotlight.json                                ▼
                                                              getSpotlights() reads
                                                              + joins PublicationAuthor + Scholar
                                                                   │
                                                                   ▼
                                                              <SpotlightSection> renders
                                                              random 8-of-N, auto-rotates
```

## How to re-publish (cadence: weekly, operator-run)

All commands run from `~/Dropbox/GitHub/ReciterAI`. AWS creds: this machine has `~/.aws/credentials` for `user/reciter` (`AdministratorAccess`).

```bash
# 1. Smoke. DDB read only, ~$0.
python3 backfill_spotlight.py --dry-run

# 2. Full pipeline preview. Bedrock spend ~$1.50 on Opus, no S3 write.
#    Generates the 10 ledes locally for review.
python3 backfill_spotlight.py --dry-run-full

# 3. Real publish. Writes spotlight/v{ISO-date}/ + overwrites latest/.
#    Also writes 10 SPOTLIGHT_HISTORY# rows for rotation decay.
python3 backfill_spotlight.py --publish
```

After a publish, on the SPS side:

```bash
# From Scholars-Profile-System
npm run etl:spotlight
```

This compares the new `manifest.sha256` against the prior `EtlRun(source: "Spotlight")` row. On match it short-circuits with `rows: 0`. On mismatch it validates the artifact against the version-pinned schema (`ajv/dist/2020`), upserts the spotlights table, and deletes any rows whose `artifactVersion` doesn't match the current publish.

## Operator workflow flags

| Flag | Use |
|---|---|
| `--review-queue [--publish-id <id>]` | List pending review-queue entries |
| `--approve <subtopic_id>` | Promote a held entry into the next publish |
| `--reject <subtopic_id>` | Permanently exclude a held entry |
| `--regen-only <subtopic_id>` | Re-roll one spotlight, leave the others untouched |
| `--reset-history` | Truncate `SPOTLIGHT_HISTORY#` (after annual hierarchy recompute when subtopic IDs rotate) |

## What lives where

### S3

- `s3://wcmc-reciterai-artifacts/spotlight/v{ISO-date}/spotlight.json` — versioned snapshot
- `s3://wcmc-reciterai-artifacts/spotlight/v{ISO-date}/spotlight.schema.json` — co-published schema
- `s3://wcmc-reciterai-artifacts/spotlight/v{ISO-date}/manifest.json` — version + sha256 + sizes
- `s3://wcmc-reciterai-artifacts/spotlight/latest/{spotlight.json,…}` — overwrites every publish; SPS reads here

### DynamoDB (`reciterai` table)

- `SPOTLIGHT_HISTORY#{subtopic_id}` — rotation decay multiplier source
- `SPOTLIGHT_REVIEW#{publish_id}` — sensitive-tag and critic-failed entries pending operator review
- `SPOTLIGHT_CONFIG#sensitive_tags` — operator-curated forbidden-pattern list (NOT in git, intentionally — security)

### MySQL (SPS)

- Table `spotlight` — sole-written by `etl/spotlight/index.ts`. Each publish is a full replacement. Subtopic IDs are not stable across hierarchy recomputes; never FK out of this table.
- Table `etl_run` — `source: "Spotlight"` rows persist `manifest_sha256` for short-circuit detection.

## Render rules (for when the home-page output looks off)

The home-page section is in `components/home/spotlight-section.tsx`, fed by `getSpotlights()` in `lib/api/home.ts`.

- **Author resolution**: SPS does NOT trust the artifact's `first_author` / `last_author` payload. The DAL joins `PublicationAuthor` to `Scholar` (where `cwid IS NOT NULL` and `scholar.deletedAt IS NULL` and `status = 'active'`) and renders WCM-resolved authors only, sorted by byline `position`. Reason: upstream's WCM-author check sometimes mislabels (e.g. PMID 37931288 shipped Tammela T at MSK as a "WCM last author"; SPS now correctly surfaces Charles Rudin as the middle-position WCM author instead).
- **Per-paper drop**: papers with zero WCM-resolved authors are hidden.
- **Per-spotlight drop**: spotlights whose papers all dropped are hidden.
- **Sparse-state hide**: if fewer than `SPOTLIGHT_FLOOR` (= 6) spotlights survive, the entire section hides. Floor and target constants live in `lib/api/home.ts`.
- **Display sampling**: the component renders a random `DISPLAY_LIMIT_SPOTLIGHTS` (8) of N spotlights on each pageload, auto-advancing every 10 s (pauses on hover/focus). The 3 papers shown per spotlight are **not** random per pageload — `getSpotlights()` seeded-samples them from the artifact pool (issue #286), keyed on `artifactVersion` + `subtopicId`, so the choice is stable within a publish cycle and rotates across cycles. See `lib/spotlight-sampling.ts`.
- **Counts**: `publicationCount` and `scholarCount` per spotlight are aggregated in the DAL via raw SQL over `publication_topic` JOIN `scholar` (year ≥ 2020 floor, active non-deleted scholars). Grants are intentionally absent (no topic linkage in the schema).
- **Link layout (Plan 09-04 spec)**: subtopic name → `/topics/{parent}?subtopic={sub}`, parent kicker → `/topics/{parent}`, publications count → `…#publications`, scholars count → `…#top-scholars`. The topic page has matching id anchors with `scroll-mt-20`.

## Voice rules (lede content, upstream concern)

The lede is generated by `prompts/spotlight_synopsis_v0.md` in the ReciterAI repo. SPS renders verbatim per contract §Voice (D-19 LOCKED — never pass `lede` / `displayName` / `shortDescription` through any LLM, retrieval, or embedding path). When ledes read poorly, the fix is upstream:

- Edit the prompt's forbidden-patterns list, then `--publish` again.
- Or `--regen-only <subtopic_id>` to re-roll a single spotlight without disturbing the others.
- Or `--reject <subtopic_id>` to send it to the review queue (next publish picks a different subtopic).

Open issue tracking voice rules: [wcmc-its/ReciterAI#2](https://github.com/wcmc-its/ReciterAI/issues/2) (cherry-picking, source meta-language, opener repetition, Sonnet→Opus model swap).

## Debugging

| Symptom | First place to look |
|---|---|
| Section doesn't render | `EtlRun` table (most recent `Spotlight` row): is `status = "success"` and `rows_processed > 0`? If `rows_processed = 0` it short-circuited (sha256 unchanged from prior run, expected). |
| Section renders but no cards | `SELECT COUNT(*) FROM spotlight` — should be 10 after each publish. |
| Section hides (floor) | Check sparse-hide log: `home_spotlights` line in server logs. Floor is `SPOTLIGHT_FLOOR` in `lib/api/home.ts`. |
| Authors look wrong | Check `publication_author` for the PMID. SPS only renders `cwid IS NOT NULL` rows; if the WCM author is in a middle position the upstream artifact's first/last labels may diverge from what we render. |
| Counts wrong | Raw aggregation in `getSpotlights()` queries `publication_topic` with `year >= 2020` (D-15 floor). If counts seem low, verify the year floor isn't masking older work the user is expecting to see. |
| Browse-link 404 | Should be `/topics/{parent}?subtopic={sub}` not `/topics/{sub}`. Subtopic IDs are not first-class routes; they're query params on the parent topic page. |

## Measuring CTR (#286 success metric)

#286's success metric is **CTR uplift on slots 1–2 relative to slot 0, across publish cycles** — does rotating the dominant paper out of the lead slot lift engagement on the lower slots. Spotlight paper clicks emit a `spotlight_paper_click` analytics beacon (`lib/api/analytics.ts`, added in #343 / PR #344) carrying `pmid`, `slot` (0–2), `cycleId` (the `artifactVersion`), and `subtopicId`. Each beacon is one structured JSON line on stdout → CloudWatch Logs in production.

There is no analytics database — by design (see `docs/search.md`: "need analytics warehouse first"). Querying the metric means a **CloudWatch Logs Insights** query against the app log group:

```
filter event = "spotlight_paper_click"
| stats sum(slot = 0) as slot0_clicks,
        sum(slot = 1) as slot1_clicks,
        sum(slot = 2) as slot2_clicks,
        count(*)      as total
  by cycleId
| sort cycleId asc
```

Read it per cycle: uplift on slot N = `slotN_clicks / slot0_clicks`. The metric is the **trend across consecutive cycles**, not any single cycle — within one cycle the seeded triple is fixed, so rotation only becomes visible once 2–3 cycles have accumulated.

**Why click counts alone suffice (no impression data).** When a spotlight is the active card all 3 of its papers render together, so each slot gets exactly one impression per view — per-slot impressions are equal within a spotlight. The *relative* metric (slot N vs slot 0) cancels that equal denominator, so relative click counts *are* relative CTR. An *absolute* CTR would need a separate impression beacon; #286 deliberately scoped the metric as relative.

**Caveats.**

- **Pools < 3** — spotlights with fewer than 3 papers render fewer slots, so those cycles contribute no `slot=2` (or `slot=1`) clicks and have no denominator for that slot. Exclude them when reading slot-2 uplift.
- **No data before launch** — the query returns nothing until production is live and accumulating cycles (`PRODUCTION_BACKLOG.md` B22 — CloudWatch log retention).
- **Author concentration** — #286's *other* metric — is not in these logs; compute it offline from the published artifact + sampler output.

Drill down by adding `subtopicId` (per-spotlight) or `pmid` (which paper drew the clicks) to the `by` clause.

## Key constants

| Constant | Value | Lives in |
|---|---|---|
| `SPOTLIGHT_FLOOR` | 6 | `lib/api/home.ts` |
| `SPOTLIGHT_TARGET` | 10 | `lib/api/home.ts` |
| `RECITERAI_YEAR_FLOOR` | 2020 (D-15) | `lib/api/home.ts` |
| `DISPLAY_LIMIT_SPOTLIGHTS` | 8 | `components/home/spotlight-section.tsx` |
| `SAMPLE_SIZE` (papers shown per spotlight) | 3 | `lib/spotlight-sampling.ts` |
| `MAX_REROLLS` (author-collision re-roll cap) | 3 | `lib/spotlight-sampling.ts` |
| `AUTHOR_DISPLAY_CAP` | 4 (then "+N more") | `components/home/spotlight-section.tsx` |
| `AUTO_ADVANCE_MS` | 10 000 | `components/home/spotlight-section.tsx` |

## Cross-references

- Phase plan: [`docs/spotlight-integration-plan.md`](spotlight-integration-plan.md)
- Cross-repo contract: `~/Dropbox/GitHub/ReciterAI/docs/spotlight-contract.md`
- SPS coding-agent brief: `~/Dropbox/GitHub/ReciterAI/docs/sps-spotlight-handoff.md`
- Launch handoff: `~/Dropbox/GitHub/ReciterAI/docs/spotlight-launch-handoff.md`
- Voice-rule issue: [wcmc-its/ReciterAI#2](https://github.com/wcmc-its/ReciterAI/issues/2)
- CTR metric: instrumentation [#343](https://github.com/wcmc-its/Scholars-Profile-System/issues/343) / PR #344, aggregation query [#345](https://github.com/wcmc-its/Scholars-Profile-System/issues/345)
- Mockup: `.planning/source-docs/spotlight-mockup.html` (gitignored)
