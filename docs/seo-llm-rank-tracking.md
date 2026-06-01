# LLM-answer rank instrument

A fixed expert-query basket + AI-Gateway runner for measuring whether WCM
scholars surface **in AI-assistant answers** — the question a funder or
journalist actually performs today: _"ask ChatGPT / Perplexity / Gemini for an
expert on Y — does a WCM scholar come up, and is our profile the cited source?"_

This is the AI-answer companion to the Google-rank tracker
(`docs/seo-rank-tracking.md`). It reuses that scaffolding — the same expert
basket (`data/seo/flagship-queries.json`), the same target definitions
(`data/seo/rank-basket.json`), the same host/path matchers — and adds the
provider clients + non-determinism controls an LLM surface demands.

> **Not a launch gate.** Parametric LLM answers lag training cutoffs by months,
> so nothing here blocks the VIVO → Scholars flip. The one time-sensitive piece
> is a cheap pre-cutover baseline (§ Pre-cutover baseline) — capture it while
> VIVO is still live, then archive.

---

## Why "rank" means three different things here

Unlike a Google SERP (a deterministic ordered list of URLs), LLM surfaces differ
by retrieval mechanism. Conflating them produces a meaningless number.

| Surface                                                            | Returns                                  | "Rank" analog                             | SEO-sensitive?                                    | Built                           |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------- |
| **Citation RAG** — Perplexity, ChatGPT Search, Gemini grounding    | prose + cited URLs                       | citation present + 1-based citation index | **Yes** — where the #171 structured data pays off | `seo:llm-rank`                  |
| **Google AI Overview** (a citation-RAG subset)                     | AI block above the SERP, with references | reference present + position              | Yes                                               | folded into `seo:track`         |
| **Parametric prose** — vanilla ChatGPT/Claude/Gemini (no browsing) | prose naming people/orgs, no URLs        | mention present + prominence              | Lagging — reflects training cutoff                | _follow-up (`seo:llm-mention`)_ |

This document covers the first two (the SEO-sensitive, measurable surfaces). The
parametric-prose instrument is a separate, diagnostic-only follow-up.

---

## What `seo:llm-rank` measures, and the honest caveats

For each **expert** query (e.g. _cancer genomics expert_) we ask each
citation-capable assistant the funder question and inspect its cited sources for
a tracked target host. "Rank" is the **1-based index** of the first cited URL
that belongs to a target (WCM's `scholars.weill.cornell.edu`, the legacy VIVO
host, or — if you point `--basket` at a rival basket — peer platforms).

Two properties of LLM answers force a different shape than the SERP tracker:

1. **Non-determinism.** The same query, sampled twice, can cite different
   sources. So we **never report a single position.** Each (query, provider) is
   sampled **N times** (default 3) and reported as a **citation rate + 95%
   confidence interval** (Wilson score interval — well-behaved at small N and
   near 0/1).
2. **Model drift.** A citation rate is only comparable against the same model at
   the same date. Every snapshot pins `{provider, model, modelDate, temperature,
samples, queryBasketSha}`. A diff across mismatched pins is **flagged**
   (`detectVersionMismatches`), never silently compared.

### Why official APIs only, no scraping

Scraping an assistant's web UI violates its ToS and is non-reproducible (same
reasoning as "why SerpAPI, not direct Google scraping"). We call official
provider APIs, routed through the **Vercel AI Gateway** with bare
`provider/model` strings so adding a provider is one entry in
`CITATION_PROVIDERS` (`lib/seo/llm-client.ts`) and per-call cost is observable.

---

## Setup

```bash
export AI_GATEWAY_API_KEY=…        # in ~/.zshrc per project convention; never logged or committed
```

- The key is read by the AI SDK gateway itself; `--dry-run` needs **no key**.
- Perplexity searches natively (no tool). OpenAI and Gemini attach their
  provider-executed web-search / grounding tools. Note: some provider-executed
  tools may additionally require that provider's own key be configured on the
  gateway — verify in the Vercel AI Gateway dashboard before a live run.
- **Verify the pinned model strings** in `CITATION_PROVIDERS` against the live
  gateway model list before each run — model ids roll forward. They are the
  single edit-point.

---

## Running it

```bash
npm run seo:llm-rank -- --dry-run                 # validate basket + estimate cost, NO API calls, NO key
npm run seo:llm-rank                              # live run (all providers, N=3)
npm run seo:llm-rank -- --providers perplexity    # one surface
npm run seo:llm-rank -- --limit 1 --samples 1     # cheap smoke test (3 calls, one per provider)
npm run seo:llm-rank -- --basket data/seo/rival-basket.json   # track peer platforms too (for share-of-voice)
```

Flags: `--samples N` (default 3), `--temperature` (default 0), `--providers a,b`,
`--queries <path>` (default `flagship-queries.json`), `--basket <path>` (targets;
default `rank-basket.json`), `--limit N`, `--delay <ms>` (default 800),
`--max-per-hour N` (per-provider cap; 0 = disabled), `--out <path>`.

Output: `data/seo/snapshots/llm-rank-<timestamp>.json` (**gitignored** — like all
SerpAPI/LLM snapshots).

### Cost — the defining difference from `seo:track`

SerpAPI's "one search covers all targets" rule does **NOT** hold. Every
`(query, provider, sample)` is its own billed answer:

```
calls = queries × providers × samples
```

The full flagship basket at the defaults is **24 × 3 × 3 = 216 calls** (~$3.60
indicative). `--dry-run` prints the exact call count and an indicative per-provider
cost (provider list prices, not a billed amount — the precise figure comes from
the gateway's per-generation lookup afterward). Suggested cadence: **monthly**.

---

## Google AI Overview (captured by `seo:track`, zero extra cost)

The `engine=google` response `seo:track` already fetches carries an
`ai_overview` block when Google renders one. `seo:track` now records, per row, an
`aiOverview` placement for each target **from that same response — no extra
SerpAPI searches**. Each row gets a block-level `status`:

- `parsed` — the AI Overview rendered with references we scanned.
- `page_token_only` — the block exists but its references are behind a
  `page_token`. Expanding it costs a **separate billed** `google_ai_overview`
  fetch, which we deliberately **do not** pay by default. Recorded honestly as
  present-but-unexpanded, never conflated with "not cited".
- `absent` — no AI Overview for this query.

No new command — just run `seo:track` as usual; the AI-Overview placements ride
along in the snapshot.

---

## Pre-cutover baseline (the only time-sensitive piece)

Capture **one** citation-RAG snapshot **before** the VIVO → Scholars flip and
archive it. It's a weak one-way door (parametric/citation answers won't reflect
the flip for months) but cheap, and it's the only "before" you can ever take.

```bash
# while VIVO is still live (pre-launch window):
export AI_GATEWAY_API_KEY=…
npm run seo:llm-rank -- --out data/seo/snapshots/llm-rank-PRE-CUTOVER.json
# also run a normal seo:track — it now captures AI Overview placements too.
```

Snapshots are gitignored; keep the baseline file somewhere durable (it is not
committed). Re-run `seo:llm-rank` ~monthly after cutover and compare with
`detectVersionMismatches` in view — if the pinned model changed between runs, the
diff is flagged, not silently trusted.

---

## Files

- `lib/seo/llm-rank.ts` — pure: `findCitationPlacement`, `citedUrlsFromSources`,
  `wilsonInterval`, `aggregateSamples`, `detectVersionMismatches`, `basketSha`,
  `estimateLlmCost`, and the snapshot types (carrying the §4 drift controls).
- `lib/seo/llm-client.ts` — the only network module: `CITATION_PROVIDERS` (the
  add-a-provider seam), `callProvider`, `gatewayKeyFromEnv`.
- `lib/seo/serpapi.ts` — extended with `findAiOverviewCitation` + the
  `ai_overview` types (reuses the existing host/path matchers).
- `scripts/seo/llm-rank.ts` — the runner (`seo:llm-rank`), mirroring
  `scripts/seo/track-rank.ts`.
- Tests: `tests/unit/seo-llm-rank.test.ts` + the AI-Overview block in
  `tests/unit/seo-rank.test.ts` (pure, no network).
