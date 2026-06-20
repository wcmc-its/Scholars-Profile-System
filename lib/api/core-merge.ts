/**
 * Read-time merge of `CoreClaim` (the ADR-005 override) over the ETL-projected
 * `publication_core.status`. Mirrors `lib/api/manual-layer.ts`: a thin DB loader
 * plus a PURE merge function that is unit-tested without a DB.
 *
 * An ACTIVE claim (`revokedAt IS NULL`) takes precedence over the engine status:
 *   - `claimed`  → effective "confirmed" (surfaces on the profile; drops out of
 *                  the owner's candidate queue)
 *   - `rejected` → effective "rejected" (excluded from the profile AND the queue)
 * A soft-revoked claim (`revokedAt` set) is ignored — the engine status stands —
 * so the loaders filter on `revokedAt: null`.
 */
import { db } from "@/lib/db";
import type { ClaimStatus } from "@/lib/generated/prisma/client";

/** The engine status (`publication_core.status`) after a human claim is applied. */
export type EffectiveCoreStatus = "confirmed" | "candidate" | "below_threshold" | "rejected";

/** Stable map key for a (publication, core) pair. */
export function claimKey(pmid: string, coreId: string): string {
  return `${pmid}::${coreId}`;
}

/**
 * The effective status of one (pub, core) pair. An active claim takes precedence
 * over the ETL-projected engine status; with no claim the engine status passes
 * through, normalizing any unexpected value to "candidate" so a downstream
 * consumer never has to defend against an unknown.
 */
export function effectiveCoreStatus(
  etlStatus: string,
  claim: ClaimStatus | null | undefined,
): EffectiveCoreStatus {
  if (claim === "claimed") return "confirmed";
  if (claim === "rejected") return "rejected";
  return etlStatus === "confirmed" || etlStatus === "below_threshold"
    ? etlStatus
    : "candidate";
}

/** True when the pair should surface as a confirmed core usage (profile + counts). */
export function isEffectiveConfirmed(
  etlStatus: string,
  claim: ClaimStatus | null | undefined,
): boolean {
  return effectiveCoreStatus(etlStatus, claim) === "confirmed";
}

/** True when the pair is still an open candidate for the owner's review queue. */
export function isOpenCandidate(
  etlStatus: string,
  claim: ClaimStatus | null | undefined,
): boolean {
  // A claimed/rejected pair has been decided; only an unclaimed engine candidate
  // is "open". (A confirmed engine row is a deterministic match, not a queue item.)
  return claim == null && etlStatus === "candidate";
}

/** Minimal read surface so the loaders stay injectable for integration tests. */
type CoreClaimReader = Pick<typeof db.read, "coreClaim">;

/** Active (un-revoked) claims for one core, keyed by `pmid`. */
export async function loadActiveCoreClaimsByCore(
  coreId: string,
  client: CoreClaimReader = db.read,
): Promise<Map<string, ClaimStatus>> {
  const rows = await client.coreClaim.findMany({
    where: { coreId, revokedAt: null },
    select: { pmid: true, status: true },
  });
  return new Map(rows.map((r) => [r.pmid, r.status]));
}

/** Active (un-revoked) claims across a set of pmids, keyed by `claimKey(pmid, coreId)`. */
export async function loadActiveCoreClaimsForPmids(
  pmids: ReadonlyArray<string>,
  client: CoreClaimReader = db.read,
): Promise<Map<string, ClaimStatus>> {
  if (pmids.length === 0) return new Map();
  const rows = await client.coreClaim.findMany({
    where: { pmid: { in: [...pmids] }, revokedAt: null },
    select: { pmid: true, coreId: true, status: true },
  });
  return new Map(rows.map((r) => [claimKey(r.pmid, r.coreId), r.status]));
}
