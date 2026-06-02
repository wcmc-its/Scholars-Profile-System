/**
 * B01 — return-path / RelayState validation (issue #100).
 *
 * Open-redirect guard. After SSO the user is sent back to the path they were
 * trying to reach; that path is untrusted input — the `?return=` query on the
 * login route, echoed through SAML RelayState by the IdP. An attacker who can
 * choose it could turn the login endpoint into an open redirect. These checks
 * confine the post-login destination to a local path under one of the curated
 * site surfaces ({@link ALLOWED_PATH_PREFIXES}).
 *
 * The allowlist covers `/edit*` (the auth-gated surface — B01's original
 * scope) **and** the public site surface (`/`, `/scholars/*`, `/browse/*`,
 * `/centers/*`, `/departments/*`, `/topics/*`, `/about/*`, `/search/*`).
 * The public broaden (#356 Phase 5 D5.1) is what lets the header's "Sign in"
 * actually return the user to the public page they were on — without it the
 * UI-SPEC's "the Edit my profile button materialises on the post-sign-in
 * navigation back" flow does not work, and a scholar signing in on their
 * own profile lands on `/edit` instead.
 *
 * **Threat model for the public broaden.** All allow-listed public routes
 * are GET-only static-render pages; a 302 to one of them carries no
 * privilege a fresh navigation wouldn't. One genuinely new fact the
 * Shibboleth IdP audit log learns is correlation — "user X authenticated
 * while sitting on path Y." For the common case (scholar signing in on
 * their own `/scholars/{self}`) Y == X's identity and the IdP already
 * knows it. For the rarer case (someone signs in while viewing a
 * different scholar's page), the log gains a weak inference "X was on Y
 * at sign-in moment." Given the IdP audit log is IAM-team-only and the
 * inference is weak, this is de minimis but worth recording so a future
 * security reviewer doesn't have to rediscover it.
 *
 * **Maintenance.** `ALLOWED_PATH_PREFIXES` is hand-maintained. When a new
 * public top-level route is added to `app/(public)/`, add its prefix
 * here — otherwise the SSO `?return=` for that path will silently fall
 * back to the default and the user lands somewhere unexpected after
 * sign-in.
 *
 * #671 — also accepts a root people-profile path (`/{slug}`): a single
 * reserved-free lowercase slug-shaped segment. `/` cannot be an allow-list
 * *prefix* (it prefixes every path), so root profiles need their own matcher.
 * All such targets are GET-only public profile renders (or a 404), carrying no
 * privilege a fresh navigation wouldn't — the same de-minimis surface as the
 * other public allow-listed routes. Sensitive single-segment words (`admin`,
 * `login`, `logout`, `auth`, `api`, `edit`, …) are in `RESERVED_SLUGS` and so
 * are excluded by construction.
 *
 * Imports only the pure `RESERVED_SLUGS` / `looksLikeSlug` from `@/lib/slug`
 * (no runtime deps) — still safe in both the Edge and Node runtimes.
 */

import { looksLikeSlug, RESERVED_SLUGS } from "@/lib/slug";

const MAX_RETURN_PATH_LENGTH = 512;

/**
 * The curated set of return-path prefixes. The matcher for each entry is
 * "exact, or followed by `/`, `?`, or `#`" — the same shape the original
 * `/edit` check used; this preserves the `/edit` vs `/editfoo` rejection
 * for every entry, so e.g. `/scholarsfoo` is rejected the same way.
 *
 * The homepage `/` is matched separately as an exact-only entry — every path
 * begins with `/`, so a prefix match on `/` would accept everything.
 */
const ALLOWED_PATH_PREFIXES = [
  "/edit",
  "/scholars",
  "/centers",
  "/departments",
  "/topics",
  "/about",
  "/browse",
  "/search",
] as const;

/**
 * #671 — true for a root people-profile path: exactly one path segment that is
 * a reserved-free, lowercase slug-shaped token (e.g. `/jane-doe`). Mirrors the
 * gate the root `(public)/[slug]` route applies, so the post-login return set
 * is exactly "renders-or-404s as a profile". Multi-segment paths and reserved
 * route words fall through to the prefix allow-list. The caller
 * (`isSafeReturnPath`) has already rejected `..`, `//`, `/\`, control chars,
 * and over-length input before this runs.
 */
function isRootProfilePath(path: string): boolean {
  const seg = path.replace(/[?#].*$/, "").slice(1); // drop leading "/" + query/hash
  if (seg === "" || seg.includes("/")) return false;
  if (RESERVED_SLUGS.has(seg)) return false;
  return looksLikeSlug(seg);
}

function matchesAllowedPath(path: string): boolean {
  if (path === "/") return true;
  for (const prefix of ALLOWED_PATH_PREFIXES) {
    if (path === prefix) return true;
    if (
      path.startsWith(prefix + "/") ||
      path.startsWith(prefix + "?") ||
      path.startsWith(prefix + "#")
    ) {
      return true;
    }
  }
  return isRootProfilePath(path);
}

/**
 * True iff `path` is safe to 302-redirect to after login: a local, same-origin
 * path under one of the {@link ALLOWED_PATH_PREFIXES} (or the homepage `/`).
 * Rejects absolute URLs, protocol-relative (`//host`) and backslash (`/\host`)
 * forms, `..` traversal, control characters, and any path outside the curated
 * allowlist.
 */
export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.length > MAX_RETURN_PATH_LENGTH) return false;
  // Must be a local absolute path...
  if (!path.startsWith("/")) return false;
  // ...but not protocol-relative (`//evil.com`) or the backslash variant some
  // browsers normalize to `//` (`/\evil.com`).
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  // No `..` anywhere — conservative: a 302 to `/edit/../admin` would resolve
  // off the allow-listed surface, and any `..` substring is cheap to just
  // reject.
  if (path.includes("..")) return false;
  // No control characters or spaces — keeps the value safe to place in a
  // redirect Location header (blocks CR/LF injection and tab/space smuggling).
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return matchesAllowedPath(path);
}

/**
 * `path` when it passes {@link isSafeReturnPath}, otherwise `fallback` — the
 * caller sources `fallback` from `getDefaultReturnPath()`.
 */
export function safeReturnPath(
  path: string | null | undefined,
  fallback: string,
): string {
  return isSafeReturnPath(path) ? path : fallback;
}
