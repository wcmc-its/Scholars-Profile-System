import { headers } from "next/headers";
import { NotFoundContent } from "@/components/site/not-found-content";
import { logNotFound } from "@/lib/analytics/errors";

/**
 * In-group 404 (#668 §2). Catches `notFound()` thrown from inside the
 * `(public)` group — a missing/non-public/sparse-hidden profile, or a missing
 * topic / center / department. Renders inside `(public)/layout`, so the
 * `SiteHeader`/`SiteFooter` chrome and the skip-link/`main-content` wrapper
 * come for free — this file renders only the shared body.
 *
 * Logs `not_found` with a best-effort `pattern` derived from the path prefix
 * (`/scholars/*` → "profile", else "other"). VIVO URLs never reach this site
 * (they are not in the `(public)` group), so they are handled by the root
 * `app/not-found.tsx`.
 */
export default async function PublicNotFound() {
  const h = await headers();
  const pathname =
    h.get("x-invoke-path") ??
    h.get("x-nextjs-matched-path") ??
    h.get("x-matched-path") ??
    h.get("x-pathname") ??
    "";

  logNotFound({ path: pathname, pattern: pathname.startsWith("/scholars") ? "profile" : "other" });

  return <NotFoundContent />;
}
