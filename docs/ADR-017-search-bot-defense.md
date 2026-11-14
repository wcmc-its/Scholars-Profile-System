# docs/ADR-017 — Bot defense on `/search`: challenge on evidence, not by default

**Status:** Accepted 2026-11-14. Ships in #3397; live once the app release and `Sps-Edge-<env>` deploy land.
**Date:** 2026-11-14
**Revision:** 1
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

`/search` is the one public surface where every distinct URL costs a live OpenSearch query. On 2026-11-12 crawlers and a residential-proxy scraper walking facet combinations saturated OpenSearch and took prod down (#3368). The scraper used about 26,000 IPs at roughly 2 requests each with a stock-Chrome fingerprint, so no per-IP limit and no user-agent rule holds against it.

The first durable fix (#3368 option 4) was Bot Control TARGETED on `/search*` plus a WAF Challenge for every request without a WAF token. It stopped the scraper. It also challenged every real visitor on their first search: a blank AWS interstitial, and a full page reload when a facet click arrived after the token's 4-hour immunity lapsed.

Prod WAF logs for the 24 hours to 2026-11-14 showed who was being challenged:

| How the tokenless request arrived | Requests |
|---|---|
| Client navigation (`_rsc`) from a page on the site | 65,219 |
| Full page load from an outside link (Google, old VIVO links) | 5,501 |
| Full page load, no referrer | 3,349 |

About 3,400 IPs searched with an accepted token over the same day. A first-time visitor whose first page is a `/search` link is therefore a large share of real traffic, not an edge case.

## Decisions

### D1. A real visitor is not challenged in normal operation

The challenge is a response to evidence of automation or to load, never the default for a person. Any change to `/search` defenses is judged first against what a first-time visitor sees.

### D2. Every page earns the token silently

The web ACL sets `AssociationConfig.ChallengeJavascriptSdkInjection`, so CloudFront inserts the AWS WAF challenge SDK into every `200 text/html` response. The SDK obtains the `aws-waf-token` cookie in the background and keeps it refreshed. A browser that has loaded any page of the site holds a token before it reaches `/search`.

The CSP allows `https://*.awswaf.com` in `script-src` and `connect-src` for this (ADR-007 amendment).

### D3. Tokenless client navigations are always challenged

`search-challenge-tokenless` challenges a tokenless `/search` request that carries an `_rsc` query parameter or an `RSC` header. A browser can only make such a request from a page it has already loaded, so under D2 a real visitor holds a token by then. This is 88% of tokenless `/search` traffic.

### D4. Tokenless full page loads are challenged only during a surge

`search-challenge-tokenless-surge` is a rate-based rule that counts tokenless `/search` page loads across all clients and challenges them only above 300 per 5 minutes. Below the limit a first-time visitor arriving from Google, a VIVO link or a bookmark is not challenged. Above it the blanket challenge returns on its own.

The count is aggregate rather than per IP because the scraper sends about 2 requests per IP. The limit sits above the observed baseline (median 29, p99 129, max 240 per 5 minutes, scraper included) and is about one OpenSearch query a second; the 11-12 outage ran at several times that.

### D5. Low-rate scraping of public search results is tolerated

Up to the D4 limit, tokenless page loads reach OpenSearch whether they come from a person or a scraper. The data is public and the load is small. The goal of these rules is availability, not preventing collection.

### D6. No CAPTCHA and no third-party checkbox

AWS WAF CAPTCHA is an image puzzle and more friction than the silent challenge. A checkbox widget (Turnstile, reCAPTCHA, hCaptcha) requires a click from every gated visitor, a custom gate at the edge, and in reCAPTCHA's case sends visitor data to a third party.

## Consequences

- A visitor who loads any page and then searches is never challenged. A visitor whose first page is `/search` is challenged only while a surge is in progress.
- Scraper requests under the D4 limit count as searches on the Usage dashboard.
- Deploy order: the CSP change (app release) must be live before the edge deploy. With the order reversed, the inserted script is blocked by our own CSP and real visitors' client navigations keep being challenged under D3.
- AWS rejects a web ACL update that removes Bot Control TARGETED while SDK injection is on. Remove both in one change.
- SDK injection applies to every HTML page behind the web ACL and cannot be limited to paths. With it on, CloudFront strips `Range` / `If-Range` on allowed requests and weakens `ETag` on modified HTML.
- AWS exposes no metric for whether the tag was inserted. Verify from page source in a private window and the `aws-waf-token` cookie.
- The D4 limit is a fixed number. Revisit it if the tokenless baseline drifts, using the `sps-edge-<env>-search-challenge-tokenless-surge` metric.

## Unchanged

`search-block-bots` (self-identified bots on `/search*`), `search-rate-limit` (500 per 5 minutes per IP), the site-wide `rate-limit`, and the TARGETED rule group's own rules for token reuse, session volume and automation signals. The last group is what catches a headless browser that does earn a token.

## Alternatives considered

- **Blanket challenge on tokenless `/search`** (the prior state). Rejected under D1.
- **Per-IP allowance for tokenless requests.** The scraper's requests-per-IP is the same as a first-time visitor's, so this admits all of it.
- **A branded interstitial in place of the AWS one.** Still an interstitial; not needed once D4 removes the challenge in normal operation.
- **Rendering `/search` as a shell and fetching results with the token.** Removes the cold-landing challenge even during a surge, at the cost of re-architecting the search page. Open if surges become frequent.

## References

- #3368 (incident and options), #3365, #3367, #3370, #3397
- `cdk/lib/edge-stack.ts` (`EdgeWebAcl`, `SdkInjectingWebAcl`)
- ADR-007 (CSP), amendment of 2026-11-14
