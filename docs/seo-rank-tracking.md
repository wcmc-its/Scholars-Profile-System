# Google-rank baseline tracker

A fixed query basket + SerpAPI runner for measuring where WCM scholar pages
rank in Google **before and after** the VIVO → Scholars cutover. The goal is a
defensible, repeatable before/after — the kind of number you can put on a slide
without an asterisk.

> **Time-sensitive:** the only "before" you can ever capture is one taken
> **while VIVO is still live**. Once it's gone you cannot re-measure it. Capture
> the baseline during the pre-launch window.

---

## What it measures, and the honest caveats

"Google rank" is not one number. This tool tracks **organic SERP position** for
a fixed set of queries, for one or more target domains, over time.

- **Topical queries are the story.** They come from the ReciterAI `topic`
  taxonomy (e.g. *cancer genomics*, *health services research*). Movement here
  reflects whether WCM scholars surface for the research areas ReciterAI says
  they actually work in — a competitive, non-branded signal.
- **Branded queries (`<name> weill cornell`) are a control.** They rank #1
  almost regardless of platform, so they confirm the instrument works rather
  than telling a story.

**This is one of two complementary instruments — use both:**

| Instrument | What it gives you | Cost | Caveat |
|---|---|---|---|
| **This tracker (SerpAPI)** | Exact position for *your* chosen query basket, on demand, for any domain | Paid per search | A point-in-time sample; positions are geolocated/de-personalized but still noisy |
| **Google Search Console** | Google's own avg position + impressions + clicks + CTR for *all* queries that surface your pages, plus indexed-page coverage and Core Web Vitals | Free | Only covers domains you've verified; can't backfill a domain you never verified |

Verify **both** the legacy VIVO property and `scholars.weill.cornell.edu` in GSC
now — GSC backfills ~16 months the moment you verify, and it's the first-party
number. This tracker is the surgical complement for a specific topical basket.

### Confounds to control for
- **Reindex dip.** Position usually *drops* for 2–6 weeks post-migration, then
  recovers — provided the VIVO 301s preserve link equity (see the redirect
  machinery: `etl/vivo-redirect/`, `scripts/etl/generate-vivo-redirect-set.ts`,
  B14 middleware). Measure "after" at ~30 and ~90 days, not launch week.
- **Branded vs non-branded.** Lead with topical movement and overall
  impressions/clicks growth, not branded #1s.
- **Same window / same settings.** The basket pins country/language/`num`, so
  re-runs are comparable. Compare equivalent seasonal windows.

### Why SerpAPI, not direct scraping
Scraping Google's SERP violates its ToS and gets rate-limited/CAPTCHA'd, and the
results are personalized. SerpAPI returns de-personalized, geolocated,
structured results. The key is read from `SERPAPI_KEY` (in `~/.zshrc` per
project convention) and is never logged or committed.

---

## Setup

```bash
export SERPAPI_KEY=…        # already in ~/.zshrc on the operator's machine
```

`--dry-run` needs no key.

## Workflow

```bash
# 1. Build the basket from the live corpus (commit the result).
npm run seo:basket                       # all topics (plain+brand) + top-30 scholars
npm run seo:basket -- --scholars 50      # more branded controls
npm run seo:basket -- --topic-variant plain --scholars 0   # topical-only

# 2. Validate before spending any credits.
npm run seo:track -- --dry-run           # prints plan + cost estimate, no API calls

# 3a. BEFORE cutover — capture the legacy baseline (VIVO still live).
npm run seo:track                        # → data/seo/snapshots/rank-<ts>.json

# 3b. AFTER cutover (~30 and ~90 days) — capture the new site.
npm run seo:track

# 4. Diff two snapshots.
npm run seo:diff                                   # auto: two most recent
npm run seo:diff -- --before <a.json> --after <b.json> --csv data/seo/rank-diff.csv
```

Cheap test run: `npm run seo:track -- --limit 5 --no-cache`.

### Plan rate limits

`seo:track` self-throttles to **200 searches/hour by default**, matching
SerpAPI's Starter plan cap. A single snapshot (~164 searches) is under the cap,
so it never pauses; the throttle only bites if you run several snapshots
back-to-back within an hour. On a higher tier, lift it: `--max-per-hour 1000`
(Developer) / `--max-per-hour 3000` (Production), or `--max-per-hour 0` to
disable. Starter ($25/mo, 1,000 searches/mo) comfortably covers the whole
before/after program (~3 snapshots ≈ 500 searches).

## Files

| Path | Role | Committed? |
|---|---|---|
| `lib/seo/serpapi.ts` | SerpAPI client + pure SERP-parsing helpers | yes |
| `lib/seo/rank-basket.ts` | Basket/snapshot types + diff/summary/CSV/markdown | yes |
| `scripts/seo/build-basket.ts` | Generate the basket from the DB (`seo:basket`) | yes |
| `scripts/seo/track-rank.ts` | Run SerpAPI, write a snapshot (`seo:track`) | yes |
| `scripts/seo/diff-rank.ts` | Before/after report (`seo:diff`) | yes |
| `data/seo/rank-basket.json` | The query basket (the fixed instrument) | **yes** (gitignore allowlist) |
| `data/seo/snapshots/rank-*.json` | SerpAPI output | no (gitignored — re-derivable, can be large) |

## Cost model

One SerpAPI search per query covers **all** targets at once (the new Scholars
host and the legacy VIVO host are both located in the same organic-results
list). So a snapshot costs ~`(number of queries)` searches — not
`queries × targets`. The default basket (~67 topics × 2 variants + 30 branded ≈
164 queries) is ~164 searches per snapshot. `--dry-run` reports the exact count.

## Targets

Defined in `scripts/seo/build-basket.ts`:

- `new` → `scholars.weill.cornell.edu`
- `vivo` → `vivo.weill.cornell.edu`, `vivo.med.cornell.edu` (aliases)

**Confirm** `vivo.weill.cornell.edu` is the canonical legacy host for your
baseline window before trusting the VIVO column. Edit `TARGETS` if WCM points a
different host at VIVO.

---

# Rival benchmark (cross-sectional)

A second, independent instrument: instead of WCM-over-time, it compares WCM's
research-profiles platform against **peer institutions' profiles platforms** for
the kind of query a funder uses to find an expert. Same SerpAPI plumbing — the
rivals are just extra `targets` read out of the same organic-results list, so
they cost **zero** extra searches.

## What it measures, honestly

- **Share of voice, not absolute rank.** Broad expert queries (`breast cancer
  researcher`) are nationally competitive (NCI centers, NIH, Google Scholar,
  news). No school owns #1. Report relative standings across the named schools.
- **Profiles platform vs platform.** Scope is each school's research-profiles
  host only. `weillcornell.org` (WCM's clinical find-a-doctor site) is tracked
  as a `clinical` surface for diagnosis — "is Scholars even the WCM result, or
  does the clinical site already own this name?" — but is **excluded** from the
  platform leaderboard (rivals' clinical sites aren't targets).
- **New site, mature rivals.** Scholars is freshly indexed; rivals' platforms
  have years of SEO/backlinks. So "WCM" = best of `wcm-new` + `wcm-vivo`, and
  the baseline is a starting point, not a verdict. Re-run as Scholars matures.

## Workflow

```bash
# 1. Build the rival basket (needs DB for the topic taxonomy).
npm run seo:basket -- --mode rivals                 # → data/seo/rival-basket.json
npm run seo:basket -- --mode rivals --expert-templates "{topic} researcher,{topic} expert"

# 2. (Optional) seed eminence covariates for the matched researchers.
#    Edit data/seo/matched-researchers.json first — replace every REPLACE_ME.
npm run seo:enrich-matched                          # OpenAlex h-index + academic age

# 3. Validate + cost, then capture.
npm run seo:track -- --basket data/seo/rival-basket.json --dry-run
npm run seo:track -- --basket data/seo/rival-basket.json   # → snapshots/rank-<ts>.json

# 4. Standings report (markdown to stdout + optional full matrix CSV).
npm run seo:standings                               # latest snapshot
npm run seo:standings -- --snapshot data/seo/snapshots/rank-<ts>.json \
  --csv data/seo/standings-matrix.csv
```

## Targets (verified May 2026)

17 institutions across 5 platforms — Elsevier Pure ×10 (JHU, Mayo, Minnesota,
Penn State, Northwestern, Indiana, Case Western, Miami, OHSU, Einstein),
Profiles RNS ×2 (UCSF, Harvard), VIVO ×2 (Duke, WCM-legacy), Esploro
(Vanderbilt), Stanford CAP, Penn (custom). Full host list in
`scripts/seo/build-basket.ts` (`RIVAL_TARGETS`). Notes:

- **Penn** has no dedicated profiles host; it's scoped to `med.upenn.edu`
  `/apps/faculty/` via the target's `pathPrefix`.
- **Elsevier-hosted Pure** instances canonicalize to `<inst>.elsevierpure.com`
  (the URL Google indexes) — that's what's listed.
- Some Pure portals (Mayo, Penn State, Northwestern, OHSU) sit behind a
  Cloudflare bot-gate. Irrelevant here: we read rank from Google's SERP, we
  never fetch those sites. (Don't "verify" a Mayo URL by curl and panic.)

## Cost & cadence

Rivals are free (same SERP), so cost is driven by queries: ~67 topics × 3 expert
templates + ~24 flagship + matched ≈ **~250 searches/snapshot**. On the Starter
plan (1,000/mo) that's ~3 full rival snapshots/mo. Recommended: sweep quarterly,
flagship monthly. A ~250-query run trips the default 200/hr throttle once
(brief pause); lift with `--max-per-hour` on a paid tier.

## Eminence control (matched set)

A platform head-to-head on names is confounded by researcher eminence — a
famous name ranks regardless of platform. `matched-researchers.json` pairs one
comparable researcher per institution per flagship topic; `seo:enrich-matched`
attaches **h-index + scholarly age from OpenAlex** (one source for everyone, by
design — never mix in our PubMed counts). Match within a topic × h-index-band ×
academic-age band so the head-to-head isolates platform SEO. The starter file
ships with real WCM anchors and `REPLACE_ME` placeholders — **comms must
validate the names** before the matched panel means anything; the enrich script
skips placeholders and never invents a name.

