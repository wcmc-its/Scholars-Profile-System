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

## Out of scope (decide separately)

- **Non-profile VIVO URLs** (search, browse, org pages, static assets). This
  config only forwards `/(display|individual|profile)/cwid-X`. Options for the
  rest: a blanket `301 → https://scholars.weill.cornell.edu/`, a `410 Gone`, or
  leave VIVO serving them during a sunset window. Blanket-redirecting unrelated
  URLs to the home page can dilute canonical signals — prefer 410 for content
  that has no Scholars equivalent.
- **VIVO host decommission timeline** — the redirects must outlive Google's
  recrawl (keep them up for at least several months, ideally a year).
- **WAF/edge interaction** — if a NetScaler/WAF sits in front of VIVO, confirm
  it passes these paths through to nginx (or implement the rule there instead).
