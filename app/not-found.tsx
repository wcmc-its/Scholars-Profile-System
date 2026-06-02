import { headers } from "next/headers";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { NotFoundContent } from "@/components/site/not-found-content";
import { logVivoFourOhFour, VIVO_PATTERN } from "@/lib/analytics/vivo-pattern";
import { logNotFound } from "@/lib/analytics/errors";

/**
 * Root 404 (#668 §2) — the catch site for everything OUTSIDE the `(public)`
 * route group: dead legacy VIVO profile URLs (`/display/cwid-…`), unmatched
 * paths, and root-alias misses (`app/[slug]/page.tsx → notFound()`). The root
 * layout (`app/layout.tsx`) does not include the site chrome, so this file
 * renders `SiteHeader`/`SiteFooter` directly (both are standalone and
 * cookie-safe). In-group 404s use `(public)/not-found.tsx`, which inherits the
 * chrome from `(public)/layout`.
 *
 * Telemetry: keeps the unchanged `vivo_404` signal (ANALYTICS-04 redirect-map
 * pruning) and adds the generalized `not_found` event alongside it.
 *
 * Header source for the incoming pathname: tries x-invoke-path,
 * x-nextjs-matched-path, x-matched-path, x-pathname in order, then falls back
 * to the referer path. Belt-and-suspenders against the unstable-header risk.
 */
export default async function NotFound() {
  const h = await headers();
  const pathname =
    h.get("x-invoke-path") ??
    h.get("x-nextjs-matched-path") ??
    h.get("x-matched-path") ??
    h.get("x-pathname") ??
    extractPathFromReferer(h.get("referer")) ??
    "";

  const isVivo = VIVO_PATTERN.test(pathname);
  logVivoFourOhFour(pathname);
  logNotFound({ path: pathname, pattern: isVivo ? "vivo" : "other" });

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex-1">
        <NotFoundContent isVivo={isVivo} />
      </div>
      <SiteFooter />
    </div>
  );
}

function extractPathFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).pathname;
  } catch {
    return null;
  }
}
