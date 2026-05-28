/**
 * Validate a client-reported page URL is same-origin with the configured
 * Scholars site. Returns the normalized URL string on success or `null`
 * for any failure mode (malformed, cross-origin, non-http, empty, etc.).
 *
 * This is the v1 trust floor for the submission server action's
 * `pageUrl` — see `docs/feedback-badge-spec.md` § "Anti-spam (lightweight,
 * not rate-limit)". A hostile client can still lie about the URL within
 * the configured origin set; we accept that trade-off in exchange for not
 * needing HMAC/CSRF token machinery.
 *
 * The allowed origin set is the comma-separated value of
 * `FEEDBACK_SITE_ORIGIN` if set, else `NEXT_PUBLIC_SITE_URL`. The
 * comma-separated form supports a configured-alias domain or a
 * dev/preview host alongside production without code change.
 */

export type FeedbackEnv = Record<string, string | undefined>;

/** Parse the env into a deduplicated list of `protocol//host` origins. */
export function getAllowedOrigins(env: FeedbackEnv = process.env): string[] {
  const raw = env.FEEDBACK_SITE_ORIGIN || env.NEXT_PUBLIC_SITE_URL || "";
  const out = new Set<string>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === "https:" || u.protocol === "http:") {
        out.add(`${u.protocol}//${u.host}`);
      }
    } catch {
      // Bad entry — skip, do not throw.
    }
  }
  return [...out];
}

/**
 * Returns the canonicalized URL string (no credentials, no fragment) if
 * the input parses and its origin is in the allowlist; `null` otherwise.
 *
 * NULL is a valid storage outcome — the submission row keeps every
 * answer the user gave and just loses the page provenance.
 */
export function validateSameOriginUrl(
  input: string | null | undefined,
  env: FeedbackEnv = process.env,
): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) return null; // closed by default — never trust if unconfigured
  if (!allowed.includes(`${parsed.protocol}//${parsed.host}`)) return null;
  // Strip embedded credentials + the fragment (purely client-side, no analytic value).
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}
