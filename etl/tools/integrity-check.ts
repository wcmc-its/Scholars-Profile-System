/**
 * #2117 — shared sha256 integrity predicate for the tools ETL's three
 * manifest-object checks in `./index.ts`: the primary `tools.json` artifact,
 * the optional `tool_context.json` sidecar, and the paired `entities.json` /
 * `entity_context.json` entity layer.
 *
 * Fails CLOSED, matching `etl/hierarchy/index.ts` and `etl/spotlight/index.ts`
 * (`if (!manifest.sha256 || digest !== manifest.sha256)`): once a manifest
 * object has been decided fetchable and is fetched, an ABSENT sha256 on it
 * must fail the check, not be treated as "nothing to verify" — the previous
 * `if (expected && digest !== expected)` form short-circuited to false (and
 * silently skipped verification) whenever the manifest omitted the digest.
 * This predicate is unrelated to key-presence/optionality (whether a sidecar
 * object is declared in the manifest at all, which is correctly handled by
 * the surrounding `if (!obj?.key)` branches) — only whether a FETCHED
 * object's digest was actually verified.
 *
 * Kept in its own module (not `index.ts`) because `index.ts` self-runs
 * `main()` on import — a test importing from it would execute the ETL.
 */
export function shaIntegrityFailed(expected: string | undefined, digest: string): boolean {
  return !expected || digest !== expected;
}
