import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { RootNotFoundBody } from "@/components/site/root-not-found-body";
import { NotFoundBeacon } from "@/components/site/not-found-beacon";

/**
 * Root 404 (#668 §2) — the catch site for everything OUTSIDE the `(public)`
 * route group: dead legacy VIVO profile URLs (`/display/cwid-…`), unmatched
 * paths, and root-alias misses (`app/[slug]/page.tsx → notFound()`). The root
 * layout (`app/layout.tsx`) does not include the site chrome, so this file
 * renders `SiteHeader`/`SiteFooter` directly (both are standalone and
 * cookie-safe). In-group 404s use `(public)/not-found.tsx`, which inherits the
 * chrome from `(public)/layout`.
 *
 * MUST stay free of dynamic APIs (`headers()` / `cookies()`): the layout
 * renders this element on the server as part of every route's tree, so a
 * dynamic call here forces EVERY page dynamic and silently defeats ISR on `/`
 * and `/browse` (guarded by `dynamic = "error"` on those pages).
 *
 * Telemetry (`not_found` + the unchanged `vivo_404`) is sent from the client
 * by `NotFoundBeacon`, which reads the real path from `window.location`.
 *
 * The VIVO-migrant copy is decided client-side too (`RootNotFoundBody`).
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex-1">
        <RootNotFoundBody />
      </div>
      <SiteFooter />
      <NotFoundBeacon variant="root" />
    </div>
  );
}
