# docs/ADR-006 — Image optimization strategy: no runtime optimizer

**Status:** Accepted
**Date:** 2026-05-18
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

`B15` (#114) raises a production-readiness concern: `next/image` optimizes images at request time with `sharp`, which is CPU-heavy. On the 1-vCPU Fargate task that runs `next start`, `sharp` work would compete for CPU with request rendering and with the Prisma connection pool (`connection_limit=15`, `pool_timeout=10` — see [`PRODUCTION.md` § Database connection pooling](./PRODUCTION.md#database-connection-pooling)). The backlog item asks the team to choose one of: (a) pre-resize images in the ETL and serve them from S3 + CloudFront, (b) set `images.unoptimized: true` and skip the optimizer, or (c) run a separate image-optimization service.

An audit of the codebase finds the premise does not currently apply, and reframes the decision:

- **The application does not use `next/image`.** There is no `import ... from "next/image"` and no `<Image>` element anywhere in `app/`, `components/`, or `lib/`. The only `next/image` strings in the repo are this backlog item and two stale code comments.
- **The one image surface is the faculty headshot,** rendered by `components/scholar/headshot-avatar.tsx` through the Radix `Avatar` primitive (`components/ui/avatar.tsx`). `Avatar.Image` emits a native `<img>` element — no optimizer is involved.
- **Headshots are served by an external host, not by this system.** `lib/headshot.ts` builds the URL `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png` — the WCM Enterprise Directory API. The browser fetches it directly. The Fargate task never fetches, stores, or processes a headshot; neither does any ETL stage. There is no `public/` directory and no image asset in the repo.
- **Headshots render small.** `HeadshotAvatar` displays at `size-6` (24 px), `h-12` (48 px), or `h-24 sm:h-28` (96–112 px). 112 px is the largest a headshot is ever shown.
- When a headshot is missing or fails to load, `HeadshotAvatar` shows a deterministic CSS-gradient initials tile (`AvatarFallback`) — there is no broken-image state and no hard dependency on the directory being reachable.

So the `sharp`-starves-Prisma failure mode that `B15` describes has no code path that produces it today. The decision is therefore not "how do we make the optimizer cheap" but "do we keep image handling off the request path, and how do we keep it that way."

One adjacent surface is explicitly **out of scope**: the Open Graph card route `app/og/scholars/[slug]/route.tsx` uses `next/og`'s `ImageResponse`, a different mechanism (Satori text-to-SVG, not `sharp`, not `next/image`). It renders a text-only branded card — by current design (Phase 5 D-25) it does **not** embed the headshot — and already carries aggressive `Cache-Control`. It is unaffected by this ADR.

## Decision

**Adopt option (b): the application does not use the `next/image` runtime optimizer. Images are served unoptimized.** This codifies the architecture already in place and makes it enforced rather than incidental.

`next.config.ts` sets `images.unoptimized: true`:

```ts
  // ADR-006: headshots render as a native <img> via the Radix Avatar
  // primitive, not next/image. `unoptimized` is a forward-guard: if a
  // <Image> component is ever added, it will not route through the
  // request-time `/_next/image` sharp optimizer, which on the 1-vCPU
  // Fargate task would compete with Prisma for CPU
  // (PRODUCTION.md § Database connection pooling).
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "directory.weill.cornell.edu", pathname: "/**" },
    ],
  },
```

`remotePatterns` is retained as the documented allowlist of the headshot host; it is inert while `unoptimized` is set and costs nothing to keep.

The setting is a **forward-guard**, not a change in behavior: the app already serves a native `<img>`. Its value is that a future `<Image>` added without thought cannot silently turn on the `/_next/image` `sharp` path on the 1-vCPU task. The decision is then visible in config and explained at the point of use.

## Consequences

**Positive outcomes:**

No `sharp` and no image optimization on the request path — the CPU-contention failure mode in `B15` cannot occur, because the code path that would cause it does not exist and the config prevents it from being added accidentally.

The `/_next/image` endpoint is not part of any request path. That endpoint is also a known abuse surface (an attacker can request many `?w=` widths to burn origin CPU); keeping it unused removes that surface entirely, consistent with the edge-hardening posture of `B21` (#121).

Headshot traffic never reaches the origin. The browser fetches each `<img>` straight from `directory.weill.cornell.edu`, in parallel, cached by the browser. Fargate CPU, the Aurora connection pool, and our CloudFront distribution are all uninvolved in image delivery. This matches the load-shedding intent of [`PRODUCTION.md`](./PRODUCTION.md): the origin does the least work possible.

Local-dev parity is preserved — no optimizer, no `sharp` binary, no image pipeline to reproduce locally.

**Negative outcomes and mitigations:**

No responsive `srcset` is generated. At a maximum display size of 112 px this is immaterial — the byte difference between an optimizer-sized variant and the directory's native PNG for an avatar is small, fetched once, and browser-cached. If image usage ever grows beyond small avatars, see *Forward compatibility*.

The headshot host (`directory.weill.cornell.edu`) is a third-party runtime dependency for image rendering. This is already true today and is not introduced by this decision; it is bounded by the `AvatarFallback` initials tile, which renders whenever the image is absent, slow, or errors. The page itself never blocks on it.

`B15`'s description of option (b) — "let CDN serve origin images" — does not match this codebase: headshots are not origin images and do not pass through our CloudFront. The decision and its rationale are recorded here accordingly.

**Operational implications:**

`B15`'s acceptance criterion "load test in staging confirms image requests don't starve Prisma under 100 RPS" has no subject under option (b): there is no `/_next/image` request path to load-test. It should be replaced with a static check — confirm a production build emits no `/_next/image` URLs — which does not require the staging environment. This **removes `B15`'s dependency on `B13` (#112)**; `B15` can close ahead of the staging environment.

**Forward compatibility:**

This decision is scoped to the current image surface — small, externally-hosted faculty headshots. **Revisit this ADR if the product introduces content imagery that this assumption does not cover:** large or hero photography, publication figures, or headshots displayed at substantially larger or highly variable sizes. At that point option (a) becomes proportionate, and the right shape is `next/image` with a **custom `loader`** pointing at pre-resized variants in S3 + CloudFront — a custom loader bypasses `/_next/image` and `sharp` entirely (it only generates `<img srcset>` URLs), so it keeps responsive sizing without putting `sharp` back on the 1-vCPU task. Adopting `<Image>` with the *default* loader on self-hosted `next start` is the one path this ADR rules out.

## Alternatives Considered

**(a) Pre-resize images in the ETL; serve from S3 + CloudFront; point a `next/image` `loader` at it.** Rejected as disproportionate to the current need. It would require a new ETL stage that fetches every faculty headshot (~8,900 scholars, per the sitemap count in `PRODUCTION.md`) from the directory, resizes it, and uploads variants; a new S3 bucket and lifecycle policy; a new CloudFront origin and cache behavior; a `next/image` custom loader; and adopting `<Image>` in the headshot component — all to serve avatars that never exceed 112 px and that the WCM directory already serves for free. It also introduces a headshot-staleness/sync problem (the live URL has none) and would pre-commit storage infrastructure ahead of the unresolved headshot-consent question flagged in `app/og/scholars/[slug]/route.tsx` (Phase 5 D-25, "until headshot consent is confirmed post-launch"). `ADR-001` establishes that work belongs in the ETL rather than the request path — but its own reasoning rejects layers that must be built and kept in sync for benefit disproportionate to their cost. Option (b) honors `ADR-001`'s intent directly: it keeps image work off the request path by not doing image work at all. Option (a) remains the documented upgrade path if *Forward compatibility* triggers.

**(c) A separate image-optimization service.** Rejected. `B15` itself marks it "not recommended at this scale," and with no image-optimization workload to host it has no purpose. It is the highest-operational-cost option for the smallest current need.

## References

- `B15` (#114) — the backlog item this ADR closes.
- `B13` (#112) — staging environment; option (b) removes `B15`'s dependency on it (see *Operational implications*).
- [`PRODUCTION.md` § Database connection pooling](./PRODUCTION.md#database-connection-pooling) — the 1-vCPU Fargate / `connection_limit=15` constraint that motivates `B15`.
- `ADR-001` — runtime data access layer = ETL transform; the precedent on keeping the request path lean.
- `lib/headshot.ts`, `components/scholar/headshot-avatar.tsx`, `components/ui/avatar.tsx` — the headshot rendering path audited for this decision.
- `next.config.ts` — the file the decision changes.
- #99 — production-readiness epic.
