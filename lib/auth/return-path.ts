/**
 * B01 — return-path / RelayState validation (issue #100).
 *
 * Open-redirect guard. After SSO the user is sent back to the path they were
 * trying to reach; that path is untrusted input — the `?return=` query on the
 * login route, echoed through SAML RelayState by the IdP. An attacker who can
 * choose it could turn the login endpoint into an open redirect. These checks
 * confine the post-login destination to a local path under the `/edit` surface.
 *
 * Pure functions, no imports — safe in both the Edge and Node runtimes.
 */

const MAX_RETURN_PATH_LENGTH = 512;

/**
 * True iff `path` is safe to 302-redirect to after login: a local, same-origin
 * path under the `/edit` surface. Rejects absolute URLs, protocol-relative
 * (`//host`) and backslash (`/\host`) forms, `..` traversal, control
 * characters, and any path outside `/edit`.
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
  // off the /edit surface, and any `..` substring is cheap to just reject.
  if (path.includes("..")) return false;
  // No control characters or spaces — keeps the value safe to place in a
  // redirect Location header (blocks CR/LF injection and tab/space smuggling).
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  // Confine to the /edit surface: exactly `/edit`, or a `/edit` path with a
  // child segment, query, or fragment. `/editfoo` is deliberately rejected.
  if (path === "/edit") return true;
  return (
    path.startsWith("/edit/") ||
    path.startsWith("/edit?") ||
    path.startsWith("/edit#")
  );
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
