# docs/ADR-007 — CSP script-src strategy: unsafe-inline + script-src-attr 'none', not a nonce

**Status:** Accepted
**Date:** 2026-05-18
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

`B21` (#120) shipped the security-header set with the Content-Security-Policy in **report-only** mode (`Content-Security-Policy-Report-Only`). #374 tracks promoting it to the enforcing `Content-Security-Policy` header, and its **part 2** raises an open question that must be settled *before* enforcement: should `script-src` adopt a nonce-based strict policy, or keep `'unsafe-inline'`?

The policy is built by `buildContentSecurityPolicy()` in `lib/security-headers.ts` and applied to every response through `next.config.ts` `headers()`. Before this ADR it shipped `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'`.

`'unsafe-inline'` is present for a concrete reason, recorded in that file: the Next.js App Router emits inline bootstrap and hydration `<script>` blocks — and inline `<style>` — on every page. Without `'unsafe-inline'`, a nonce, or a hash, an enforcing policy would block Next's own scripts and white-screen every route.

### Threat model

This decision is bounded by an explicit threat model. The attacker it defends against can **inject HTML into a server-rendered response** through one of the app's HTML-injection surfaces (below) — a stored or reflected payload that reaches a page's markup. The CSP is the second line of defense, behind input sanitization.

Explicitly **out of scope**, and not defended by any `script-src` choice: compromise of the origin itself, and supply-chain compromise of a first-party (`'self'`) script. A nonce, a hash, and `'unsafe-inline'` are all equally powerless against an attacker who can change what `'self'` serves — that is a different control surface (dependency review, build integrity, SRI on third-party scripts). The `script-src` question is therefore narrow: *given* an HTML-injection foothold, does the policy stop the injected markup from executing script?

The app has exactly two HTML-injection surfaces, both rendered through `dangerouslySetInnerHTML`:

- **Third-party content** — PubMed abstracts, titles, and journal names, and legacy VIVO bios — sanitized by `sanitizePubmedHtml` / `sanitizeVIVOHtml` (`lib/utils.ts`) at every call site (e.g. `components/publication/publication-meta.tsx`, `components/profile/publication-row.tsx`).
- **User content (future)** — the self-edit `overview` / bio field (#356; `docs/ADR-005`, `docs/self-edit-spec.md`). Not built yet; its SPEC mandates server-side sanitization to a strict tag allowlist (`p br ul ol li strong em a`) with `href` scheme-checking.

### A nonce is not a free upgrade on this app

The standard Next.js App Router nonce recipe generates a fresh, random nonce per request in middleware, threads it into the CSP header, and lets Next inject it into its own script tags during the server render. The Next.js CSP guide (`docs/01-app/02-guides/content-security-policy.mdx`) is explicit about the cost:

> "When you use nonces in your CSP, all pages must be dynamically rendered because each request requires a fresh page with a unique nonce. This requirement means that static optimization and Incremental Static Regeneration (ISR) are disabled, and pages cannot be cached by CDNs without additional configuration. Additionally, Partial Prerendering (PPR) is incompatible with nonce-based CSP …"

> "To use a nonce, your page must be dynamically rendered … Static pages are generated at build time, when no request or response headers exist — so no nonce can be injected."

A nonce is therefore mutually exclusive with static rendering. That matters here because **this application is static-first by deliberate design.** An audit of the `app/` rendering directives:

| Route | Rendering |
|---|---|
| `/` (home) | ISR — `revalidate = 21600` |
| `/scholars/[slug]` | **statically pre-rendered** — `generateStaticParams` + ISR `revalidate = 86400` |
| `/scholars/[slug]/co-pubs[/…]` | ISR — `revalidate = 86400` |
| `/topics/[slug]`, `/topics/[slug]/scholars` | ISR — `revalidate = 21600` |
| `/departments/[slug][/divisions/…]` | ISR — `revalidate = 21600` |
| `/centers/[slug]` | ISR — `revalidate = 21600` |
| `/browse` | ISR — `revalidate = 3600` |
| `/about`, `/about/methodology` | fully static — `force-static`, `revalidate = false` |
| `/search` | dynamic — `force-dynamic` |

Every public page is statically generated or ISR-cached. `/search` is the **only** route that is `force-dynamic`, and necessarily so — it reads query parameters. On top of route caching sits a CloudFront edge cache (`docs/cloudfront-cache-spec.md`), and the whole `/api/revalidate` machinery (#103, #104) exists to bust those caches on ETL writes. The deploy model (`ADR-004`) and the production posture (`PRODUCTION.md`) are built on the origin doing as little per-request work as possible.

Adopting a per-request nonce would force **every** route into dynamic rendering — disabling `generateStaticParams`, every `revalidate` window, and CDN cacheability. For an unauthenticated, high-traffic, ~8,900-scholar public directory, that is not a security hardening; it is a wholesale teardown of the performance and cost architecture.

## Decision

**The enforced CSP keeps `'unsafe-inline'` in `script-src` and does not adopt a per-request nonce. It additionally sets `script-src-attr 'none'`, which closes the inline event-handler vector that `'unsafe-inline'` would otherwise leave open.**

**1. No nonce.** A per-request nonce is mutually exclusive with static generation, ISR, and CDN caching (per the Next.js guide quoted above), and this app's entire public surface is static/ISR behind CloudFront. The nonce is rejected because the app cannot adopt it without abandoning that architecture — not because `'unsafe-inline'` is preferred on its merits. `script-src` keeps `'self' 'unsafe-inline'` so Next's inline bootstrap and hydration `<script>` blocks run.

**2. `script-src-attr 'none'`.** `'unsafe-inline'` in `script-src` permits two distinct things: inline `<script>` elements (which Next requires) **and** inline event-handler attributes — `<img onerror=…>`, `onclick=`, and the like. React binds event handlers in JavaScript through its synthetic event system; it never serializes them as HTML attributes, and Next's inline scripts are `<script>` elements, not attributes. So `script-src-attr 'none'` — which governs event-handler attributes specifically, with `script-src` as its fallback — blocks the event-handler vector **with no regression to first-party code**. A browser that does not recognize `script-src-attr` falls back to `script-src` and behaves exactly as today, so there is no downside. It ships now, in the report-only policy, so the observation window catches any third-party widget that emits inline handlers before enforcement.

This is a **documented, deliberate deviation from OWASP's strict-CSP guidance**, which recommends a nonce- or hash-based `script-src` with `'strict-dynamic'`. The deviation is forced by the static-rendering architecture; the compensating controls are `script-src-attr 'none'` (closes the event-handler sub-vector), the unweakened non-script directives (below), the HTML sanitizers on both injection surfaces, and Trusted Types as the planned next hardening step (see *Alternatives* and *Forward compatibility*).

After `script-src-attr 'none'`, what `'unsafe-inline'` still leaves open is narrower: an injected inline `<script>` element and a `javascript:` URI. Both require an HTML-injection foothold, and both are the sanitizers' responsibility on the two surfaces that have one.

The resulting report-only policy (which #374 part 1 later promotes verbatim to the enforcing header name) is:

```
default-src 'self'; base-uri 'self'; object-src 'none';
frame-ancestors 'none'; frame-src 'none'; form-action 'self';
font-src 'self'; img-src 'self' data: blob: https://directory.weill.cornell.edu;
script-src 'self' 'unsafe-inline'; script-src-attr 'none';
style-src 'self' 'unsafe-inline'; connect-src 'self';
report-uri /api/csp-report; report-to csp-endpoint
```

(The dev-only `'unsafe-eval'` / `ws:` relaxations remain gated to development and never reach the enforced production policy.)

## Consequences

**Positive outcomes:**

The static-first architecture is preserved intact. `generateStaticParams` on `/scholars/[slug]`, every `revalidate` window, CloudFront edge caching, and the `/api/revalidate` invalidation path keep working exactly as they do today. CSP enforcement adds no per-request CPU and no rendering change.

`script-src-attr 'none'` closes the highest-likelihood injected-script vector — an event-handler attribute (`onerror`, `onclick`) smuggled through a sanitizer gap — at zero architectural cost. This is the concrete hardening that #374 part 2 set out to evaluate, and it lands without a nonce.

The enforcing CSP still delivers real protection. Every directive other than `script-src` / `style-src` is unweakened by `'unsafe-inline'` and becomes a hard block under enforcement: `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `default-src 'self'`, `connect-src 'self'`. And `script-src 'self'` — even with `'unsafe-inline'` — still blocks loading an **external** script.

Promotion stays cheap and low-risk: a header rename, reversible by another rename.

**Negative outcomes and mitigations:**

After `script-src-attr 'none'`, the residual gap is narrow but real: the enforced policy does **not** stop an injected inline `<script>` element or a `javascript:` URI. Reaching that gap requires an HTML-injection foothold on one of the two surfaces named in the threat model, and on both the **sanitizer** is the control that must hold — CSP, on this architecture, cannot be the inline-`<script>` backstop that it is for an event handler.

This makes the HTML sanitizers security-critical, with a concrete consequence:

- Third-party HTML (`sanitizePubmedHtml` / `sanitizeVIVOHtml`, `lib/utils.ts`) is unit-tested in `tests/unit/sanitize-pubmed-html.test.ts`. With `script-src-attr 'none'` now blocking the event-handler vector, the remaining requirement on these is that they strip `<script>` and `javascript:` URLs.
- **The self-edit `overview` field (#356) is the load-bearing case.** It is the only *user-controlled* HTML surface, and this ADR removes CSP as its inline-`<script>` backstop. #356 must therefore (a) sanitize with a **vetted, actively-maintained library** (e.g. DOMPurify) rather than a hand-rolled allowlist; (b) ship **server-side adversarial tests** that run a known XSS payload corpus through the sanitizer; and (c) obtain explicit **security sign-off** before merge. These are requirements on #356, not suggestions.

**Operational implications:**

This ADR settles #374 part 2, and ships its concrete output — `script-src-attr 'none'`, plus the `report-to` / `Reporting-Endpoints` reporting pair — into the **report-only** policy now, so the observation window exercises the final directive set.

Part 1 — promoting report-only → enforcing — is execution-gated on the staging environment landing (`B13`, #112): an observation window must run there and come back clean first. The decision in this ADR is not gated; only its part-1 rollout is.

The promotion mechanism is in the code as a single env-gated header swap: `SECURITY_CSP_MODE=enforce` flips `buildSecurityHeaders` to emit `Content-Security-Policy` instead of `Content-Security-Policy-Report-Only`; any other value (including unset) keeps the default report-only. The policy *value* is identical in both modes, so flipping the flag is reversible by flipping it back — no rebuild, only a deploy of the env change. The default fails safe: a typo in `SECURITY_CSP_MODE` resolves to `report-only`, never to `enforce`. The launch-time observation window therefore consists of running with `SECURITY_CSP_MODE` unset, watching the `/api/csp-report` collector for violations, and only setting `=enforce` once it is clean.

Part 3 — the `/api/csp-report` collector — shipped in #378. It accepts both reporting payloads: `report-uri`'s `application/csp-report` and the Reporting-API's `application/reports+json`. `report-uri` is deprecated but honored by every current browser; `report-to` is the standard successor. Both directives are emitted; the collector parses whichever payload arrives.

**Forward compatibility:**

Revisit this ADR if the premise changes:

- **If the app stops being static-first** — e.g. most routes become `force-dynamic` for personalization or auth — a per-request nonce stops costing anything and `'strict-dynamic'` becomes the right call. The decision is contingent on the rendering model audited above, not permanent.
- **Trusted Types is the intended next hardening step** (see *Alternatives*), and is the natural companion to land with or just after #356, since #356 adds the user-controlled `dangerouslySetInnerHTML` surface that Trusted Types most directly protects.
- **If a static-compatible nonce mechanism appears** — e.g. an edge layer (CloudFront Functions / Lambda@Edge) injecting a fresh nonce into cached HTML — the "nonce ⇒ dynamic render" blocker is routed around.
- **A `/search`-scoped nonce** is a smaller possible refinement: `/search` is already `force-dynamic`, so it could carry a nonce at no caching cost. Deferred — a per-route CSP split is complexity for a hardening that covers one route, and `/search` renders no user-authored HTML.

## Alternatives Considered

**Per-request nonce + `'strict-dynamic'`** (the #374 part-2 "nonce" option, and OWASP's recommended strict CSP). Rejected. It is the strongest `script-src` policy — but, per the Next.js CSP guide, it disables static optimization, ISR, CDN caching, and PPR, because a fresh nonce requires a fresh render per request. This application is static/ISR on every public route except `/search`, behind a CloudFront cache whose invalidation path (`/api/revalidate`, #103 / #104) and deploy model (`ADR-004`) are core architecture. Adopting a nonce would convert the whole site to dynamic rendering — a cost out of all proportion to hardening one already-sanitized surface.

**Trusted Types (`require-trusted-types-for 'script'` + a `trusted-types` policy).** Not adopted for this decision; **recommended as the next hardening step.** Trusted Types attacks the same DOM-XSS surface from a different angle than a nonce: it makes dangerous DOM sinks (`innerHTML`, and so React's `dangerouslySetInnerHTML`) refuse a plain string and require a `TrustedHTML` value minted by a registered policy. Crucially, it is a CSP directive with **no per-request component, so it is fully compatible with static rendering and CDN caching** — the constraint that rules out a nonce does not apply. It is also the most *direct* defense for this app's two HTML-injection surfaces, both of which are `dangerouslySetInnerHTML` call sites. It is not adopted here because it is a genuine refactor, not a header flip: every `dangerouslySetInnerHTML` call site must be routed through a Trusted Types policy that runs the sanitizer, and browser support is uneven across engines (strongest in Chromium), so it is defense-in-depth rather than a universal guarantee. The right time to adopt it is with or just after #356 — when the user-controlled HTML surface is built — so the Trusted Types policy and the #356 sanitizer are designed together. Recorded here so the decision to *sequence* it after #356, rather than skip it, is explicit.

**Build-time hashes (`script-src 'self' 'sha256-…'`).** Rejected. A hash allowlist works only when the set of inline scripts is fixed and known at build time. The Next.js App Router's inline bootstrap and hydration scripts embed per-page and per-build data, so their hashes are neither stable nor enumerable across routes; a hash list would be unmaintainable and would break on most deploys.

**A per-deploy / static nonce.** Rejected, and explicitly warned against. A "nonce" baked at build time — constant for an entire deployment — *is* compatible with static rendering, which makes it a tempting way to dodge the dynamic-render requirement. It is not security: the value is identical in every statically-served page, and every page on this site is public, so any visitor can read the nonce from page source and reuse it in injected markup. A predictable, non-per-request nonce provides no XSS protection. It is named here so it is not mistaken for a solution to the static-rendering conflict.

## References

- #374 — "Enforce Content-Security-Policy"; this ADR settles its **part 2**. Part 1 (promotion) and part 3 (the `/api/csp-report` collector) are tracked there.
- #120 (`B21`) — shipped the report-only CSP and the security-header set.
- `lib/security-headers.ts` — `buildContentSecurityPolicy()` / `buildSecurityHeaders()`; carries `script-src-attr 'none'`, the `report-to` directive, and the `Reporting-Endpoints` header.
- `app/api/csp-report/route.ts` — the #374 collector; accepts both the `report-uri` (`application/csp-report`) and Reporting-API (`application/reports+json`) payloads.
- Next.js CSP guide (`docs/01-app/02-guides/content-security-policy.mdx`) — the nonce ⇒ dynamic-rendering / no-ISR / no-CDN-cache constraint.
- `docs/cloudfront-cache-spec.md` — the edge cache a nonce would disable.
- `ADR-004` — deploy strategy; the static/ISR-on-Fargate model this decision protects.
- `ADR-005`, `docs/self-edit-spec.md` — the self-edit `overview` field (#356), the user-controlled HTML surface whose sanitizer this decision makes security-critical.
- `lib/utils.ts` — `sanitizePubmedHtml` / `sanitizeVIVOHtml`, the third-party-HTML sanitizers.
- OWASP — strict-CSP guidance (nonce/hash + `'strict-dynamic'`); this ADR is a documented deviation from it, with compensating controls.
- #112 (`B13`) — staging environment; #374 part 1 (promotion) is execution-gated on it.
- #99 — production-readiness epic.
