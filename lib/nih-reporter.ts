/**
 * Issue #90 — NIH RePORTER deep-link URL helpers.
 *
 * Two flavors:
 *
 *   1. PI-portfolio link (`nihReporterPiUrl`) — points at a *server-side
 *      proxy* on this app, not directly at RePORTER. Reason: RePORTER's
 *      SPA does not honor query-string deep-links like
 *      `/search/-/projects?pi_profile_ids=X` — the URL renders an error
 *      page. The only working form is `/search/<server-minted-token>/projects`,
 *      and the token comes from a POST to `/services/Projects/search/`.
 *      The proxy route at `/api/nih-portfolio` mints a token at click
 *      time and 302-redirects.
 *
 *   2. Project-detail link (`nihReporterProjectUrl`) — direct, stable.
 *      The `/project-details/<applId>` URL has been the canonical form
 *      across multiple RePORTER frontend rewrites.
 */

const REPORTER_BASE = "https://reporter.nih.gov";

/** Click-through proxy that mints a search token at click time and
 *  redirects the user to the resulting RePORTER search URL. The
 *  `cwid` form is preferred over a raw `profile_id` so the link rotates
 *  cleanly when the resolver picks a new preferred profile_id for a
 *  scholar (e.g. legacy duplicate-eRA-Commons cleanup). */
export function nihReporterPiUrl(input: { cwid: string } | { profileId: number }): string {
  if ("cwid" in input) {
    return `/api/nih-portfolio?cwid=${encodeURIComponent(input.cwid)}`;
  }
  return `/api/nih-portfolio?profile_id=${input.profileId}`;
}

/** Outbound link to a single project's RePORTER detail page, keyed by
 *  `appl_id` (already populated on `Grant.applId` for matched NIH grants). */
export function nihReporterProjectUrl(applId: number): string {
  return `${REPORTER_BASE}/project-details/${applId}`;
}

/** Mint a server-side RePORTER search token for a given PI profile_id.
 *  Used by the `/api/nih-portfolio` route. Returns the search URL that
 *  the user can be redirected to.
 *
 *  Throws on RePORTER errors so the route can render a graceful fallback. */
export async function buildNihReporterPiSearchUrl(profileId: number): Promise<string> {
  const resp = await fetch(`${REPORTER_BASE}/services/Projects/search/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset: 0,
      limit: 1,
      facet_filters: null,
      // The /services endpoint expects pi_profile_ids as a STRING, not
      // an array (the public /v2 API uses arrays — different shape).
      criteria: { pi_profile_ids: String(profileId) },
      is_shared: false,
    }),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(`RePORTER search-mint failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { meta?: { search_id?: string } };
  const searchId = data.meta?.search_id;
  if (!searchId) {
    throw new Error("RePORTER search-mint returned no search_id");
  }
  return `${REPORTER_BASE}/search/${searchId}/projects`;
}
