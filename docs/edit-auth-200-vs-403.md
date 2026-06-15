# `/edit/*` unauthorized access returns HTTP 200, by design (#955 item 6)

## What happens today

When an **authenticated** user requests an `/edit/*` URL they lack permission
for — e.g. a non-superuser hitting `/edit/scholar/[other-cwid]`,
`/edit/scholars`, `/edit/publication/[pmid]`, `/edit/{department,division,center}/[code]`,
`/edit/administrators`, or `/edit/slug-requests` — the route handler:

1. Runs the GET-time authorization re-check (`requireSuperuserGet` /
   `getEffectiveUnitRole` in `lib/edit/authz.ts`), which emits **one structured
   `edit_authz_denied` log line** (`lib/auth/authz-events.ts` →
   `console.warn(JSON.stringify({ event: "edit_authz_denied", … }))`).
2. Returns the visible "not authorized" page component
   `<ForbiddenEditPage />` (`components/edit/forbidden-edit-page.tsx`).

Because `ForbiddenEditPage` is an ordinary Server Component returned from the
page — not a thrown `notFound()`/`forbidden()` or a `NextResponse` with an
overridden status — the HTTP response status is **200**, with the branded
"You don't have permission to edit this profile." (or unit) body. The visible
UX matches the SPEC's denial copy; only the wire status is 200 rather than 403.

The **unauthenticated** case is different and unaffected: no session →
`redirect("/api/auth/saml/login?return=…")` (302), reinforced by `middleware.ts`
matching `/edit*`. This doc is only about the *authenticated-but-not-permitted*
case.

This is the long-standing v1 behavior. It is noted inline in
`components/edit/forbidden-edit-page.tsx` ("App Router has no `forbidden()`
primitive in Next 15.5 — the page response remains HTTP 200 in v1") and is the
shape every `/edit/*` denial uses today (see the `ForbiddenEditPage` call sites).

## Why this is intentional for launch monitoring

- **The denial signal already exists and is alarmed.** Every authorization
  denial emits the `edit_authz_denied` event, and a CloudWatch metric filter
  (`EditAuthzDeniedMetricFilter` in `cdk/lib/observability-stack.ts`, pattern
  `{ $.event = "edit_authz_denied" }`) keys an alarm off it. A sustained denial
  rate (predicate bug or active probing) is detected from this structured event,
  **not** from counting HTTP 4xx responses. So the observability for "someone is
  being denied" does not depend on the wire status being 403.
- **A 403 on these routes would be noise, not signal.** A denied `/edit/*` GET
  is an expected, benign outcome (a curious or stale-permission user clicking an
  admin URL), and the user gets a clean recoverable page. Surfacing it as a 4xx
  would inflate the site's 4xx error rate and risk masking the 4xx/5xx signals
  that *do* matter (genuine 404s, render 500s — see `docs/error-handling-spec.md`
  §7, which deliberately does not list this denial in its status-code matrix).
- **No SEO cost.** `/edit/*` is `noindex` (`robots: { index: false }`) and
  SSO-gated, so the 200 status carries none of the soft-404 SEO concern that the
  error-handling SPEC's "never-soft-404" invariant guards against for public
  pages.

## What an operator should NOT alert on

- **Do not** build a launch alarm on 4xx responses from `/edit/*` and treat them
  as errors. Authorized-but-denied access is *expected* to return 200, and a
  genuine denial does **not** appear as a 4xx.
- **Do** alert on the `edit_authz_denied` structured event (the existing
  `EditAuthzDeniedMetricFilter` alarm) for an unusual *rate* of denials — that is
  the real "probing or predicate-regression" signal.
- Treat a 200 from `/edit/scholar/[cwid]` etc. for a non-superuser as normal; the
  body is the "not authorized" page, and the denial was already logged.

## Future option (deferred follow-up)

Next.js App Router added a `forbidden()` navigation primitive plus a
`forbidden.tsx` boundary, gated behind the **experimental `authInterrupts`**
`next.config` flag. Adopting it would let these routes return a true HTTP 403
while still rendering the branded `ForbiddenEditPage` chrome via the boundary.

This was **deliberately deferred** and is *not* adopted here:

- It turns on an **experimental** Next config flag (`authInterrupts`) and changes
  the response status across every `/edit/*` denial — a behavior change too close
  to launch to take on for a cosmetic status correction.
- Monitoring already has a precise, structured denial signal
  (`edit_authz_denied`), so the 403 buys no observability we lack today.

If revisited post-launch, the tradeoff to weigh is: a "more correct" 403 wire
status (matching the visible message) versus (a) depending on an experimental
Next flag, (b) re-validating that the new 403s don't trip any launch 4xx alarms,
and (c) confirming `/edit/*` stays `noindex` so the 403 carries no crawler
signal. The migration would replace each `return <ForbiddenEditPage … />` with a
`forbidden()` call and a `forbidden.tsx` boundary that renders the same chrome.
