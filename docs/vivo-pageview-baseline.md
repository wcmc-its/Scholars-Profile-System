# VIVO pageview baseline (pre-decommission)

**Audience.** Anyone answering *"how much did people actually use VIVO, and did Scholars
keep/grow that traffic after cutover?"*

**Issue:** #595 (New Relic integration — "Pageview baseline" item) · **Parallels:** #574
(SEO Google-rank baseline) and #554 (web-vitals). · **Captured:** 2026-05-30.

> **One-line answer.** In its last 30-day window VIVO served **~205,600 pageviews across
> ~193,300 sessions** — about **6,850 pageviews/day** at **~1.06 pageviews per session**.
> That near-1.0 ratio means traffic lands deep on a single page (overwhelmingly from Google)
> and leaves: VIVO's real product is *being the indexed landing surface*, not a browsed site.
> This is the only baseline we have — see the retention caveat below.

---

## 0. The one-way door, and why this is all we get

#595 flagged VIVO's pageview baseline as a one-way door: capture it before decommission or
lose it. The actual ceiling turned out to be **New Relic event retention, not the
decommission date** — VIVO's New Relic data only goes back **~30 days**. There is **no
recoverable 12-month history**. So this 30-day window *is* the baseline; there is nothing
older to capture, and the post-launch comparison against Scholars is therefore
**forward-collecting**, anchored to this single month.

Treat every number here as "a representative recent month," not "the historical mean."

## 1. The baseline (last ~30 days, ending 2026-05-30)

| Metric | Value | Derived |
|---|---|---|
| Pageviews | **205,627** | ~6,850 / day |
| Sessions | **193,311** | ~6,440 / day |
| Pageviews / session | **1.06** | near-total single-page sessions |

Source: New Relic Browser, `SELECT count(*) AS pageviews, uniqueCount(session) AS sessions
FROM PageView WHERE appName = '<VIVO>'` over the retained window.

## 2. Where the traffic goes (top-pages export)

The FACET-by-URL export returned **4,999 distinct URLs** (the NRQL `LIMIT MAX` ceiling)
summing to **28,070 views — only ~13.7% of the 205,627 total**. The other **~177,500 views
(86%)** are an even longer tail of individual profile and publication URLs below the
top-5,000 cut. **VIVO traffic is extremely long-tailed**, which is itself the finding: there
is no small set of "hot" pages carrying the site.

Within the captured top-5,000, by URL pattern:

| Page type | Distinct URLs | Views (in top-5k) | Notes |
|---|---|---|---|
| Publication (`/display/pubid…`) | 3,864 | **13,551** | Largest bucket by both pages and views |
| Profile (`/display/cwid-…`) | 795 | 9,358 | The core scholar-profile comparable |
| `/individual` (linked-data entry) | 1 | 1,385 | URI-dereference entry endpoint |
| Other `/display/…` | 244 | 907 | |
| Landing / nav (`/`, `/home`, etc.) | 46 | 898 | |
| `/search` | 1 | 596 | |
| Org (`/display/org-…`) | 44 | 495 | |
| `/individuallist` | 1 | 301 | |
| `/people` | 1 | 233 | |
| `/research` | 1 | 159 | |
| `/organizations` | 1 | 148 | |
| `/browse` | 1 | 39 | |

**Top individual pages:**
- Profiles: `cwid-ccole` (1,042), `cwid-map9500` (664), then a steep drop to ~50–80 each
  (`pac2001`, `emm4010`, `lndhlovu`, `gul4001`, `mog4005`, …).
- Publications: `pubid41036949` (77), `pubid37430076` (54), `pubid38551655` (45) — no single
  publication dominates; the publication bucket is large in aggregate, flat per-URL.

## 3. What this means for the VIVO → Scholars before/after

1. **Set the bar at ~205k pageviews / ~193k sessions per month.** Scholars matching or
   beating that (via New Relic Browser RUM once #595 §1 ships) is the success signal. Because
   this is a single recent month, compare like-for-like calendar months, not annualized.
2. **The 1.06 pv/session is an SEO story, not an engagement story.** Visitors arrive from
   search on a specific person/paper and bounce. The right Scholars comparison is *"did we
   keep the Google-sourced deep-landing traffic"* — which is why #574 (rank baseline) and the
   `/vivo/*` redirect map (`docs/vivo-cutover-redirect-runbook.md`) are the load-bearing
   levers, more than any in-app navigation improvement.
3. **Publication pages are an indexed surface Scholars does not replicate.** VIVO exposes a
   standalone, crawlable page per publication (`/display/pubid…`) — the biggest bucket in the
   export. Scholars surfaces publications *inside* profiles, with no standalone indexed pubid
   URL. **Risk:** any Google traffic those pubid pages currently earn has no 1:1 Scholars
   landing target. **Decision (made):** `pubid<N>` is the PMID, so cutover 301-redirects each
   `/display/pubid<PMID>` to the owning WCM author's profile (which server-renders the paper
   title), not a 410/home — see `vivo-cutover-redirect-runbook.md` D-06–D-09. Ties to
   ANALYTICS-04 `vivo_404`.
4. **Long tail = breadth matters more than top-N.** No handful of pages carries VIVO; the
   value is thousands of profiles/papers each getting a trickle. Scholars must keep the
   *whole corpus* indexable, not just optimize the homepage/search.

## 4. How to run the post-launch comparison

Once #595 §1 (New Relic Browser agent) is live on Scholars and CSP (#374) allowlists
`*.nr-data.net`:

- **Volume:** `SELECT count(*) AS pageviews, uniqueCount(session) AS sessions FROM PageView
  WHERE appName = '<Scholars>' SINCE 1 month ago` — compare to the table in §1.
- **Deep-landing retention:** facet PageView by `parsedReferrer.referringDomain`; the share
  arriving from `google.*` is the metric that should survive cutover.
- **Per-profile parity:** facet by `pageUrl`; spot-check that high-traffic VIVO profiles
  (`ccole`, `map9500`) have a healthy Scholars equivalent and aren't stranded by a redirect
  gap.

## 5. Provenance

- Tool: New Relic Browser (RUM), VIVO entity, `PageView` events.
- Window: the full retained ~30 days ending 2026-05-30 (retention is the limiting factor — no
  older data exists).
- **Raw exports are committed** alongside this summary (so the numbers don't rely on a
  secondary analysis):
  - [`data/vivo-pageview-baseline/vivo-pageview-totals-2026-05-30.csv`](./data/vivo-pageview-baseline/vivo-pageview-totals-2026-05-30.csv)
    — the `Pageviews,Sessions` totals.
  - [`data/vivo-pageview-baseline/vivo-top-pages-2026-05-30.csv`](./data/vivo-pageview-baseline/vivo-top-pages-2026-05-30.csv)
    — the top-5,000 URL FACET (Page Url, Count).
  These are public web URLs (no PII); the CWIDs they contain are public identifiers already
  vendored elsewhere in the repo (`data/vivo-redirects.json`). The full-fidelity originals are
  also retained off-repo. The `not committed` rule in `.gitignore` applies only to the
  generated 9k-row redirect *map output*, not to these.

*Baseline captured 2026-05-30. This is a point-in-time pre-cutover snapshot; it is not
expected to be re-measured against VIVO (which is being decommissioned).*
