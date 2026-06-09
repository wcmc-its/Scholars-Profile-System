/**
 * #794 — single source of truth for which producer populates the `scholar_tool`
 * table. The legacy path scans the ReciterAI `TOOL#` DynamoDB items (raw,
 * slug-mangled, no canonical dedup); the A2 path reads the canonical v7 tools
 * taxonomy published to s3://wcmc-reciterai-artifacts/tools/.
 *
 * Two readers agree on the same rule by importing from here:
 *   - `etl/dynamodb/index.ts`  (Block 5 — runs only in `ddb` mode)
 *   - `etl/tools/index.ts`     (the S3 loader — writes only in `s3` mode)
 *
 * Exactly one of them writes `scholar_tool` per run; the flag is the switch.
 * Default is `ddb` (legacy) so the migration is reversible until ReciterAI
 * supersedes the legacy DDB items (the gate documented on #794). To cut over:
 * set `SCHOLAR_TOOL_SOURCE=s3` (per-env, in the ETL container `environment:`
 * block — see cdk/lib/etl-stack.ts).
 *
 * Pure, no DB/AWS dependency — safe to import from either ETL entrypoint.
 */
export type ScholarToolSource = "ddb" | "s3";

/**
 * Resolve the active `scholar_tool` producer.
 *
 *   `SCHOLAR_TOOL_SOURCE=s3` → "s3"  (A2 canonical taxonomy via etl/tools)
 *   otherwise (unset / "ddb") → "ddb" (legacy DynamoDB TOOL# via Block 5)
 *
 * An unrecognized value logs a warning and falls through to the "ddb" default.
 */
export function resolveScholarToolSource(): ScholarToolSource {
  const v = process.env.SCHOLAR_TOOL_SOURCE;
  if (v && v !== "ddb" && v !== "s3") {
    console.warn(
      `[scholar-tool] ignoring unrecognized SCHOLAR_TOOL_SOURCE="${v}"; using "ddb"`,
    );
  }
  return v === "s3" ? "s3" : "ddb";
}
