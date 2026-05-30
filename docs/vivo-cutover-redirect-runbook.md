# VIVO → Scholars cutover: 301 redirect runbook

How to forward legacy VIVO profile traffic to the new Scholars site at cutover,
preserving Google ranking signal. **Staged — execute at cutover, not before.**

## What already exists (don't rebuild)

| Piece | Path | Covers |
|---|---|---|
| B14 middleware (#113) | `middleware.ts`, `data/vivo-redirects.json` | Legacy paths that hit the **new** host (`scholars.weill.cornell.edu/display/cwid-X`) → `/scholars/by-cwid/X` → current slug |
| RewriteMap generator | `etl/vivo-redirect/generate-map.ts` (`npm run etl:vivo-redirect`) | Produces the cwid→URL map the **VIVO host** consumes |
| **nginx server config** | `etl/vivo-redirect/vivo-redirect.nginx.conf` | The VIVO-host `map{}` + `location` that issues the outbound 301s (this runbook's new piece) |
| Rank tracker | `scripts/seo/*`, `docs/seo-rank-tracking.md` | Before/after Google-position measurement |

Two redirect layers, by design: B14 catches stragglers that already resolved to
the new host; the VIVO nginx config catches everyone still hitting the old host.

## Why 301 (not 302)

A permanent redirect transfers ranking signal to the new URL and is cached by
Google and browsers. The whole point of doing this *at* cutover (not after VIVO
is gone) is that the link equity built up over ~10 years flows to Scholars
instead of evaporating. Expect a 2–6 week reindex dip, then recovery.

---

## Sequence

### 0. Before cutover — capture the baseline (irreversible window)
- [ ] Verify **both** `vivo.weill.cornell.edu` (or whichever host is live) and
      `scholars.weill.cornell.edu` in Google Search Console. GSC backfills ~16
      months on verification — you cannot get VIVO's history after it's gone.
- [ ] Capture the legacy rank baseline while VIVO is still live:
      ```bash
      export SERPAPI_KEY=…
      npm run seo:track -- --dry-run      # sanity + cost
      npm run seo:track                   # → data/seo/snapshots/rank-<ts>.json
      ```
      Keep this snapshot file safe — it is the "before."

### 1. Generate the redirect map (prod data)
- [ ] Run the generator against production so slugs/aliases are current:
      ```bash
      npm run etl:vivo-redirect            # → etl/vivo-redirect/output/vivo-redirect.map
      ```
- [ ] Sanity-check the count (≈ active scholars + aliases) and spot-check a few
      lines: `head etl/vivo-redirect/output/vivo-redirect.map`.
      The artifact contains CWIDs and is **gitignored** — never commit it.

### 2. Deploy to the VIVO host (the staged bundle)
- [ ] Copy the map artifact to the VIVO server, e.g. `/etc/nginx/scholars/vivo-redirect.map`.
- [ ] Install `etl/vivo-redirect/vivo-redirect.nginx.conf`: the two `map_hash_*`
      directives and both `map {}` blocks into `http {}`; the `location` block
      (commented at the bottom of the file) into the VIVO `server {}`. Adjust the
      `include` path to where you staged the `.map`.
- [ ] Validate before reload: `nginx -t`.
- [ ] Reload: `nginx -s reload` (or the platform's managed reload).

> If VIVO is **not** fronted by nginx (e.g. Apache, or a NetScaler/WAF tier —
> cf. the launch edge/WAF track), this nginx config is a reference contract:
> reproduce the same rule (extract cwid from the three path forms → look up →
> 301, else fall through) in that platform's syntax. The generated `.map` is
> plain `key value` lines and is portable.

### 3. Verify the redirects
- [ ] Active scholar 301s to the live slug:
      ```bash
      curl -sI https://vivo.weill.cornell.edu/display/cwid-<known-cwid> | grep -i '^location\|HTTP'
      # expect: HTTP/.. 301  +  location: https://scholars.weill.cornell.edu/scholars/<slug>
      ```
- [ ] Each path variant (`/display/`, `/individual/`, `/profile/`) redirects.
- [ ] An unknown CWID falls through (404/410, not a redirect loop or 500).
- [ ] No redirect chain longer than one hop for the common case.

### 4. Tell Google
- [ ] In GSC for `scholars.weill.cornell.edu`: submit the sitemap
      (`app/sitemap.ts` serves it) and request indexing for a few key pages.
- [ ] Use GSC's URL Inspection on a couple of redirected VIVO URLs to confirm
      Google sees the 301 and the new canonical.

### 5. Measure after (the brag)
- [ ] At ~30 and ~90 days, snapshot the new site and diff against the baseline:
      ```bash
      npm run seo:track
      npm run seo:diff -- --before <baseline.json> --after <latest.json> --csv data/seo/rank-diff.csv
      ```
- [ ] Lead with **topical** movement and GSC impressions/clicks/coverage growth,
      not branded #1s (see `docs/seo-rank-tracking.md` for why).

---

## Publication URLs (`/display/pubid<PMID>`) — the second redirect class

**This is not optional tail traffic.** In the pre-cutover baseline
([`vivo-pageview-baseline.md`](./vivo-pageview-baseline.md)) publication pages were
**~48% of captured pageviews** (13,551 / 28,070 in the top-5,000 export) — plausibly
**~half of all VIVO traffic**. A blanket `410`/drop here forfeits roughly half the link
equity at cutover, defeating the purpose of this runbook. They get their own redirect class.

**Key fact (verified 2026-05-30):** VIVO's `pubid<N>` **is the PMID** — every sampled
`/display/pubid<N>` resolves to PMID `<N>` in the Scholars `publication` table (keyed by
`pmid`). Scholars has **no public per-publication page** (no crawlable `/publications/<pmid>`),
so there is no 1:1 target. But because we know each paper's WCM authors
(`publication_author`: `pmid -> cwid`, with `position`/`is_first`/`is_last`/`is_confirmed`),
we can route a publication to the profile of a *relevant* author — landing the visitor on a
real, related page instead of a 404. (The profile's publication list is a **client component**
with filter/collapse behavior; it SSRs on initial load but do not assume every title is in the
initial HTML — see the SEO caveat.)

### Decision: 301 -> the owning WCM author's profile

| ID | Decision |
|---|---|
| **D-06** | Extend `etl/vivo-redirect/generate-map.ts` to emit a **second map**: `pubid<PMID> -> https://scholars.weill.cornell.edu/scholars/<slug>`. Same generator run, same artifact bundle. |
| **D-07** | **Author pick (deterministic, one per PMID).** Consider only `publication_author` rows where `cwid IS NOT NULL AND is_confirmed = 1` **and the scholar is active with a live slug** — *active is a hard gate at every step.* Pick in order: **(1) first author** (`is_first`); else **(2) senior author** (`is_last`); else **(3) earliest remaining rank** (lowest `position`), final tiebreak on `cwid`. Rationale: credit who did the work, fall back to the senior/lab home when the first author has left WCM. |
| **D-08** | **Unresolvable PMIDs** (no confirmed WCM author with a live slug -- author left, paper dropped from corpus) **fall through to 404**, consistent with the cwid rule **D-03**. `410 Gone` is the more-correct-but-optional refinement for "no equivalent." |
| **D-09** | **Status code 301**, same as profiles -- these pages have ~10 years of indexed link equity worth transferring. |

**Why not the alternatives:**
- **Not `410`/drop-all** -- forfeits ~half of VIVO's traffic (see baseline). 410 only for the
  unresolvable minority (D-08).
- **Not a blanket `301 -> /` home redirect** -- Google discounts mass redirects to an
  unrelated home page as soft-404s; it dilutes canonical signal and passes little equity.
- **Not building a net-new `/publications/<pmid>` route just for cutover** -- that's real
  product scope (the very gap the baseline doc flagged). If it ships later, repoint D-06's
  map target to it; the redirect contract is unchanged.

**Honest SEO caveat.** An author profile is *related*, not *equivalent*, to a single-paper
page, so Google may pass only **partial** signal and may treat some as soft-404s — **more so
because the profile's publication list is a client component with progressive disclosure, so a
given (often older) paper's title may not sit in the initial server-rendered HTML.** Treat the
primary win as **user relevance** (a real, related landing page rather than a dead link); the
SEO equity transfer is a bonus, not a guarantee. Even so, partial-via-301 beats zero-via-410
and beats discounted-via-home-redirect. **Verify per-PMID** with the curl check below before
relying on title-keyword preservation; if it matters, the durable fix is the net-new
`/publications/<pmid>` route (repoint D-06), not this redirect.

### Mechanism (nginx -- second `map{}` + `location`)

Mirror the cwid pattern with a PMID-keyed map. In `http {}`:

```nginx
# generated by `npm run etl:vivo-redirect` (D-06) -- pubid<PMID> -> scholar URL
map $pubid_extracted $pub_redirect {
    include /etc/nginx/scholars/vivo-pub-redirect.map;   # "<pmid> <url>;" lines
}
```

In the VIVO `server {}` (sibling to the cwid `location`):

```nginx
location ~ ^/display/pubid(?<pubid_extracted>\d+)/?$ {
    if ($pub_redirect) { return 301 $pub_redirect; }
    return 404;            # D-08 fall-through (or 410 for the purist refinement)
}
```

### Verify (add to § 3)

- [ ] A known multi-author PMID 301s to **one** live author slug:
      `curl -sI https://vivo.weill.cornell.edu/display/pubid<known-pmid> | grep -i '^location\|HTTP'`
- [ ] The destination profile's **initial** HTML actually contains that paper's title
      (`curl -s <location> | grep -i "<a few title words>"`). If absent, the title is behind
      client-side progressive disclosure → the redirect is fine for users but weak for SEO.
- [ ] A PMID with no confirmed WCM author falls through to 404 (not a loop/500).

---

## Org-unit URLs (`/display/org-u<N>`) — the third redirect class

Org-unit pages get real traffic too (baseline: `org-u18` = 133 views, `org-u27` = 39, ~44
distinct org URLs / ~495 views). Scholars has equivalents: `/departments/<slug>`,
`/centers/<slug>` (divisions roll up to their parent department — there is no `/divisions`
route). So these should redirect, not 404.

**The hard part is the crosswalk.** Unlike cwid (direct) and pubid (= PMID, direct), VIVO's
`org-u<N>` is a **VIVO-internal sequential id** that **does not match** Scholars org codes
(departments use WCM N-codes like `N1280`; centers use slug-codes like `meyer_cancer_center`).
There is no `u<N> → code` key in the Scholars DB. The map must be built by resolving each
`org-u<N>` to its **name**, then matching that name to the Scholars department/center.

### Decision

| ID | Decision |
|---|---|
| **D-10** | Redirect `/display/org-u<N>` **301 →** `/departments/<slug>` or `/centers/<slug>`; divisions → their parent department's `/departments/<slug>`. |
| **D-11** | **Scope = only the org URLs with traffic.** We already have that exact list from the baseline export (the `org-u<N>` rows in `vivo-top-pages-2026-05-30.csv`, ~44 ids) — do **not** blind-crawl `u1..uN`. Resolve only what's visited. |
| **D-12** | **Hand-built, reviewed crosswalk** checked in as `data/vivo-org-redirects.json` (small + reviewable, like `data/vivo-redirects.json`) → consumed by a third nginx `map{}`. Not auto-generated from the Scholars DB (the `u<N>` key isn't there). |
| **D-13** | Unresolvable / defunct orgs (merged or no Scholars equivalent) **fall through to 404** (410 optional), per D-03/D-08. |

> ⚠️ **VIVO is fragile — resolve org names gently.** Building the crosswalk means reading each
> visited org's name off VIVO (`/display/org-u<N>`), since the name isn't in our data.
> **VIVO crashes under aggressive querying** (cf. its 10-year incident history). So fetch
> **sequentially, throttled, lowest id first and working up** (`org-u1`, `u2`, …), with a
> delay between requests — never a parallel/bulk sweep. Better still: do it **before**
> cutover while VIVO is healthy, and cache the `u<N> → name` results so the crosswalk is built
> once. ~44 ids at a polite pace is a few minutes, not a load test.

### Mechanism (nginx — third `map{}`)

```nginx
# data/vivo-org-redirects.json compiled to "<u-id> <url>;" lines
map $orgid_extracted $org_redirect {
    include /etc/nginx/scholars/vivo-org-redirect.map;
}
```
```nginx
location ~ ^/display/org-(?<orgid_extracted>u\d+)/?$ {
    if ($org_redirect) { return 301 $org_redirect; }
    return 404;        # D-13 fall-through
}
```

---

## Out of scope (decide separately)

- **VIVO index / nav URLs** (`/search`, `/browse`, `/people`, `/organizations`,
  `/individuallist`, `/research`, `/home`, research-area pages, static assets). The
  config forwards `/(display|individual|profile)/cwid-X`, `/display/pubid<PMID>`, and
  `/display/org-u<N>`. Options for the
  rest: a blanket `301 → https://scholars.weill.cornell.edu/`, a `410 Gone`, or
  leave VIVO serving them during a sunset window. Blanket-redirecting unrelated
  URLs to the home page can dilute canonical signals — prefer 410 for content
  that has no Scholars equivalent.
- **VIVO host decommission timeline** — the redirects must outlive Google's
  recrawl (keep them up for at least several months, ideally a year).
- **WAF/edge interaction** — if a NetScaler/WAF sits in front of VIVO, confirm
  it passes these paths through to nginx (or implement the rule there instead).
