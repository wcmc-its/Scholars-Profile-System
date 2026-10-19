import { NotFoundContent } from "@/components/site/not-found-content";
import { NotFoundBeacon } from "@/components/site/not-found-beacon";

/**
 * In-group 404 (#668 §2). Catches `notFound()` thrown from inside the
 * `(public)` group — a missing/non-public/sparse-hidden profile, or a missing
 * topic / center / department. Renders inside `(public)/layout`, so the
 * `SiteHeader`/`SiteFooter` chrome and the skip-link/`main-content` wrapper
 * come for free — this file renders only the shared body.
 *
 * MUST stay free of dynamic APIs (`headers()` / `cookies()`): the layout
 * renders this element on the server as part of every route's tree, so a
 * dynamic call here forces EVERY page in the group dynamic and silently
 * defeats ISR (guarded by `dynamic = "error"` on `/browse`).
 *
 * `not_found` telemetry is sent from the client by `NotFoundBeacon`, with a
 * best-effort `pattern` from the path (`/scholars/*` or a bare root slug →
 * "profile", else "other"). A legacy VIVO `/display/cwid-*` URL whose CWID no
 * longer resolves lands here as a `/scholars/by-cwid/*` miss (#1940: the proxy
 * redirects every legacy CWID to the resolver), so it counts as "profile".
 * Other legacy VIVO paths are not in the `(public)` group and are handled by
 * the root `app/not-found.tsx`.
 */
export default function PublicNotFound() {
  return (
    <>
      <NotFoundContent />
      <NotFoundBeacon variant="public" />
    </>
  );
}
