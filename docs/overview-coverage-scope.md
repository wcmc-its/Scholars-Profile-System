# Overview-statement coverage — scope & strategy

**Status:** Draft for stakeholder review
**Date:** 2026-06-01
**Authors:** Scholars Profile System development team
**Question this answers:** *How many faculty have an overview statement, who is missing one, and how should we close the gap so the prominent full-time faculty profiles "look good and rank highly"?*
**Companion artifacts (this folder):**
[`audit-overview-coverage.sql`](./overview-coverage/audit-overview-coverage.sql) (the diagnostic queries behind every number here) ·
[`export-target-list.sql`](./overview-coverage/export-target-list.sql) + [`target-list-prominent-uncovered.csv`](./overview-coverage/target-list-prominent-uncovered.csv) (the ranked work-list) ·
[`gradschool-harvest-scope.md`](./overview-coverage/gradschool-harvest-scope.md) (option-1 feasibility) ·
[`../overview-statement-generator-spec.md`](./overview-statement-generator-spec.md) (option-4 design).
**Related:** [self-edit-launch-spec.md](./self-edit-launch-spec.md) (the `/edit` Overview editor this would feed) · [ADR-005](./ADR-005-manual-override-layer.md) (the `field_override` write path a seed would use) · [project_seo_rank_tracking / #594] (why prominent-first compounds for SEO + LLM-answer rank).

> **Data provenance.** Every count below is from the canonical local dev DB (host MariaDB, ETL-populated from the same upstreams as production), captured 2026-06-01. It is real WCM scale and content, but the **operator should confirm parity against production** before committing to exact target counts. Reproduce with `audit-overview-coverage.sql`.

---

## TL;DR

- The overview field exists (`scholar.overview`, sanitized HTML, surfaced on every profile and editable at `/edit`). The ~557 that are populated were **seeded once from VIVO and are never refreshed** — coverage is *frozen* and will not improve on its own.
- **Coverage is low and prominence-skewed.** 6.2% of all scholars and **15.1% of full-time faculty** have an overview. It rises with prominence but **even 200+-publication faculty are only 43.8% covered.**
- **The marquee gap is real and embarrassing.** Among the uncovered full-time faculty, ranked by prominence, the top entries are the Chair of Genetic Medicine (921 pubs), a cardiothoracic-surgery professor (875 pubs), and **the Dean of WCM** (758 pubs).
- **The high-value job is small.** "50+ pubs *or* an active PI grant" is **724 faculty, of whom 512 lack an overview** — a one-pass seeding effort, not a 9,000-person crawl.
- **Recommendation (updated after the Grad School crawl): generator-first, harvest-as-feed.** Build the **`/edit` AI-assisted generator** (option 4) — it's the durable engine *and* the cleaning path — then **feed the ~85 net-new Grad School bios through it** rather than raw-importing them. The crawl measured only **~85** net-new from Grad School (not ~512: ~37% lack a mappable CWID, many are MSK-not-WCM, half are already covered), and those bios need a voice/cleanup pass that is most of the generator's pipeline anyway. Backfill the rest with NIH biosketches (option 3). Details: [overview-coverage/gradschool-bio-analysis.md](./overview-coverage/gradschool-bio-analysis.md).

---

## What "overview statement" is here

| | |
|---|---|
| **Field** | `scholar.overview` — nullable HTML `Text`, 20,000-char cap; `scholar.overview_updated_at` timestamp. |
| **Rendered** | Public profile, via `components/edit/overview-card.tsx` (sanitized HTML). It is the single richest free-text block on a profile. |
| **Edited** | `/edit` Overview attribute (Tiptap `OverviewEditor`); owner-only — a superuser/admin cannot edit another scholar's bio (see [self-edit-launch-spec.md](./self-edit-launch-spec.md) attribute matrix). |
| **Override path** | A self-edit writes a `field_override` (`entity_type='scholar'`, `field_name='overview'`); the read-merge prefers an override over the ETL value (`getEffectiveOverview()` in `lib/api/manual-layer.ts`). |
| **Source today** | A **one-time VIVO migration.** The populated values are real WCM bios as serialized VIVO HTML (`<p>`, `<strong>`, `&rsquo;`…), avg ~1,450 chars. **No active ETL writes this field**, and `field_override` currently holds **0** overview rows — so nothing is refreshing or growing it. |

The consequence that frames everything else: **without one of the four interventions below, coverage stays exactly where it is.**

---

## The scope (8,937 active scholars)

| Segment | Total | Has overview | Coverage |
|---|---:|---:|---:|
| **All scholars** | 8,937 | 557 | **6.2%** |
| **Full-time faculty** | 2,416 | 365 | **15.1%** |
| Affiliated faculty | 5,408 | 186 | 3.4% |
| Non-faculty academic | 489 | 5 | 1.0% |
| Postdoc / fellow / instructor | 624 | 1 | 0.2% |

Coverage by prominence, **full-time faculty only** (confirmed publication count):

| Prominence (pubs) | Faculty | Covered | % |
|---|---:|---:|---:|
| **200+** | 80 | 35 | **43.8%** |
| 100–199 | 210 | 74 | 35.2% |
| 50–99 | 260 | 77 | 29.6% |
| 20–49 | 478 | 85 | 17.8% |
| 5–19 | 673 | 59 | 8.8% |
| 1–4 | 469 | 24 | 5.1% |
| 0 | 246 | 11 | 4.5% |

The gradient confirms the intuition (prominence correlates with coverage) **and** the problem (the top tier is still majority-empty).

### The actionable gap is tractable

| Target segment | Faculty | Covered | **Gap to fill** |
|---|---:|---:|---:|
| 100+ pubs | 290 | 109 | **181** |
| 50+ pubs | 550 | 186 | **364** |
| Active PI grant | 413 | 114 | **299** |
| **50+ pubs OR active PI grant** | **724** | 212 | **512** |
| All full-time faculty | 2,416 | 365 | 2,051 |

The ranked work-list is [`target-list-prominent-uncovered.csv`](./overview-coverage/target-list-prominent-uncovered.csv) (2,051 rows, all FT-faculty gaps, tiered so any threshold can be cut):

| `rank_tier` | Meaning | Count |
|---|---|---:|
| `A_100plus_pubs` | ≥100 confirmed pubs | 181 |
| `B_50to99_pubs` | 50–99 pubs | 183 |
| `C_active_PI` | <50 pubs but holds an active PI grant | 148 |
| `D_20to49_pubs` | 20–49 pubs | 294 |
| `E_tail` | the long tail | 1,245 |

**A + B + C = 512** = the recommended first-pass target.

### A quality gap too (matters for "look good")

Of the 557 that *are* covered, ~20% are weak — these are seeding/remediation targets even though they're technically "covered":

| Quality band (chars) | Scholars |
|---|---:|
| stub (<200) | 22 |
| thin (200–599) | 90 |
| solid (600–1,499) | 199 |
| rich (1,500+) | 246 |

---

## The four options, against the data

The user framed four paths. They are **not** mutually exclusive — three are *sources*, one is a *delivery mechanism*, and one is the *durable system*. Mapped to scope:

| # | Option | What it really is | Best fit | Verdict |
|---|---|---|---|---|
| 1 | **Grad School site harvest** (343 crawled) | A high-quality *source* of curated prose. | The research-track prominent tier. | **Good but partial: ~85 net-new** (measured). Bios are curated but heterogeneous (mixed voice, awards-lists, dirty HTML, 15 stubs) and need cleaning — best fed *through* the generator, not raw-imported. See [gradschool-bio-analysis.md](./overview-coverage/gradschool-bio-analysis.md). |
| 2 | **One-time back-end seeding** | The *delivery mechanism* for (1) or (3), not a source. | Any bulk import. | **Use it** — but the real decision is *where it lands* (below). |
| 3 | **NIH biosketches** | A *source* for NIH-funded PIs. | The 413 active-PI faculty. | **Secondary.** Biosketch "Personal Statements" need reformatting and are harder to locate/parse than (1); use only to backfill PIs the Grad School site misses. |
| 4 | **`/edit` generator** | The *durable system*: Scholars data → AI draft → faculty/admin edit. | The 2,000-person long tail + ongoing freshness. | **The long-term answer.** The `OverviewEditor` already exists; we already hold the raw material (pubs, topics, impact, grants; ReciterAI summaries). A one-time seed cannot keep profiles fresh — this can. Designed in [overview-statement-generator-spec.md](./overview-statement-generator-spec.md). |

### Recommended sequence (updated post-crawl)

The crawl ([overview-coverage/gradschool-bio-analysis.md](./overview-coverage/gradschool-bio-analysis.md)) reshaped the plan: the Grad School site yields **~85 net-new** (not ~512), and its bios need a clean + voice-normalize pass anyway — which *is* most of the generator's pipeline. So:

1. **Build the `/edit` AI-assisted generator first** (option 4) — it's the durable engine *and* the cleaning path. It fills the long tail from Scholars data and keeps profiles fresh.
2. **Feed the ~85 Grad School bios through that generator** as "source material to normalize" (option 1 + 2), rather than a separate raw-import pipeline — one voice, one review gate. A quick win on prominent research faculty, now scoped honestly.
3. **NIH biosketches (option 3)** as a targeted backfill for active PIs the Grad School site doesn't reach (clinical faculty, MSK-only, the 37% with no VIVO link).

*(Earlier draft proposed "seed ~512 from Grad School first"; the measured ~85 yield + the cleaning overhead inverted the order — generator leads, harvest feeds it.)*

### The provenance decision a seed forces (resolve before building)

A one-time seed must choose **where the imported text lands**, because that decides what happens when the faculty member later self-edits:

| Land it in… | Behavior | Trade-off |
|---|---|---|
| `scholar.overview` (ETL-managed) | The next VIVO/ETL run could overwrite it (today nothing refreshes it, so low risk). A self-edit override still wins via `field_override`. | Cleanest "this is source data," but conflates *imported* with *authored*; no provenance marker. |
| `field_override` (manual layer), `source` tagged (e.g. `gradschool-seed`) | Treated as a curatorial override; a later owner self-edit cleanly supersedes it; auditable; never clobbered by ETL. | **Recommended.** Matches ADR-005's intent and keeps "seeded" distinguishable from "faculty wrote this." |

**Open provenance question for stakeholders:** should seeded text be visibly attributed/sourced (e.g. "Adapted from the Graduate School profile"), and should faculty be **notified** that a draft bio now exists for them to review? (Ties into the option-4 review flow.)

---

## Why this is also an SEO / LLM-rank lever

The overview is the single richest indexable free-text block on a profile, so filling it moves both classic search ranking and the **LLM-answer-citation rank** instrument now on `feat/594-llm-answer-rank`. Doing the **prominent faculty first** compounds: those are the highest-traffic, highest-query-volume profiles, so the same content yields the most rank lift. Recommend treating *overview-presence* as a measured factor in the #594 instrument (before/after a seed pass).

---

## Caveats & confirmations needed

1. **Prod parity.** Numbers are from the canonical dev DB; confirm against production before locking target counts.
2. **Effective-overview.** Counts filter on `scholar.overview` only; `field_override` overview rows = 0 at capture, so it equals the effective overview. Re-check once self-edit overrides exist (the SQL notes how).
3. **Grad School overlap — now measured.** The crawl is complete ([overview-coverage/gradschool-bio-analysis.md](./overview-coverage/gradschool-bio-analysis.md)): the harvest yields **~85 net-new** overviews (not the ~150–200 first estimated) — ~37% of profiles lack a mappable CWID, many grad faculty are MSK (not WCM scholars), and half of mapped FT faculty are already covered. The bios also need a clean + voice-normalize pass, so the efficient path is to feed them **through** the option-4 generator rather than raw-import.
4. **Licensing / voice.** Grad School bios are WCM's own content (internal reuse is fine) but are **third-person, lab-focused** ("The Blenis lab studies…") — fine for an overview, but a voice/standardization pass may be wanted.
