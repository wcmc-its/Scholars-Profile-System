/**
 * Phase 6 / ANALYTICS-04 — VIVO legacy 404 telemetry.
 *
 * The legacy WCM VIVO site exposes profile URLs of the form
 * `/display/cwid-{alphanumeric}`. After cutover, requests to those URLs
 * that miss the nginx redirect map (Phase 5 SEO-04) reach the Next.js
 * app and 404. We log them as structured events so the team can prune
 * the redirect map over time.
 *
 * Per Phase 5 D-04, no Next.js middleware was built — the global
 * `app/not-found.tsx` is the catch site.
 */

/** VIVO legacy profile URL pattern. Anchored at both ends. */
export const VIVO_PATTERN = /^\/display\/cwid-\w+$/;

/**
 * Emits a structured `vivo_404` log event when `pathname` matches the
 * VIVO profile pattern. Pure function — no side effects on non-match.
 * Logs only the path (never query strings) per RESEARCH.md threat model.
 */
export function logVivoFourOhFour(pathname: string): void {
  if (!VIVO_PATTERN.test(pathname)) return;
  console.log(
    JSON.stringify({
      event: "vivo_404",
      url: pathname,
      ts: new Date().toISOString(),
    }),
  );
}
