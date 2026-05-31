# CloudFront cache-behavior specification

Concrete spec for the production CloudFront distribution in front of `scholars.weill.cornell.edu`. This is the CDK / IaC reference: every behavior, cache policy, origin request policy, and path pattern below should appear verbatim (or as the equivalent AWS-managed-policy reference) in the distribution definition.

Source policy text: [`PRODUCTION_ADDENDUM.md` § Cookies and the cache key](./PRODUCTION_ADDENDUM.md#cookies-and-the-cache-key) and [`PRODUCTION.md`](./PRODUCTION.md). This document is the implementation projection of those policies onto the route inventory that exists in `app/`.

## Principles

1. **Cookies are forwarded only on writer routes.** Forwarding cookies on cacheable routes fragments the cache per session, which kills hit rate and silently leaks one user's cached HTML to another. Writer routes need cookies because the SSO session lives there (B01 #100).
2. **Default deny on TTL.** The default behavior caches; specific writer/operational behaviors override. New routes should land in the cacheable default unless the PR explicitly carves them into an uncacheable behavior with a justification.
3. **Origin headers win over CloudFront defaults where the origin sets `Cache-Control`.** Routes like `/api/export/*` set `Cache-Control: no-store` at the origin; the cacheable behavior already respects origin headers, but routes that must never cache regardless of origin behavior are belt-and-suspenders'd into the uncacheable behavior anyway.

## Behaviors (ordered, specific-first)

CloudFront evaluates path patterns in order. Specific patterns must precede the default `*`.

| # | Path pattern | Cache policy | Origin request policy | Allowed methods | Notes |
|---|---|---|---|---|---|
| 1 | `/api/edit*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | Writer route. Forwards all cookies, headers, query string. Does not yet exist in code (lands with B01 #100 + B02 #101). |
| 2 | `/edit*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | Writer page route — `/edit*` (not `/edit/*`) so the bare `/edit` self-editor also forwards cookies; `/edit/*` does not match `/edit` and would fall to the cacheable default behavior (cookie stripped → SSO redirect loop). Same auth as `/api/edit*`. |
| 3 | `/api/auth/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, POST | SSO endpoints (B01 #100) — SAML login redirect, ACS callback (POST), SP metadata, logout (POST). Forwards all cookies; the session cookie is set here, so these responses must never be edge-cached. Pairs with the `/api/edit*` and `/edit*` writer behaviors above. |
| 4 | `/api/revalidate*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST | Mutating endpoint reachable only from the internal-only ALB listener (B05 #104). Behavior exists for defense-in-depth so a misconfigured origin cannot accidentally be cached at the edge. |
| 5 | `/api/health/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | Operational endpoint; staleness here would mask outages. Origin already sets `force-dynamic`. |
| 6 | `/api/analytics` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, POST | Telemetry POST. CloudFront does not cache POST regardless, but explicit behavior keeps the cache key from being computed against forwarded cookies. |
| 7 | `/api/export/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | `/api/export/publications/<granularity>` is a **POST** handler (large filter body), `Cache-Control: no-store`. ALLOW_ALL, not GET-only — the GET-only form 403'd the POST at the edge so the export never worked through CloudFront. |
| 8 | `/api/csp-report` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | The CSP `report-uri`/`report-to` collector (`lib/security-headers.ts`). Browsers POST violation reports here; the GET-only default 403'd them all → reports silently dropped at the edge. |
| 9 | `/api/nih-resolve` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | POST batch resolver fired from profile/funding pages (`lib/use-nih-resolve.ts`). Default GET-only behavior 403'd every resolve → NIH award links silently failed on live profiles. |
| 10 | `/api/feedback/submit` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | POST from the feedback form (`components/feedback/feedback-form.tsx`). Same default GET-only 403; breaks submission once `FEEDBACK_BADGE_ENABLED` is on. |
| 11 | `/api/search*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | Query-string dynamic GET (`force-dynamic`). The cacheable default strips `?q` and caches a match_all for everyone (#490). Covers `/api/search` and `/api/search/suggest`. |
| 12 | `/search*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | The search PAGE, same strip as the API (#624). `#632` made the origin render sub-0.5s, so no caching benefit is lost. |
| 13 | `/api/directory/people` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. SSO-gated typeahead; reads `q`/`cwids` **and** the session cookie → needs AllViewer. |
| 14 | `/api/nih-portfolio` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. RePORTER click-through proxy; reads `cwid`/`profile_id`, 302s. |
| 15 | `/api/scholars/*/popover-context` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. Person-popover context; reads `surface`/`context*`. |
| 16 | `/api/topics/*/publications` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. Topic publication feed; reads `sort`/`filter`/`subtopic`/`tier`/`page`. |
| 17 | `/about/feedback` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. `force-dynamic` page; reads `?from=` for contextual mode **and** the session cookie to prefill. |
| 18 | `/scholars/*/co-pubs/export` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. `no-store` download; reads `?format=`. **Must precede #20** (`/scholars/*` would otherwise swallow it). |
| 19 | `/scholars/*/co-pubs/*/export` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | #634 Group A. Per-mentee variant of #18. |
| 20 | `/scholars/*` | `sps-query-keyed-${env}` (custom) | **None** (cookies stripped) | GET, HEAD, OPTIONS | #634 Group B. Profile page (highest traffic); reads `mentees-sort`. |
| 21 | `/departments/*` | `sps-query-keyed-${env}` (custom) | **None** (cookies stripped) | GET, HEAD, OPTIONS | #634 Group B. Dept + `…/divisions/*` listings; read `page`/`tab`/`sort`. |
| 22 | `/centers/*` | `sps-query-keyed-${env}` (custom) | **None** (cookies stripped) | GET, HEAD, OPTIONS | #634 Group B. Center listings; read `page`/`tab`/`sort`. |
| 23 | `/topics/*/scholars` | `sps-query-keyed-${env}` (custom) | **None** (cookies stripped) | GET, HEAD, OPTIONS | #634 Group B. ISR page; reads `q`/`role`/`page`. Stays cacheable, keyed per query. |
| 24 | `*` (default) | `CachingOptimized` | **None** (do not forward cookies, headers, or query string beyond the cache-policy spec) | GET, HEAD, OPTIONS | All remaining cacheable routes — read-only pages and API, sitemap, OG images. **Note:** this policy strips the query string from the cache key (see §Cache key); routes that depend on it get a dedicated behavior above. |

> **Ordering note (#634):** CloudFront uses the **first** matching behavior in list order (not most-specific). The two `/scholars/*/co-pubs/*export` behaviors (#18/#19) must therefore be evaluated **before** `/scholars/*` (#20), since `*` spans slashes and `/scholars/*` matches `/scholars/<slug>/co-pubs/export`. The CDK emits all uncacheable behaviors before the Group B query-keyed ones, which preserves this.

> **Mutating-method note:** rows #7–#10 (plus the existing ALLOW_ALL writer/auth/revalidate/analytics behaviors) carry POST because the default behavior allows only GET/HEAD/OPTIONS — an uncovered mutating route is **403'd at the edge** before the origin sees it. A synth-time guard (`edge-stack.test.ts`) now ratchets this: any `route.ts` exporting POST/PUT/PATCH/DELETE without an ALLOW_ALL behavior fails the test.

`AllViewer` is AWS-managed origin request policy `Managed-AllViewer` (`216adef6-5c7f-47e4-b989-5492eafa07d3`). `CachingDisabled` and `CachingOptimized` are `Managed-CachingDisabled` (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) and `Managed-CachingOptimized` (`658327ea-f89d-4fab-a63d-7e88639e58f6`) respectively. `sps-query-keyed-${env}` is the **custom** cache policy defined in `EdgeStack` (see §Cache key — query-keyed cacheable pages).

## Cache key (default cacheable behavior)

- **Query strings:** the default behavior uses `Managed-CachingOptimized`, which **excludes** the query string from the cache key (`QueryString=none`). ⚠️ **This was originally mis-documented here as "includes all query strings" — it does not, and that misconception is the #490 / #624 / #634 root cause.** A route that depends on its query string (`/search?q=…`, pagination, filters, selectors) and lands on the default behavior has `?q` stripped before the origin *and* one query-less response cached for everyone. Such routes are therefore **carved into a dedicated behavior** (see the table above), not left on the default.
- **Headers:** `Managed-CachingOptimized` includes only `Accept-Encoding` in the cache key. The `Accept` / `Accept-Language` allowlist this doc originally called for is unused by any route (no content negotiation, no i18n), so the managed policy is correct; a custom default policy would be needed only if a route is added that varies on those headers. Specifically **not** `User-Agent` (would fragment per device) and **not** `Cookie` (would defeat the entire point of this split).
- **Cookies:** **none.** Do not forward, do not include in cache key. This is the single most important knob in this document.

### Cache key — query-keyed cacheable pages (`sps-query-keyed-${env}`, #634)

Some high-traffic ISR pages (profile, dept/center/division, topic-scholars) read `searchParams` for a sub-feature (selector / tab / page / sort / role) but must **stay edge-cacheable** — making them `CachingDisabled` would kill caching of the most-visited content. They use a **custom cache policy** that keeps them cacheable while keying on the query string:

- **Query strings:** **allow-list**, not all — only the params these pages actually read: `mentees-sort`, `page`, `tab`, `sort`, `q`, `role` (the union across the Group B routes). Allow-list (rather than `all`) so tracking params (`utm_*`, `fbclid`, `gclid`) on inbound campaign links don't fragment the profile-page cache. Trade-off: a **new** param added to one of these pages must also be added to the allow-list in `EdgeStack`, or it is silently stripped (a narrow re-run of the #490 class the synth guard does not catch — it only verifies that *some* behavior forwards the query string).
- **Cookies:** **none** — same as the default; no `AllViewer`, so cookies are never forwarded (no per-session fragmentation, no cookie leak).
- **Headers:** none beyond `Accept-Encoding` (gzip + brotli on).
- **TTLs:** mirror `Managed-CachingOptimized` (min 1 s / default 24 h / max 1 y), so caching behaves identically to the default except the query string now keys the cache.

The cache-policy inspector (CloudFront console → Cache Policies → Test) should produce **the same cache key** for these two requests, and the smoke test in §Verification confirms it:

```
GET /scholars/jane-smith
Cookie: session=user-A

GET /scholars/jane-smith
Cookie: session=user-B
```

## Cache TTLs

| Behavior class | Min TTL | Default TTL | Max TTL |
|---|---|---|---|
| Default cacheable | 0 | 86400 (24 h) | 31536000 (1 y) |
| Uncacheable | 0 | 0 | 0 |

Default TTL is 24 h to match the `revalidate = 86400` declaration on `/scholars/[slug]` and `/sitemap.xml`. Origin `Cache-Control: max-age=…` (e.g. on `/og/*`) overrides the default. Min TTL of 0 lets `Cache-Control: no-store` from the origin take effect; max TTL of 1 y is a ceiling, not a target.

## Verification

Acceptance criteria for B07 #106:

1. **Distribution has at least two behaviors** — the table above defines the default plus 23 additional behaviors; minimum is satisfied as long as the default cacheable + at least one uncacheable behavior exist.
2. **Cache key inspector test** — same URL with two different `Cookie:` values produces the same cache key for any path covered by the default behavior. Run from the CloudFront console: Distribution → Behaviors → Default → Cache Policy → "Test cache policy."
3. **Writer route forwards cookies** — `curl -v https://<staging-domain>/api/edit/ping --cookie "session=test"` and confirm the origin access log records `session=test` in the request headers.
4. **End-to-end edit smoke test** — once B01 #100 (SSO) and B02 #101 (authz predicate) land, perform a full self-edit through CloudFront and confirm the write reaches Aurora and the audit log captures it. Blocked on those issues.

## Open routes (not addressed by the addendum)

The addendum names a subset of routes; the codebase has more. The following are placed by judgment:

- `/about`, `/about/methodology`, `/browse`, `/topics/*` (the topic detail page) — cacheable, no session or query-string reads. **Leave in default cacheable.**
- `/centers/*`, `/departments/*` (+ `…/divisions/*`), `/scholars/*`, `/topics/*/scholars` — cacheable **but** read `searchParams`. **Updated by #634:** these now have dedicated **query-keyed** behaviors (`sps-query-keyed-${env}`) so the page stays cached while the query string keys the cache. They were originally left on the default, which silently stripped the param (#634).
- `/api/scholars/*/popover-context`, `/api/topics/*/publications`, `/api/search`, `/api/search/suggest`, `/api/directory/people`, `/api/nih-portfolio` — read-only JSON / proxies that read the query string (and, for `/api/directory/people` + `/about/feedback`, the session cookie). **Updated by #490 / #624 / #634:** these now have dedicated `CachingDisabled` + `AllViewer` behaviors. Originally recommended for the default cacheable, which was wrong — `force-dynamic` disables Next's route cache but does **not** stop CloudFront caching, and the default stripped their query string.
- `/og/*` — origin sets `Cache-Control` aggressively, no query-string dependence. **Leave in default cacheable** so origin TTL is honored.
- `/sitemap.xml`, `/robots.txt` — origin uses `revalidate = 86400`. **Leave in default cacheable.**

A synth-time guard (`cdk/test/edge-stack.test.ts`) now **ratchets** this: any server route that reads `searchParams` without a forwarding behavior fails the test. If a new route should not be edge-cached, give it a `CachingDisabled` behavior; if it's a cacheable page reading the query string, add it to a query-keyed behavior (and add any new param to the allow-list).

## Why no `User-Agent` in the cache key

Mobile / desktop split is handled by responsive CSS, not separate origin responses. Adding `User-Agent` to the cache key would explode the cache (effectively unique per browser version) without serving different content. If a future requirement introduces device-specific origin responses, use a CloudFront managed cache policy that includes the `CloudFront-Is-{Mobile,Tablet,Desktop}-Viewer` headers, not raw `User-Agent`.

## What this spec does not cover

- **WAF rules** — see B26 #125 (verified-bot allowlist).
- **Security headers (HSTS, CSP, X-Frame-Options)** — see B21 #120. Those attach to CloudFront response-headers policies, not cache or origin-request policies, and are orthogonal to the split documented here.
- **Origin shield** — referenced in `PRODUCTION.md`; an enable/disable knob on the origin, independent of the per-behavior cache policies above.
- **Sitemap-index split** — see B25 #124. Affects what `/sitemap.xml` returns, not how it is cached.
