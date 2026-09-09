/**
 * The `etl_run` row the Tools import writes, as a PURE function.
 *
 * WHY THIS IS ITS OWN MODULE. It was inline in `etl/tools/index.ts`, which runs
 * `main()` on import and therefore cannot be loaded by a test. That gap shipped
 * a real bug: the `manifestGeneratedAt` anchor was computed, logged about, and
 * documented in a fifteen-line comment — and never actually placed in the
 * `data` object. Nothing caught it. `tsc` could not: the Prisma field is
 * optional, so an absent key is legal. ESLint could not: the value IS
 * referenced, in the null-check that emits the warning. The only symptom was a
 * NULL column in the database and a Tools row that went on reading green.
 *
 * So the rule this module exists to enforce: the anchor is computed and placed
 * in the SAME expression, and a test asserts it arrives. A value that is
 * derived but never written is this repo's single most common latent bug, and
 * "the comment says it happens" is not evidence that it does.
 */
import { parseManifestGeneratedAt } from "../freshness/anchor";

/** Only the manifest fields this row reads. Structural, so callers keep their own type. */
export type ToolsRunManifest = {
  generated_at?: string;
  version?: string;
};

export type ToolsRunRecord = {
  source: string;
  status: string;
  startedAt: Date;
  completedAt: Date;
  rowsProcessed: number;
  errorMessage: string | null;
  manifestSha256: string | null;
  manifestTaxonomyVersion: string | null;
  manifestGeneratedAt: Date | null;
};

/**
 * Build the row. `manifestSha256` is passed in already computed because its
 * signature helper lives with the artifact-loading code; everything else about
 * the row is decided here.
 *
 * §2.1: Tools IS generated_at-anchored, as of the tools-cadence decision.
 *
 * It was not, for a real reason: the tools producer is hand-run, so this anchor
 * makes the row read stale whenever nobody has republished — which is most of
 * the time, and which is a false alarm about OUR import. What changed is not
 * that reason but the ANSWER to it. Anchoring alone would paint a permanently
 * red row with no route back to green, so it lands together with the `Tools`
 * FreshnessAck in lib/etl/freshness-policy.ts, which accepts that staleness
 * until a dated expiry. The two are one change and must not be separated: the
 * ack suppresses only a source that grades STALE, so without this anchor it is
 * inert (and the heartbeat's own anti-clutter rule would tell you to delete
 * it); and without the ack this anchor is the cry-wolf the ack prevents.
 *
 * A null anchor (absent, malformed or future `generated_at`) means freshness
 * falls back to `completedAt` — the pre-existing behaviour, never a throw.
 */
export function buildToolsRunRecord(args: {
  source: string;
  status: "success" | "failed";
  startedAt: Date;
  completedAt: Date;
  rowsProcessed: number;
  errorMessage?: string;
  manifest?: ToolsRunManifest;
  manifestSha256: string | null;
  now: number;
}): ToolsRunRecord {
  return {
    source: args.source,
    status: args.status,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    rowsProcessed: args.rowsProcessed,
    errorMessage: args.errorMessage ?? null,
    manifestSha256: args.manifestSha256,
    // A shared free-text column; Tools has no taxonomy, so it carries the
    // artifact publish version for readable operator diagnostics.
    manifestTaxonomyVersion: args.manifest?.version ?? null,
    manifestGeneratedAt: parseManifestGeneratedAt(args.manifest?.generated_at, args.now),
  };
}
