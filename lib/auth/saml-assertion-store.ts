/**
 * SAML assertion single-use ledger (issue #1439).
 *
 * A validated SAMLResponse only proves a *fresh* login the first time it is
 * presented. Because the SP keeps no server-side request/response state and
 * runs 1–2 Fargate tasks, a still-time-valid SAMLResponse could be POSTed to
 * the ACS a second time (possibly against a different task) to mint another
 * session. An in-memory cache cannot prevent that — the second POST can be
 * routed to the instance that never saw the first.
 *
 * This module records each consumed assertion in a shared table
 * (`SamlAssertionSeen`) keyed by the assertion's own signature-covered id. The
 * insert doubles as the guard: a duplicate primary key means the same assertion
 * is being presented again, so the callback rejects the login instead of
 * minting a session. The check is therefore instance-independent — it holds
 * regardless of which task the second presentation lands on.
 *
 * Node-runtime only (Prisma). Never import from Edge middleware.
 */
import { db } from "@/lib/db";

/** A consumed assertion's dedup key and the horizon after which it may be pruned. */
export interface AssertionIdentity {
  /**
   * Stable, deterministic unique id for the assertion — the SAML assertion ID
   * when present (signature-covered, so unforgeable and identical on a repeat
   * presentation), falling back to the response ID or a hash of the raw
   * SAMLResponse. The same message always maps to the same id; two distinct
   * logins never collide.
   */
  id: string;
  /**
   * When the row is safe to prune: the assertion's validity horizon
   * (NotOnOrAfter + clock skew). node-saml independently rejects a time-expired
   * assertion, so a pruned row can never gate a still-acceptable one.
   */
  expiresAt: Date;
}

/** Prisma unique-constraint violation — a duplicate PK, i.e. a re-presented assertion. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * Record `identity` as consumed and report whether it was already present.
 *
 * - First presentation: the row inserts, `{ duplicate: false }` is returned,
 *   and expired rows are pruned opportunistically (best-effort; a prune failure
 *   never fails the login).
 * - Second presentation of the same assertion: the insert hits the primary-key
 *   uniqueness constraint (P2002) and `{ duplicate: true }` is returned — the
 *   caller must NOT mint a session.
 * - Any other write failure is re-thrown: without a durable record we cannot
 *   guarantee single-use, so the caller fails closed (no session).
 */
export async function markAssertionConsumed(
  identity: AssertionIdentity,
  now: Date = new Date(),
): Promise<{ duplicate: boolean }> {
  try {
    await db.write.samlAssertionSeen.create({
      data: { id: identity.id, expiresAt: identity.expiresAt },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { duplicate: true };
    // Not a duplicate — a genuine write error. Propagate so the ACS fails
    // closed rather than minting a session it cannot mark single-use.
    throw err;
  }

  // Opportunistic housekeeping: drop rows whose assertions node-saml would now
  // reject on their own timestamps. Best-effort — pruning is not correctness,
  // so a failure here must never turn a legitimate login into an error.
  try {
    await db.write.samlAssertionSeen.deleteMany({
      where: { expiresAt: { lt: now } },
    });
  } catch {
    // ignore
  }

  return { duplicate: false };
}
