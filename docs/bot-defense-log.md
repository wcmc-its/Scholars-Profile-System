# Bot defense log

A running record of automated-traffic incidents on the public site and what we did about each one. Add an entry for every new crawler or scraper wave, rule change, or rollback, newest first. Do not record client IP addresses here; this repo is public. User agents, countries, rule names and counts are fine.

Where to look:
- **Attribution:** WAF logs, CloudWatch log group `aws-waf-logs-sps-<env>` (fields `httpRequest.clientIp`, `httpRequest.country`, `ja4Fingerprint`, `labels`, `terminatingRuleId`). ALB access logs can't attribute clients: since the 11-11 cutover an upstream load-balancer tier sits between CloudFront and the ALB, so every ALB client IP is that tier.
- **Rules:** `cdk/lib/edge-stack.ts` (`EdgeWebAcl`). Rule metric names are `sps-edge-<env>-<rule-name>`.
- **Options not yet taken:** issue #3368.

## Current defenses on `/search*`

| Priority | Rule | Action | Since |
|---|---|---|---|
| 5 | `search-block-bots` (Bot Control bot label on `/search*`) | Block | #3365 |
| 6 | `search-block-scraper-ua` (exact Chrome/133 Mac UA on `/search*`) | Block | #3367 |
| 7 | `search-rate-limit` (500 per 5 min per IP on `/search*`, campus exempt) | 429 | #3365 |
| 8 | `rate-limit` (5000 per 5 min per IP, verified bots exempt) | Block | #125 |

Also: `robots.txt` disallows `/search` (#3365), and home-page suggestion links no longer prefetch `/search` (#3370).

## 2026-11-13: scraper rotates its user agent

**Seen.** After the Chrome/133 block went live, `/search` traffic stayed at roughly 10k to 90k requests an hour. From 04:00Z to about 13:30Z the edge allowed about 118k `/search` requests and blocked about 42k, almost all of them the old UA. Most of the allowed traffic came from three new sources:

| User agent | Countries | Distinct IPs | `/search` requests |
|---|---|---|---|
| Chrome/157, Linux | US only, one TLS fingerprint family | ~1.7k | ~52k |
| Chrome/137, Windows | MX, UA, TR (same as the 11-12 scraper) | ~1.5k | ~38k |
| Chrome/156, Linux | not broken down | ~1.2k | ~12k |

The Chrome/157 fleet runs a real headless browser: it loads `/`, `/about` and static assets, then walks `/search` facets through Next.js client navigation (`?_rsc=` fetches with a `/search` referer). None of it carries a Bot Control label.

**Impact.** None user-visible. The worst hourly p99 was 1.2s with no ELB 5xx errors, and all prod tasks stayed healthy.

**Action.** Chose option 4 from #3368: Bot Control TARGETED plus a Challenge on `/search*` (PR in progress; staging trial before prod). We did not add more exact-UA blocks, since the scraper has already shown it will rotate.

## 2026-11-12: `/search` facet crawl takes prod down

**Seen.** Crawlers walked `/search` facet combinations, and every combination is a unique, uncacheable URL that costs one OpenSearch query. OpenSearch saturated, and all prod app tasks died with `JavaScript heap out of memory` around 13:15 ET. ALB p99 peaked at 21s and `sps-alb-latency-p99-prod` paged. Sources:
- A residential-proxy scraper with the stale UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36`. It used ~26k IPs at about 2 requests each, mostly from SG, BR, MX, UA and TR, with no Bot Control label.
- GPTBot and Googlebot (both verified) deep-walking facets. Verified bots are exempt from the global rate limit.
- Our own home page: viewport prefetch on the Try chips caused about 220k uncached `/search` queries a day.

**Action.**
- #3365: `robots.txt` disallows `/search`. Added WAF `search-block-bots` and `search-rate-limit`. Set `NODE_OPTIONS=--max-old-space-size` to 75% of task memory, since the Dockerfile flag only applied at build time.
- #3367: `search-block-scraper-ua`, an exact-UA block. A stopgap, because one UA change defeats it.
- #3369: the Usage rollup excludes bot UAs, WAF-blocked and edge-error requests, and non-page paths. Days back to 2026-08-19 were re-rolled.
- #3370: `prefetch={false}` on home-page links to `/search`.
- Write-up and remaining options: #3368.
