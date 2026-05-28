/**
 * Map a same-origin URL (already validated by `validateSameOriginUrl`)
 * to the Next.js route pattern its pathname matches. Used for aggregate
 * analysis — `/scholars/jane-smith` and `/scholars/john-doe` group as
 * `/scholars/[slug]`, which is the unit of analysis for "what surface
 * is feedback about".
 *
 * Patterns are hand-listed because runtime introspection of the Next.js
 * app router is not stable; the list is small and tracks the public
 * routes in `app/(public)/` plus `/edit/*` (#356).
 *
 * Returns the route pattern when matched, or the raw pathname (truncated
 * to fit the `page_route` 255-char column) when not — better to have an
 * approximate analytical key than `NULL` on every novel route.
 */

const PATTERNS: ReadonlyArray<{ match: RegExp; route: string }> = [
  { match: /^\/scholars\/[^/]+$/, route: "/scholars/[slug]" },
  { match: /^\/departments\/[^/]+$/, route: "/departments/[slug]" },
  { match: /^\/divisions\/[^/]+$/, route: "/divisions/[slug]" },
  { match: /^\/centers\/[^/]+$/, route: "/centers/[slug]" },
  { match: /^\/topics\/[^/]+$/, route: "/topics/[slug]" },
  { match: /^\/edit\/scholar\/[^/]+$/, route: "/edit/scholar/[cwid]" },
  { match: /^\/edit\/publication\/[^/]+$/, route: "/edit/publication/[pmid]" },
  { match: /^\/edit\/slug-requests$/, route: "/edit/slug-requests" },
  { match: /^\/edit$/, route: "/edit" },
  { match: /^\/about\/feedback$/, route: "/about/feedback" },
  // /about, /about/help, /about/methodology — collapse the rest of /about to one bucket
  { match: /^\/about(\/[^/]+)?$/, route: "/about" },
  { match: /^\/search$/, route: "/search" },
  { match: /^\/browse$/, route: "/browse" },
  { match: /^\/$/, route: "/" },
];

export function urlToPageRoute(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  // Strip a trailing slash except for root.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  for (const { match, route } of PATTERNS) {
    if (match.test(path)) return route;
  }
  // Unrecognized — keep the raw pathname so the analyst sees novel
  // routes appear in the dataset rather than disappearing into NULL.
  return path.slice(0, 255);
}
