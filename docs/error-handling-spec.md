# Error handling & not-found — SPEC

**Status:** Draft — P1–P3 implemented (this branch); P4–P6 pending.
**Date:** 2026-06-01
**Authors:** Scholars Profile System development team
**Implements:** [#668](https://github.com/wcmc-its/Scholars-Profile-System/issues/668) — error handling: 404 recovery UX + error boundaries + degraded-search + error-response edge caching
**Operationalizes:** [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) — the "what breaks when X is down" matrix. This SPEC defines what the *user sees* when those failures reach the request path.
**Extends:** [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) (§4 edge caching of error responses), [`logging-reference.md`](./logging-reference.md) (§6 error-event vocabulary).
**Related:** [#595](https://github.com/wcmc-its/Scholars-Profile-System/issues/595) (New Relic RUM + log ingestion), [#506](https://github.com/wcmc-its/Scholars-Profile-System/issues/506) Gate A (launch tech-readiness), [#576](https://github.com/wcmc-its/Scholars-Profile-System/issues/576) (launch data-QA gate), [#474](https://github.com/wcmc-its/Scholars-Profile-System/issues/474) (/edit 404 — a data-population issue, not in scope here).
**Reconciled with:** [#671/#672](https://github.com/wcmc-its/Scholars-Profile-System/issues/671) — people canonical URL migration, which moved the catch-all profile route into the `(public)` group (`app/(public)/[slug]/page.tsx`) and makes profiles canonical at root `/{slug}` when `PROFILE_CANONICAL === "root"` (else a 301 alias to `/scholars/{slug}`). Routing references below reflect the post-#671 layout.

---

## Purpose

Define a single, coherent error-handling contract for the public Scholars site so that **every** failure mode — a missing profile, a thrown render, a search-backend outage, a dead legacy URL — produces a branded, recoverable, correctly-statused response instead of leaking Next.js's unstyled defaults.

The work splits into six pieces (P1–P6 in §10) but is specified together because they share one contract: the same chrome, the same telemetry vocabulary, the same status-code and edge-caching rules. Specifying them separately would re-derive that contract three times and drift.

This SPEC **locks** the status-code matrix (§7), the edge-caching behavior (§4), and the error-event vocabulary (§6) — the three things that are expensive to change after launch (SEO signals settle, alarms get built on event names, the CDN behavior list is deploy-gated). It does **not** prescribe pixel-level design; it reuses the existing `SiteHeader`/`SiteFooter` chrome and the design tokens already in `globals.css`.

---

## Current state

What exists today, enumerated from `app/` + `lib/`:

| Concern | State | Gap |
|---|---|---|
| Global 404 page | `app/not-found.tsx` — branded-minimal; logs `vivo_404` telemetry for `/display/cwid-…` legacy URLs; offers Home + Search links. | Renders **without** `SiteHeader`/`SiteFooter` (the root `app/layout.tsx` doesn't include them — they live in `(public)/layout.tsx`), so it looks orphaned. No search box, no "did you mean" for the high-value VIVO-migrant case. |
| `notFound()` wiring | Correct across every dynamic route: profiles (missing / sparse-hidden / non-public identity class), topics, centers, departments, co-pubs, edit units. | None — this part is solid. |
| Slug redirects | `/[slug]` root-alias and `/scholars/[slug]` both resolve via `resolveBySlugOrHistory` → 301/308 for renamed slugs, `notFound()` otherwise. | None. |
| **Render-error boundary** | **None.** Zero `error.tsx` and zero `global-error.tsx` in the entire tree (verified). | A thrown Server Component → Next.js **unstyled default 500**. Public-facing. The biggest hole. |
| `/search` failure | `lib/api/search.ts` has no try/catch around the OpenSearch calls; no segment `error.tsx`. | An OpenSearch outage (a documented live-path dependency) throws → unstyled 500 instead of a degraded panel. |
| API error responses | `app/api/*` routes catch inconsistently; no shared envelope. | Inconsistent status codes and bodies; some routes leak stack traces in dev shape. |
| Edge caching of errors | Undefined. 404s on profile paths land on the query-keyed cacheable behavior; root-alias / VIVO 404s land on the `CachingOptimized` default; 5xx behavior unspecified. | No deliberate policy → risk of a transient 5xx getting pinned at the edge, and dead-URL crawler floods hitting the `force-dynamic` origin uncached. |
| Error telemetry | Only `vivo_404`. | No signal when an error boundary fires or when search degrades. |

---

## Design principles

1. **Branded, never bare.** No user-facing path may render Next.js's default error/404 markup. Every terminal state uses the WCM chrome and tokens.
2. **Degrade, don't crash.** A dependency that is *not* in a page's critical path must not take the page down. OpenSearch is only the search path; an OpenSearch outage degrades `/search` and leaves every Aurora-served page untouched (per `dependency-outage-matrix.md`). The boundary placement must reflect that.
3. **Correct status codes are a contract, not cosmetics.** 404 means 404 to a crawler; a soft-404 (200 body saying "not found") corrupts the index. 5xx must stay 5xx so monitoring sees it. §7 is the locked matrix.
4. **Errors are observable.** Every boundary that fires emits one structured log event (§6). Silent failure is a defect.
5. **The edge is part of the contract.** Caching of 4xx/5xx is specified here and lands in `EdgeStack`, not left to CloudFront defaults (§4).
6. **Reuse, don't fork.** Chrome = existing `components/site/header.tsx` + `footer.tsx`. `SiteHeader` already does **not** read cookies server-side (it's CDN-safe), so it is safe to render on dynamic error/404 responses.

---

## §1 — Render-error boundaries (`error.tsx` / `global-error.tsx`)

### Two levels, two different constraints

| Boundary | Catches | Renders within | Constraint |
|---|---|---|---|
| **Segment `error.tsx`** | Errors thrown by Server/Client Components *below* it in the tree. | The nearest layout **above** it — so an `error.tsx` inside `(public)/` renders inside `(public)/layout.tsx` and **gets the `SiteHeader`/`SiteFooter` chrome for free**. | Must be a Client Component (`"use client"`). Receives `{ error, reset }`. |
| **Root `global-error.tsx`** | Errors thrown in the **root layout** itself, or anything that escapes a segment boundary. | Nothing — it **replaces `app/layout.tsx` entirely**, including `<html>`/`<body>`. | Cannot use any app provider (`FeedbackBadgeProvider`, `ImpersonationBanner`) or the `(public)` chrome. Must be **fully self-contained**: render its own `<html><body>`, inline-styled (no dependency on the cascade), minimal. |

### Behavior

- **Segment `error.tsx`** (P1 placement: `app/(public)/error.tsx`, plus `app/(public)/search/error.tsx` for the search-specific copy — see §3). Renders a branded "Something went wrong" panel inside the normal page chrome, with:
  - A **"Try again"** button wired to the `reset()` prop (re-renders the segment — recovers from transient Aurora blips without a full reload).
  - A link to Home and to Search.
  - **No raw error text** in the rendered output (the message goes to the log, not the page). A short, stable `digest`-based reference may be shown for support ("Reference: `<digest>`").
- **`global-error.tsx`** (root): a minimal self-contained page (own `<html lang="en"><body>`), WCM wordmark as **inline-styled text** (settled: text, not SVG — no asset dependency), the same "Try again" + Home links, no external CSS / font / image dependency. This is the true last resort; it should be rare.

### Logging

Each boundary fires exactly one event (§6): segment `error.tsx` → `error_boundary`; `global-error.tsx` → `global_error`. Both include `error.digest` (Next's stable hash), the matched route if available, and a coarse `kind` (`db` / `search` / `unknown`) derived from the error — never the raw message or stack in the structured field used for alarming (the stack may go to a separate `detail` field that is not alarmed on).

---

## §2 — Not-found (404) recovery UX

### Two catch sites, one shared UI

`notFound()` resolves to the nearest `not-found` boundary up the tree. Two sites matter:

1. **`app/(public)/not-found.tsx`** (NEW) — catches `notFound()` thrown from inside the `(public)` group: profiles, topics, centers, departments, co-pubs, **and (post-#671) the root catch-all profile route `app/(public)/[slug]/page.tsx`** — so an unknown root slug `/{slug}` now lands here with chrome + the recovery search box. Renders inside `(public)/layout.tsx` → **chrome for free**.
2. **`app/not-found.tsx`** (existing, upgraded) — the root catch site for everything *outside* the `(public)` group: dead legacy **VIVO** URLs (`/display/cwid-…` — two segments, never match the single-segment `(public)/[slug]` catch-all, so they land here), random unmatched multi-segment paths, and non-`(public)` top-level paths. The root layout does not include the public chrome, so this file renders `SiteHeader`/`SiteFooter` **directly** (both are standalone and cookie-safe).

Factor the 404 body into one shared component (`components/site/not-found-content.tsx`) so both sites are visually identical and branded.

### Content (the "helpful recovery" decision)

- A clear "Page not found" headline.
- A **search box** (posts to `/search?q=…`) — the primary recovery affordance.
- Browse links: Scholars (A–Z) / Departments / Centers / Topics.
- **VIVO-tailored copy.** When the failing path matches `VIVO_PATTERN` (`/^\/display\/cwid-\w+$/`, already defined in `lib/analytics/vivo-pattern.ts`), swap the generic message for: *"This profile may have moved. Search for the person by name —"* with the search box directly beneath. This is the cutover-traffic recovery path and the SEO-sensitive case.
- Preserve the existing **`vivo_404`** telemetry call exactly (the redirect-map-pruning signal must not regress).

### Status code

`notFound()` already returns **HTTP 404** — do not override it to 200 (§7). The recovery UI is the *body* of a 404, not a 200 "soft" page.

---

## §3 — `/search` degraded state

OpenSearch is a **live-path** dependency but scoped to `/search` and `/api/search/*` only (`dependency-outage-matrix.md`). An outage must produce a branded, observable failure and leave the Aurora-served site fully functional.

**As-built (decided — see Resolved decisions #4):** the `/search` outage renders a **branded HTTP 500**, not an in-page 200 degrade. A 500 is the *correct* status for a real backend outage (it stays visible to monitoring), and `/search` is `noindex` so the status carries no SEO cost. The work is therefore two pieces, both additive and low-risk:

- **`app/(public)/search/error.tsx`** — the segment error boundary. An OpenSearch failure thrown from the page's search calls (the shell badge-counts and/or the streamed `<Suspense>` results) is caught here and rendered as a branded **"Search is temporarily unavailable"** panel inside the `(public)` chrome, with a retry and browse links. This is what prevents the unstyled Next.js 500.
- **Server-side `search_degraded` log (§6)** — a `.catch` on the page's badge-count `Promise.all` logs the structured event (query length only) then rethrows to the boundary. This makes the outage visible in logs/alarms independent of the AWS-side `ClusterStatus.red` alarm. (Emitting from the boundary alone is insufficient — it is a Client Component and would only reach the browser console / RUM.)

> Search responses are already `noindex, follow` (`robots: { index: false, follow: true }`), so a 500 here carries no SEO risk.
>
> **Deferred refinement (optional):** the original "HTTP 200, query box still present, only the results area degrades" experience requires a contained refactor of the search shell's data fetch (the badge-count `Promise.all` plus the streamed results). It was deferred to avoid restructuring the app's most complex page; the branded 500 is the shipped behavior. Revisit as a separate follow-up if the 200 UX is wanted.

---

## §4 — Edge caching of error responses (CloudFront / EdgeStack)

**Decision: cache 404 with a short TTL; never cache 5xx.** Rationale: dead legacy-URL crawler floods (VIVO cutover) should be absorbed cheaply at the edge rather than hammering the `force-dynamic` origin; but a transient Aurora/OpenSearch 5xx must **not** get pinned at the edge, or a 10-second blip becomes a multi-minute outage for cached paths.

Implemented in `EdgeStack` (CDK), consistent with `cloudfront-cache-spec.md`:

| Status | Edge behavior | Mechanism |
|---|---|---|
| **404** | Cache for **60 s** (settled — see Resolved decisions). Body + status pass through unchanged (Next renders the branded 404). | CloudFront `CustomErrorResponse { errorCode: 404, errorCachingMinTtl: 60 }` with **no** `responsePagePath` and **no** `responseCode` override — so the origin's 404 body and 404 status are preserved (no soft-404; see §7). |
| **500 / 502 / 503 / 504** | **Never cache.** | `CustomErrorResponse { errorCode: <5xx>, errorCachingMinTtl: 0 }`, plus origin `Cache-Control: no-store` on error responses (belt-and-suspenders). |
| **403** (WAF / edge filter) | Leave to existing WAF/edge behavior; out of scope here. | — |

Constraints:

- The 404 TTL applies across behaviors; verify it does not conflict with the query-keyed (`sps-query-keyed-${env}`) and `CachingOptimized` default behaviors (a `CustomErrorResponse` is distribution-level, not per-behavior — confirm interaction at synth time).
- A cached 404 **must still return HTTP 404** to the next viewer (do not let CloudFront rewrite it to 200). The configuration above preserves status because `responseCode` is unset.
- Add a synth-time guard in `cdk/lib/edge-stack.test.ts` asserting the distribution declares `errorCachingMinTtl: 0` for each 5xx code (mirrors the existing ratchet pattern for mutating-method behaviors).
- This is a **deploy-gated** change (EdgeStack is manual-deploy and context-flag-sensitive — see the EdgeStack deploy memo); ship the app-side P1–P3 first, P4 as its own EdgeStack deploy.

---

## §5 — API error envelope

A single JSON error shape for `app/api/*`:

```jsonc
{ "error": { "code": "not_found" | "bad_request" | "unauthorized" | "rate_limited" | "internal" | "upstream_unavailable",
             "message": "<safe, user-facing>", "requestId": "<optional>" } }
```

- A small helper (`lib/api/error-response.ts`) returns `NextResponse.json(envelope, { status, headers: { "Cache-Control": "no-store" } })` so status code, body shape, and no-store are consistent.
- Never leak stack traces or driver errors in `message`; log the detail server-side (§6) and return a generic safe message for `internal` / `upstream_unavailable`.
- Status codes follow §7. Auth routes keep their existing redirect behavior (not JSON).

---

## §6 — Telemetry (structured-log vocabulary)

New single-line JSON events, added to the app's vocabulary in [`logging-reference.md`](./logging-reference.md). **No new log group** — they land in the existing `/aws/ecs/sps-app-${env}` (3-month prod / 1-month staging retention) and feed New Relic ingestion (#595).

| Event | Emitted when | Key fields |
|---|---|---|
| `error_boundary` | A segment `error.tsx` renders. | `digest`, `route?`, `kind` (`db`/`search`/`unknown`) |
| `global_error` | `global-error.tsx` renders (root-layout failure). | `digest`, `kind` |
| `not_found` | A 404 is served (generalizes `vivo_404`). | `path`, `pattern` (`vivo`/`profile`/`other`) |
| `search_degraded` | The `/search` degraded path is taken. | `q_len` (length only, never the query text), `reason` |
| `vivo_404` | **Unchanged** — kept for continuity of the redirect-map-pruning signal. Settled: **not** folded into `not_found` in this work (see Resolved decisions); fold later when the pruning query is next touched. | `url` |

Privacy: log **path only**, never query strings (matches the existing `vivo_404` threat model); for search, log `q_len` not `q`.

Candidate alarms (defer to #595 / `SLOs.md`): `global_error` rate > 0 (any root failure is notable); `search_degraded` sustained > N/min (corroborates the OpenSearch `ClusterStatus.red` alarm from the request side).

---

## §7 — Status-code & SEO contract (locked)

| Situation | HTTP status | Indexable? | Notes |
|---|---|---|---|
| Missing / non-public / sparse-hidden profile, missing topic/center/dept | **404** | No | `notFound()`. Body is the recovery UI (§2) — still a 404, never a soft-404. |
| Renamed slug (slug_history hit) | **301 / 308** | Follows target | `redirect()` / `permanentRedirect()`, unchanged. |
| Render throw (DB cold-cache, resolver, etc.) | **500** | No | `error.tsx` / `global-error.tsx`. Never cached (§4). |
| OpenSearch outage on `/search` | **500** (branded boundary) | No (`noindex`) | As-built (Resolved decisions #4): `search/error.tsx` renders a branded "temporarily unavailable" page; a 500 stays visible to monitoring and `/search` is `noindex`. Never cached (§4). |
| Dead legacy VIVO URL | **404** | No | Recovery UI + VIVO copy (§2). Cacheable short-TTL (§4). |
| API error | per §5 | n/a | `no-store`. |

The **never-soft-404** and **never-cache-5xx** rules are the two locked invariants reviewers should check.

---

## §8 — File layout

```
app/
  global-error.tsx                      NEW — self-contained root error boundary (own <html>/<body>)
  not-found.tsx                         UPGRADE — render SiteHeader/SiteFooter + shared recovery body; keep vivo_404
  (public)/
    error.tsx                           NEW — segment boundary, branded, reset() retry
    not-found.tsx                       NEW — in-group 404 (gets (public) chrome); shared recovery body
    search/
      error.tsx                         NEW — search-specific boundary copy
components/site/
  not-found-content.tsx                 NEW — shared 404 body (search box + browse links + VIVO branch)
  error-content.tsx                     NEW — shared error body (reset retry + links)
lib/api/
  search.ts                             EDIT — catch OpenSearch failures → typed degraded result
  error-response.ts                     NEW — JSON error envelope helper (§5)
lib/analytics/
  errors.ts                             NEW — error_boundary / global_error / not_found / search_degraded emitters
  vivo-pattern.ts                       KEEP — vivo_404 + VIVO_PATTERN reused by the 404 UI
cdk/lib/
  edge-stack.ts                         EDIT (P4) — CustomErrorResponse rules (§4)
  edge-stack.test.ts                    EDIT (P4) — synth guard: 5xx errorCachingMinTtl=0
docs/
  logging-reference.md                  EDIT (P6) — add the four new events
  cloudfront-cache-spec.md              EDIT (P4) — document the error-response caching rows
```

---

## §9 — Acceptance / verification

- [ ] A forced Server Component throw renders the branded segment `error.tsx` (chrome intact, "Try again" works), and a forced root-layout throw renders the self-contained `global-error.tsx`. Neither shows raw stack text.
- [ ] `/search` with OpenSearch unreachable renders the **branded** `search/error.tsx` panel (chrome intact, "Try again" works) — i.e. not the unstyled Next default — and logs a server-side `search_degraded` event. Every Aurora-served page still renders normally. (Status is 500 by design — Resolved decisions #4.)
- [ ] A dead profile URL and a `/display/cwid-x` VIVO URL both return **HTTP 404** with full chrome + a working search box; `vivo_404` (and `not_found`) appear in the log.
- [ ] CloudFront caches a 404 for the configured short TTL **and** returns it as a 404 (not 200); a simulated origin 5xx is **not** cached at the edge. Verified from `curl -I` against the distribution (status + `x-cache` + age).
- [ ] `edge-stack.test.ts` fails if any 5xx `errorCachingMinTtl` is non-zero.
- [ ] The four new events are present in `/aws/ecs/sps-app-${env}` and documented in `logging-reference.md`.
- [ ] `npm run typecheck`, lint, and the vitest suite pass (run vitest before push per house rule).

---

## §10 — Phasing & rollout

| Phase | Deliverable | Deploy path |
|---|---|---|
| **P1** | `global-error.tsx` + `(public)/error.tsx` + shared `error-content.tsx` + `errors.ts` emitters | App deploy (push → staging; prod via reviewer gate) |
| **P2** | 404 recovery UX: upgrade `app/not-found.tsx`, add `(public)/not-found.tsx`, `not-found-content.tsx` | App deploy |
| **P3** | `/search` degraded state: `lib/api/search.ts` catch + `search/error.tsx` | App deploy |
| **P4** | Edge caching of errors: `EdgeStack` `CustomErrorResponse` + synth guard | **Manual EdgeStack deploy** (3 context flags — see EdgeStack memo); `--strict` diff first |
| **P5** | API error envelope: `lib/api/error-response.ts` + route adoption | App deploy |
| **P6** | Telemetry doc + alarm candidates | Docs + `SLOs.md`/#595 follow-on |

P1–P3 are the launch-quality core (Gate A candidate). P4 is deploy-gated and independent. P5–P6 are iterate-after.

No feature flag is required for P1–P3 (they only improve failure paths that today render the unstyled default — there is no worse-than-current state to guard against). P4 is gated naturally by being a separate EdgeStack deploy.

---

## §11 — Out of scope / non-goals

- **#474** (/edit 404 for users with a profile) — a prod data-population issue, not an error-page-design issue. Unaffected by this work.
- WAF/403 edge behavior — owned by the WAF track (`network-security-topology.md`).
- The `/edit/*` writer surfaces' error states beyond what segment `error.tsx` already gives them — the edit flow has its own SSO-redirect and fail-closed-LDAP semantics (`access-control-rbac.md`).
- Client-side React render errors in deeply-nested islands beyond what the nearest `error.tsx` catches — acceptable; the boundary catches the segment.
- Any change to the existing `redirect()` / slug-history behavior — unchanged.

## Resolved decisions

These were the open forks; all are settled (2026-06-01) with the defaults below and reflected inline in §1, §3, §4, and §6.

1. **404 cache TTL — fixed at 60 s.** Profiles are already 24 h-cached, so the edge is never the freshness bottleneck for a valid page; 60 s absorbs the VIVO-cutover crawler floods while keeping a newly-valid URL's stale-404 window negligible. Revisit only if cutover crawler volume proves materially higher than expected.
2. **`vivo_404` stays; `not_found` is added alongside it — not folded in this work.** Folding would couple the redirect-map-pruning query migration into the error-handling PRs for no functional gain. `vivo_404` keeps emitting unchanged (continuity of the pruning signal); `not_found{pattern}` is the new general event. Fold them later, in the PR that next touches the pruning query.
3. **`global-error.tsx` branding — inline text wordmark, no assets.** "Scholars @ Weill Cornell Medicine" as inline-styled text plus the recovery links; no inline SVG, no external CSS / font / image. The root boundary must survive the failure of the cascade and the root layout themselves, so it depends on nothing but the HTML it ships.
4. **`/search` outage degrades to a branded HTTP 500, not an in-page 200.** A 500 is the correct status for a real OpenSearch outage (it stays visible to monitoring) and `/search` is `noindex`, so there is no SEO cost; the boundary (`search/error.tsx`) provides the branded UX and a retry, and a server-side `search_degraded` log provides observability. The in-page 200 degrade (keep the form/tabs, degrade only the results area) would require a contained refactor of the app's most complex page and was deferred as an optional follow-up. This supersedes the earlier §7 "200 (degraded panel)" entry.
