/**
 * Bearer-token authentication for `POST /api/revalidate` — issue #103 (B04).
 *
 * `/api/revalidate` is the webhook the ETL orchestrator calls after a run to
 * bust the ISR cache. The request carries `Authorization: Bearer <token>`; the
 * token is the `scholars/revalidate-token` Secrets Manager secret, injected as
 * the `SCHOLARS_REVALIDATE_TOKEN` environment variable.
 *
 * Rotation: `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS` holds the prior token and is
 * accepted alongside the current one for a window, so a caller that has not
 * picked up the new token yet — or a deployment mid-rollout — does not 401.
 * The tokens are read once and cached for the process lifetime; a serverless
 * cold start runs a fresh process and re-reads the environment, which is the
 * rotation boundary. See docs/revalidate-token-rotation.md.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality.
 *
 * Each input is SHA-256 hashed first: `timingSafeEqual` throws on unequal
 * buffer lengths, and a hash is a fixed 32 bytes, so neither the comparison
 * time nor a length check can leak the token's length.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The accepted revalidate tokens read from `env` — the current token first,
 * then the optional previous token. Blank and unset values are dropped.
 */
export function readRevalidateTokens(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [env.SCHOLARS_REVALIDATE_TOKEN, env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS]
    .map((token) => token?.trim() ?? "")
    .filter((token) => token.length > 0);
}

let cachedTokens: readonly string[] | undefined;

/**
 * The accepted tokens, read from `process.env` once and cached for the process
 * lifetime. A serverless cold start runs a fresh process and re-reads the
 * environment — that is the token-rotation boundary.
 */
export function getRevalidateTokens(): readonly string[] {
  if (cachedTokens === undefined) {
    cachedTokens = readRevalidateTokens();
  }
  return cachedTokens;
}

/** Test-only: drop the cache so the next `getRevalidateTokens()` re-reads env. */
export function resetRevalidateTokenCache(): void {
  cachedTokens = undefined;
}

/**
 * Whether an `Authorization` header carries a bearer token matching one of
 * `acceptedTokens`. The scheme is matched case-insensitively (RFC 7235). The
 * presented token is compared constant-time against every accepted token with
 * no early return, so neither which token matched (current vs. previous) nor
 * any token's length is observable through timing.
 */
export function isAuthorizedBearer(
  authorizationHeader: string | null | undefined,
  acceptedTokens: readonly string[],
): boolean {
  if (!authorizationHeader) return false;
  const match = /^Bearer +(.+)$/i.exec(authorizationHeader.trim());
  if (!match) return false;
  const [, rawToken] = match;
  const presented = rawToken.trim();
  if (presented.length === 0) return false;

  let authorized = false;
  for (const token of acceptedTokens) {
    if (timingSafeEqualStr(presented, token)) {
      authorized = true;
    }
  }
  return authorized;
}
