/**
 * Volume guards for mirror-the-source ETL steps
 * (docs/etl-reliability-audit-2026-07-02.md, PR-1).
 *
 * The mirror design deletes/tombstones whatever SPS holds that the source did
 * not return, which is correct on a healthy read and catastrophic on a
 * *successful-but-truncated* one (LDAP ACL scope change, upstream table read
 * mid-rebuild, empty view). These guards throw BEFORE a module's destructive
 * pass; the throw rides each module's existing etl_run-failed + non-zero-exit
 * path, so the Step Functions Catch -> SNS alerting fires as usual and no
 * partial write happens.
 *
 * Operator bypass (deliberate mass events, e.g. a real bulk offboarding):
 * ETL_GUARD_BYPASS="all" or a comma-separated list of guard names, e.g.
 * ETL_GUARD_BYPASS="ed:scholar-soft-delete,coi:disclosures".
 *
 * Both checks no-op when the existing/reference count is 0 so bootstrap runs
 * against an empty database pass.
 */

export class EtlGuardError extends Error {
  constructor(guard: string, detail: string) {
    super(
      `[etl-guard:${guard}] ${detail} — refusing to proceed. If this shrink is ` +
        `expected, re-run with ETL_GUARD_BYPASS="${guard}" (or "all").`,
    );
    this.name = "EtlGuardError";
  }
}

function bypassed(guard: string): boolean {
  const raw = process.env.ETL_GUARD_BYPASS;
  if (!raw) return false;
  const list = raw.split(",").map((s) => s.trim().toLowerCase());
  const hit = list.includes("all") || list.includes(guard.toLowerCase());
  if (hit) console.warn(`[etl-guard:${guard}] BYPASSED via ETL_GUARD_BYPASS`);
  return hit;
}

/**
 * Assert the source returned a plausible volume before mirroring it.
 * - `floor`: absolute minimum incoming rows.
 * - `maxDropPct`: max tolerated percentage shrink of `incoming` vs `existing`
 *   (skipped when `existing` is 0 — bootstrap).
 */
export function assertSourceVolume(
  guard: string,
  opts: { incoming: number; existing?: number; floor?: number; maxDropPct?: number },
): void {
  if (bypassed(guard)) return;
  const { incoming, existing, floor, maxDropPct } = opts;
  if (floor !== undefined && incoming < floor) {
    throw new EtlGuardError(
      guard,
      `source returned ${incoming} rows, below the ${floor} floor (likely truncated read)`,
    );
  }
  if (maxDropPct !== undefined && existing !== undefined && existing > 0) {
    const dropPct = ((existing - incoming) / existing) * 100;
    if (dropPct > maxDropPct) {
      throw new EtlGuardError(
        guard,
        `source returned ${incoming} rows vs ${existing} existing ` +
          `(${dropPct.toFixed(1)}% drop > ${maxDropPct}% allowed)`,
      );
    }
  }
}

/**
 * Assert a prune/tombstone pass is not implausibly large: `pruning` rows about
 * to be deleted out of `of` current rows (skipped when `of` is 0).
 */
export function assertPruneVolume(
  guard: string,
  opts: { pruning: number; of: number; maxPct: number },
): void {
  if (bypassed(guard)) return;
  const { pruning, of, maxPct } = opts;
  if (of <= 0) return;
  const pct = (pruning / of) * 100;
  if (pct > maxPct) {
    throw new EtlGuardError(
      guard,
      `about to prune ${pruning} of ${of} rows (${pct.toFixed(1)}% > ${maxPct}% allowed)`,
    );
  }
}
