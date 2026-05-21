/**
 * Zero-downtime OpenSearch index rebuilds via alias swap (B18, #117).
 *
 * The three logical search indices (`scholars-people`, `scholars-publications`,
 * `scholars-funding`) are exposed to the application as *aliases* that point
 * at concrete versioned indices (`scholars-people-v3`, etc.). The application
 * query path is unaware -- it still reads from the constant names exported
 * from `lib/search.ts`. The rebuild flow:
 *
 *   1. Determine the current state -- alias-with-target / unaliased-index /
 *      absent -- and pick the next version number (vN+1 if alias, v1 if
 *      absent or bootstrapping from an unaliased index).
 *   2. Create the new versioned index with the mapping.
 *   3. Bulk-write all documents into the new versioned index (caller's
 *      `fillFn`; not this module's concern).
 *   4. Atomically repoint the alias via `POST /_aliases`. OpenSearch
 *      guarantees the body's actions array applies as one cluster-state
 *      transition, so reads transition from the old version to the new
 *      version with no in-between state.
 *   5. Delete prior versions beyond the retention threshold (default 2).
 *
 * Pulled out of `index.ts` so the mechanism can be unit-tested against a
 * mocked OpenSearch client without dragging the whole ETL orchestrator
 * (Prisma, manual-layer suppression load, MeSH coverage smokes, ...) into
 * the test harness.
 */
import { type Client } from "@opensearch-project/opensearch";

/**
 * Number of versioned indices to retain after a successful swap. Two is
 * "the just-promoted version plus one prior" -- enough to roll back to the
 * immediately-previous version manually (`docs/search.md § Rollback`) without
 * accumulating OpenSearch storage for every historical rebuild.
 */
export const DEFAULT_RETENTION = 2;

/** Discovered state of an alias name before a rebuild starts. */
export type AliasState =
  | { kind: "alias"; currentIndex: string }
  | { kind: "index" }
  | { kind: "absent" };

/**
 * Resolve what the given name currently refers to in the cluster. The result
 * drives both the `swapAlias` action set (the OpenSearch action shape differs
 * across the three cases) and the next-version-number computation.
 *
 * OpenSearch's `_alias/<name>` returns 404 when the name is neither an alias
 * nor a concrete index, AND when it is a concrete index but not an alias
 * target. We disambiguate by also asking `_cat/indices/<name>` -- which
 * returns the row if it's a concrete index, empty otherwise.
 */
export async function resolveAliasState(
  client: Client,
  name: string,
): Promise<AliasState> {
  const aliasResp = await client.indices.getAlias(
    { name },
    { ignore: [404] },
  );
  if (aliasResp.statusCode === 200) {
    // `body` is { [concreteIndex]: { aliases: { [name]: {} } } }. There is
    // exactly one concrete index per alias in this codebase (we never set up
    // multi-target aliases for search); take the first key.
    const concreteIndex = Object.keys(aliasResp.body)[0];
    if (concreteIndex !== undefined) {
      return { kind: "alias", currentIndex: concreteIndex };
    }
  }

  // Not an alias. Is it a concrete index?
  const exists = await client.indices.exists({ index: name });
  if (exists.body) {
    return { kind: "index" };
  }
  return { kind: "absent" };
}

/**
 * Compute the next concrete-index name. Versioning convention is
 * `${alias}-v${N}` with N starting at 1.
 *
 * - From the `alias` state, parse the `-v{N}` suffix off the current target
 *   and bump N. If the current target has no `-v{N}` suffix (someone created
 *   an alias manually without following the convention), fall back to v1.
 * - From `index` or `absent`, the next name is always `${alias}-v1` (we're
 *   bootstrapping the versioning).
 */
export function nextVersionName(alias: string, state: AliasState): string {
  if (state.kind !== "alias") return `${alias}-v1`;
  const match = state.currentIndex.match(/^(.*)-v(\d+)$/);
  if (match === null) return `${alias}-v1`;
  const base = match[1];
  const n = Number(match[2]);
  if (base !== alias || !Number.isInteger(n) || n < 1) return `${alias}-v1`;
  return `${alias}-v${n + 1}`;
}

/**
 * Atomically repoint the alias at `newIndex`. The action shape depends on
 * the prior state:
 *
 * - `alias`: remove the alias from the old concrete index, add it to the new
 *   one. Standard rolling-swap. (We do NOT delete the old concrete index in
 *   this call -- `pruneOldVersions` handles deletion based on the retention
 *   policy, which lets us keep the just-previous version for rollback.)
 * - `index`: the bootstrap migration. The bare name is currently a concrete
 *   index; we use `remove_index` (delete the old concrete index) and `add`
 *   (create the alias pointing at the new version) in one atomic body. Single
 *   round-trip; sub-second downtime window for the bootstrap migration only.
 * - `absent`: fresh deploy. Just add the alias.
 */
export async function swapAlias(
  client: Client,
  alias: string,
  newIndex: string,
  state: AliasState,
): Promise<void> {
  const actions: Record<string, unknown>[] = [];
  if (state.kind === "alias") {
    actions.push({ remove: { index: state.currentIndex, alias } });
    actions.push({ add: { index: newIndex, alias } });
  } else if (state.kind === "index") {
    actions.push({ remove_index: { index: alias } });
    actions.push({ add: { index: newIndex, alias } });
  } else {
    actions.push({ add: { index: newIndex, alias } });
  }
  await client.indices.updateAliases({ body: { actions } });
}

/**
 * Delete versioned indices older than the retention threshold. Lists indices
 * matching `${alias}-v*`, parses the version numbers, sorts descending, and
 * deletes everything past index `retain - 1`.
 *
 * Called after `swapAlias` succeeds; deletion failures are surfaced but do
 * not roll back the swap (the alias is already pointing at the new version,
 * which is the user-visible outcome we want).
 *
 * Race window: a scroll cursor opened against the alias *before* swapAlias
 * resolves to the old concrete index (scroll cursors are index-specific in
 * OpenSearch, not alias-resolved). If that scroll is still in flight when
 * `pruneOldVersions` deletes the old concrete index, the scroll's next
 * fetch errors with `index_not_found_exception`. In practice the window is
 * sub-second (swap and prune are sequential within `rebuildAliasedIndex`,
 * and scrolls are typically completed in milliseconds), but for very
 * long-running scrolls -- e.g. an export task -- consider running the
 * rebuild during a known-idle period.
 */
export async function pruneOldVersions(
  client: Client,
  alias: string,
  retain: number = DEFAULT_RETENTION,
): Promise<{ deleted: string[] }> {
  if (retain < 1) {
    throw new Error(`pruneOldVersions: retain must be >= 1, got ${retain}`);
  }
  const resp = await client.cat.indices({
    index: [`${alias}-v*`],
    format: "json",
    h: ["index"],
  });
  // `body` is an array of { index: "scholars-people-v3" } objects.
  const all = (resp.body as Array<{ index: string }>)
    .map((r) => r.index)
    .filter((n): n is string => typeof n === "string")
    .map((n) => {
      const m = n.match(/^(.*)-v(\d+)$/);
      if (m === null || m[1] !== alias) return null;
      return { name: n, version: Number(m[2]) };
    })
    .filter((x): x is { name: string; version: number } => x !== null)
    .sort((a, b) => b.version - a.version);

  const toDelete = all.slice(retain).map((x) => x.name);
  for (const name of toDelete) {
    await client.indices.delete({ index: name });
  }
  return { deleted: toDelete };
}

/**
 * Orchestrates a full rebuild against an aliased index: create the new
 * version, fill it via the caller's `fillFn`, atomically swap the alias,
 * prune old versions. Returns the new concrete index name and the document
 * count the `fillFn` reported -- both useful in the orchestrator log.
 *
 * Failure modes:
 *
 * - `indices.create` throws -> the new concrete index does not exist;
 *   alias is unaffected; safe to re-run after fixing the cause.
 * - `fillFn` throws -> the new concrete index exists with partial data.
 *   We delete it before re-throwing, so the alias is unaffected and the
 *   *next* invocation can re-compute the same `nextVersionName` without
 *   colliding with an orphan. (Skipping this cleanup would break every
 *   subsequent rebuild: `indices.create` on the same v{N+1} would
 *   resource-already-exists.)
 * - `swapAlias` throws -> same handling. The new index is fully written
 *   but unreferenced; we delete it and re-throw so the next attempt
 *   starts clean.
 * - `pruneOldVersions` throws -> the swap already succeeded; reads now
 *   land on the new version. Re-throw so the caller's log shows the
 *   error, but don't roll back -- the user-visible state is what we
 *   wanted. Operator cleans up the stragglers manually
 *   (`docs/search.md § Rollback` has the recipe).
 */
export async function rebuildAliasedIndex<T extends number = number>(args: {
  client: Client;
  alias: string;
  mapping: object;
  fillFn: (concreteIndex: string) => Promise<T>;
  retain?: number;
}): Promise<{ docsIndexed: T; newIndex: string; deleted: string[] }> {
  const { client, alias, mapping, fillFn, retain = DEFAULT_RETENTION } = args;
  const state = await resolveAliasState(client, alias);
  const newIndex = nextVersionName(alias, state);
  await client.indices.create({ index: newIndex, body: mapping });

  // Guard the fill + swap as a single atomic unit from the alias's point of
  // view: if either step throws, the new concrete index gets deleted so the
  // alias stays pointing at the prior version and the next rebuild attempt
  // doesn't collide with an orphan. Cleanup failure is swallowed (preferring
  // to surface the original error) but logged for the operator.
  let docsIndexed: T;
  try {
    docsIndexed = await fillFn(newIndex);
    await swapAlias(client, alias, newIndex, state);
  } catch (err) {
    try {
      await client.indices.delete({ index: newIndex });
    } catch (cleanupErr) {
      console.error(
        `[alias-swap] rebuild of ${alias} failed AND orphan cleanup of ${newIndex} failed; ` +
          `delete manually before next rebuild. cleanup error:`,
        cleanupErr,
      );
    }
    throw err;
  }

  const { deleted } = await pruneOldVersions(client, alias, retain);
  return { docsIndexed, newIndex, deleted };
}
