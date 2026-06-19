/**
 * #1119 / ReciterAI#238 — change-detection signature for the tools-ETL
 * short-circuit.
 *
 * The tools ETL writes `scholar_tool` AND `scholar_family` from FOUR manifest
 * objects: `tools.json` (the canonical tools[] + faculty{}), `families.json`
 * (definitions, #879), `faculty.json`, and `tool_context.json` (per-tool usage
 * snippets, #1119). The original short-circuit compared only the manifest
 * top-level `sha256`, which is documented as the sha of the PRIMARY artifact
 * (`tools.json`) bytes alone. So when ReciterAI republished ONLY
 * `tool_context.json` (the sentence-aligned fix for ReciterAI#238) under a
 * byte-identical `tools.json`, the top-level sha was unchanged and the corrected
 * snippets were SILENTLY SKIPPED — the run recorded a 0-row "success" and left
 * the stale fragments live.
 *
 * The fix: derive the bookmark from the shas of ALL manifest objects (sorted by
 * filename for stability), so a single-object republish of any of the four
 * inputs is detected. Stored in `etl_run.manifestSha256` and compared on the
 * next run, exactly as before — only the basis is broadened.
 *
 * Pure (crypto only), no DB/AWS/index.ts dependency — safe to unit-test and to
 * import from the ETL entrypoint without executing its `main()`.
 */
import { createHash } from "node:crypto";

export interface ManifestSignatureInput {
  /** Legacy top-level sha (primary artifact, tools.json). Fallback basis only. */
  sha256?: string | null;
  /** Per-object integrity map: filename -> { sha256 }. */
  objects?: Record<string, { sha256?: string | null } | undefined> | null;
}

/**
 * A stable digest over every manifest object's sha256 (sorted by object key),
 * NOT just the primary `tools.json` sha. Two manifests that differ only in
 * `tool_context.json` (or `families.json`, or `faculty.json`) yield DIFFERENT
 * signatures, so the short-circuit no longer masks a single-object republish.
 *
 * Falls back to the legacy top-level `sha256` when the manifest carries no
 * `objects` map (defensive — a malformed/pre-A2 manifest still gets a usable,
 * if coarser, change signal rather than throwing).
 */
export function manifestContentSignature(manifest: ManifestSignatureInput): string {
  const objects = manifest.objects ?? {};
  const keys = Object.keys(objects).sort();
  if (keys.length === 0) {
    return manifest.sha256 ?? "";
  }
  const basis = keys.map((key) => `${key}:${objects[key]?.sha256 ?? ""}`).join("\n");
  return createHash("sha256").update(basis).digest("hex");
}
