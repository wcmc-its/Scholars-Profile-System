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
| 2 | `/edit/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | Writer page route. Same auth as `/api/edit*`. Does not yet exist in code (lands with B01). |
| 3 | `/api/revalidate*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, PUT, POST | Mutating endpoint reachable only from the internal-only ALB listener (B05 #104). Behavior exists for defense-in-depth so a misconfigured origin cannot accidentally be cached at the edge. |
| 4 | `/api/health/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | Operational endpoint; staleness here would mask outages. Origin already sets `force-dynamic`. |
| 5 | `/api/analytics` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS, POST | Telemetry POST. CloudFront does not cache POST regardless, but explicit behavior keeps the cache key from being computed against forwarded cookies. |
| 6 | `/api/export/*` | `CachingDisabled` | `AllViewer` | GET, HEAD, OPTIONS | On-demand CSV/Excel export. Origin sets `Cache-Control: no-store`. Behavior is belt-and-suspenders. |
| 7 | `*` (default) | `CachingOptimized` | **None** (do not forward cookies, headers, or query string beyond the cache-policy spec) | GET, HEAD, OPTIONS | All cacheable routes — pages, read-only API, sitemap, OG images. See §Cache key for the included query strings and headers. |

`AllViewer` is AWS-managed origin request policy `Managed-AllViewer` (`216adef6-5c7f-47e4-b989-5492eafa07d3`). `CachingDisabled` and `CachingOptimized` are `Managed-CachingDisabled` (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) and `Managed-CachingOptimized` (`658327ea-f89d-4fab-a63d-7e88639e58f6`) respectively. If a custom policy is needed for the cacheable default (see §Cache key), define it once and reuse.

## Cache key (default cacheable behavior)

- **Query strings:** include all. The read-only routes use query strings semantically (`/search?q=…`, pagination, filters) and the cache must split on them. The `Managed-CachingOptimized` policy already includes all query strings; verify before substituting a custom policy.
- **Headers:** include `Accept`, `Accept-Language`, `Accept-Encoding`. No others. Specifically not `User-Agent` (would fragment per device) and not `Cookie` (would defeat the entire point of this split).
- **Cookies:** **none.** Do not forward, do not include in cache key. This is the single most important knob in this document.

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

1. **Distribution has at least two behaviors** — the table above defines seven; minimum is satisfied as long as the default cacheable + at least one uncacheable behavior exist.
2. **Cache key inspector test** — same URL with two different `Cookie:` values produces the same cache key for any path covered by the default behavior. Run from the CloudFront console: Distribution → Behaviors → Default → Cache Policy → "Test cache policy."
3. **Writer route forwards cookies** — `curl -v https://<staging-domain>/api/edit/ping --cookie "session=test"` and confirm the origin access log records `session=test` in the request headers.
4. **End-to-end edit smoke test** — once B01 #100 (SSO) and B02 #101 (authz predicate) land, perform a full self-edit through CloudFront and confirm the write reaches Aurora and the audit log captures it. Blocked on those issues.

## Open routes (not addressed by the addendum)

The addendum names a subset of routes; the codebase has more. The following are placed by judgment in the table above and should be confirmed before the CDK lands:

- `/about`, `/about/methodology`, `/browse`, `/centers/*`, `/departments/*`, `/topics/*` — cacheable, same as `/scholars/*`. No session reads. **Recommended: leave in default cacheable.**
- `/api/scholars/*`, `/api/topics/*`, `/api/search`, `/api/search/suggest`, `/api/nih-portfolio`, `/api/nih-resolve` — read-only JSON consumed by client components. Session-agnostic by inspection. **Recommended: leave in default cacheable.** Note that several are declared `force-dynamic` at the route level; that disables Next.js's full-route cache but does not prevent CloudFront from caching the response, and the pages that consume them already cache for 24 h.
- `/og/*` — origin sets `Cache-Control` aggressively. **Recommended: leave in default cacheable** so origin TTL is honored.
- `/sitemap.xml`, `/robots.txt` — origin uses `revalidate = 86400`. **Recommended: leave in default cacheable.**

If any of these should not be edge-cached, surface the requirement before the CDK PR and add a dedicated behavior with `CachingDisabled`.

## Why no `User-Agent` in the cache key

Mobile / desktop split is handled by responsive CSS, not separate origin responses. Adding `User-Agent` to the cache key would explode the cache (effectively unique per browser version) without serving different content. If a future requirement introduces device-specific origin responses, use a CloudFront managed cache policy that includes the `CloudFront-Is-{Mobile,Tablet,Desktop}-Viewer` headers, not raw `User-Agent`.

## What this spec does not cover

- **WAF rules** — see B26 #125 (verified-bot allowlist).
- **Security headers (HSTS, CSP, X-Frame-Options)** — see B21 #120. Those attach to CloudFront response-headers policies, not cache or origin-request policies, and are orthogonal to the split documented here.
- **Origin shield** — referenced in `PRODUCTION.md`; an enable/disable knob on the origin, independent of the per-behavior cache policies above.
- **Sitemap-index split** — see B25 #124. Affects what `/sitemap.xml` returns, not how it is cached.
