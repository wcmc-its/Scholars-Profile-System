# How WCM scholars show up in Google & AI answers — handoff

A plain-language handoff for a broad audience — faculty of any rank, communications,
department/center web owners, and the dev team — so anyone can understand the findings
and help, not just senior professors or engineers. Technical detail lives in
`docs/seo-rank-tracking.md` and `docs/seo-llm-rank-tracking.md`; the working items are
GitHub issues #594, #574, #683, #684, #502, #125.

## TL;DR
Before the new Scholars site goes live, we measured how WCM researchers surface in
Google and in AI assistants (ChatGPT, Perplexity, Gemini). Two takeaways:

1. **WCM is a recognized name** in many fields — competitive with Harvard/Stanford/Yale
   at the institution level.
2. **But the scholar *profiles* rarely surface.** Google and AI tend to cite lab sites,
   department pages, center microsites, news, Wikipedia, and clinical bios *instead of*
   the structured profile — and competitors' profile platforms aren't cited either. It's
   an open opportunity, and the fix is largely **linking**.

## What we found (plain language)
- **Name searches** ("Jane Smith Weill Cornell"): the profile is **healthy and present** —
  in a rank-stratified sample of 32 faculty it surfaced for 29 (top-3 for two-thirds) and was
  *never* missing entirely. But it's usually **not #1**: the person's own **WCM clinical bio
  (`weillcornell.org`) is the #1 result for ~62% of faculty**, with the Scholars profile a slot
  or two behind; for lab-running scientists the **department or lab-site page** outranks it
  instead. So the issue isn't a buried/absent profile — it's that **another WCM page of the same
  person sits just above it**. (Measured with the rank-stratified instrument, not eyeballed —
  see "Broaden the sample" below.)
- **Topic searches** ("who is an expert in X"): WCM appears in ~7% of AI answers
  (competitive), but **almost never via the Scholars profile** — and no peer institution's
  profile platform is cited either.
- **What AI "knows":** assistants recognize WCM as a player in roughly half of major fields
  from their training data, but rarely name a *specific* WCM scientist or feature them
  prominently.

## What YOU can do (any rank — especially junior faculty)
- **Link to your Scholars profile** from your lab site, department bio, center/program page,
  Google Scholar, and email signature — label it "Research profile" or "Publications."
- **Clinical faculty: link your `weillcornell.org` clinical bio to your Scholars profile.**
  That clinical bio is the page Google ranks #1 for most clinicians' names — pointing it at
  your profile is the single most effective thing you can do, since it already wins the search.
- **Keep your profile complete and accurate** — it's the page we want Google and AI to treat
  as your canonical record.
- **Junior / early-career faculty: this matters most for you.** You may not have a lab site
  or Wikipedia page, so your Scholars profile is often your main structured web presence —
  and with less competition, it's your best shot at ranking #1 for your own name and being
  the source AI cites.

## Broaden the sample — beyond senior professors (done; re-runnable)
The original measurement used the **top-30 scholars by publication count** (senior-skewed),
which over-stated a "buried profile" problem. There is now a committed **rank-stratified
instrument** that samples evenly across seniority (Instructor / Assistant / Associate / full
Professor) so the name-search picture is fair institution-wide:

```
npm run seo:basket -- --mode cohort --per-rank 8        # data/seo/rank-cohort-basket.json (committed)
npm run seo:track  -- --basket data/seo/rank-cohort-basket.json --capture-top 5
npm run seo:cohort                                       # per-tier table + who-outranks-whom
```

**What it showed (N=32, 2026-06-03):** the profile surfaced for **29/32** and was top-3 for
**21/32** — and **0/32** had "no WCM result at all" (the earlier no-result cases were
bare-name *ambiguity*, not indexing gaps). The real predictor of "profile isn't #1" is
**having a competing WCM page** — overwhelmingly the **clinical bio (`weillcornell.org`, #1 for
20/32)**, secondarily a lab/department page for research PIs — **more than rank itself**. Full
write-up + per-name table in #684; re-run post-cutover to confirm the new host inherits the
position via 301.

## What the team is tracking (issues)
| Issue | What |
|---|---|
| #594 | The measurement instrument + pre-cutover baselines (the "before") |
| #574 | Google organic + Search Console baseline |
| #683 | The lever: link the pages that already rank → the Scholars profile (+ make profiles canonical) |
| #684 | Prominent faculty whose profile is outranked for their own name |
| #502 / #125 | **Prerequisite:** the new site must let Google + AI crawlers in, or none of this can improve |

## The one hard dependency
None of these improvements can register until `scholars.weill.cornell.edu` is **publicly
reachable by search and AI crawlers** (not just people behind the firewall). That's the
WAF/bot-access decision in #502 / #125 — it gates every "after" measurement.

## Where the evidence & tools live
- **Docs:** `docs/seo-rank-tracking.md` (Google), `docs/seo-llm-rank-tracking.md` (AI answers)
- **Query baskets (committed):** `data/seo/flagship-queries.json` (broad topics),
  `data/seo/specific-queries.json` (specific subtopics), `data/seo/rank-basket.json` (names + topics),
  `data/seo/rank-cohort-basket.json` (rank-stratified name cohort, #684)
- **Baselines:** snapshots are gitignored; provenance + numbers in `data/seo/gsc/BASELINE.md`
- **Re-measure (operator, needs API keys):** `npm run seo:track`, `seo:cohort`, `seo:llm-rank`,
  `seo:llm-mention`, `seo:standings`
