/**
 * Unit tests for the alias-swap mechanism (B18, #117).
 *
 * Uses a hand-rolled mock client rather than spinning up a docker OpenSearch
 * because every code path here is determined by the action body the module
 * sends to OpenSearch, not by what OpenSearch does in response. The mock
 * captures the calls and returns canned responses keyed by call kind.
 */
import { describe, expect, it } from "vitest";
import {
  cleanStaleNextVersion,
  DEFAULT_RETENTION,
  nextVersionName,
  pruneOldVersions,
  rebuildAliasedIndex,
  resolveAliasState,
  swapAlias,
  type AliasState,
} from "@/etl/search-index/alias-swap";

type Call = { method: string; args: unknown };

interface MockClientOpts {
  /** Response for indices.getAlias({ name }). statusCode 200 => alias; 404 => no alias. */
  getAlias?: { statusCode: number; body: Record<string, unknown> };
  /** Response for indices.exists({ index }). */
  exists?: boolean;
  /** Response for cat.indices({ index, format: "json", h: "index" }). */
  catIndices?: Array<{ index: string }>;
}

function makeMockClient(opts: MockClientOpts = {}) {
  const calls: Call[] = [];
  const client = {
    indices: {
      getAlias: async (args: unknown) => {
        calls.push({ method: "indices.getAlias", args });
        return (
          opts.getAlias ?? { statusCode: 404, body: {} }
        );
      },
      exists: async (args: unknown) => {
        calls.push({ method: "indices.exists", args });
        return { body: opts.exists ?? false };
      },
      create: async (args: unknown) => {
        calls.push({ method: "indices.create", args });
        return { body: { acknowledged: true } };
      },
      delete: async (args: unknown) => {
        calls.push({ method: "indices.delete", args });
        return { body: { acknowledged: true } };
      },
      updateAliases: async (args: unknown) => {
        calls.push({ method: "indices.updateAliases", args });
        return { body: { acknowledged: true } };
      },
    },
    cat: {
      indices: async (args: unknown) => {
        calls.push({ method: "cat.indices", args });
        return { body: opts.catIndices ?? [] };
      },
    },
  };
  return { client, calls };
}

describe("nextVersionName", () => {
  it("returns vN+1 when the current target follows the convention", () => {
    expect(
      nextVersionName("scholars-people", {
        kind: "alias",
        currentIndex: "scholars-people-v3",
      }),
    ).toBe("scholars-people-v4");
  });

  it("returns v1 when there is no alias yet (kind=index, bootstrap)", () => {
    expect(nextVersionName("scholars-people", { kind: "index" })).toBe(
      "scholars-people-v1",
    );
  });

  it("returns v1 when there is no alias and no concrete index (kind=absent)", () => {
    expect(nextVersionName("scholars-people", { kind: "absent" })).toBe(
      "scholars-people-v1",
    );
  });

  it("falls back to v1 when the current target does not match the convention", () => {
    expect(
      nextVersionName("scholars-people", {
        kind: "alias",
        currentIndex: "some-legacy-name",
      }),
    ).toBe("scholars-people-v1");
  });

  it("does not confuse a different-alias version (prefix mismatch)", () => {
    expect(
      nextVersionName("scholars-people", {
        kind: "alias",
        currentIndex: "scholars-publications-v3",
      }),
    ).toBe("scholars-people-v1");
  });
});

describe("resolveAliasState", () => {
  it("returns kind=alias with the concrete target when the alias exists", async () => {
    const { client } = makeMockClient({
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v2": { aliases: { "scholars-people": {} } } },
      },
    });
    const state = await resolveAliasState(client as never, "scholars-people");
    expect(state).toEqual({
      kind: "alias",
      currentIndex: "scholars-people-v2",
    });
  });

  it("returns kind=index when the name is a concrete index (pre-B18 deployed state)", async () => {
    const { client } = makeMockClient({
      getAlias: { statusCode: 404, body: {} },
      exists: true,
    });
    const state = await resolveAliasState(client as never, "scholars-people");
    expect(state).toEqual({ kind: "index" });
  });

  it("returns kind=absent when the name is neither an alias nor an index", async () => {
    const { client } = makeMockClient({
      getAlias: { statusCode: 404, body: {} },
      exists: false,
    });
    const state = await resolveAliasState(client as never, "scholars-people");
    expect(state).toEqual({ kind: "absent" });
  });
});

describe("swapAlias", () => {
  it("from kind=alias: emits remove + add against the current target", async () => {
    const { client, calls } = makeMockClient();
    const state: AliasState = {
      kind: "alias",
      currentIndex: "scholars-people-v2",
    };
    await swapAlias(
      client as never,
      "scholars-people",
      "scholars-people-v3",
      state,
    );
    const update = calls.find((c) => c.method === "indices.updateAliases");
    expect(update?.args).toEqual({
      body: {
        actions: [
          {
            remove: {
              index: "scholars-people-v2",
              alias: "scholars-people",
            },
          },
          { add: { index: "scholars-people-v3", alias: "scholars-people" } },
        ],
      },
    });
  });

  it("from kind=index: emits remove_index + add (the bootstrap migration)", async () => {
    const { client, calls } = makeMockClient();
    await swapAlias(
      client as never,
      "scholars-people",
      "scholars-people-v1",
      { kind: "index" },
    );
    const update = calls.find((c) => c.method === "indices.updateAliases");
    expect(update?.args).toEqual({
      body: {
        actions: [
          { remove_index: { index: "scholars-people" } },
          { add: { index: "scholars-people-v1", alias: "scholars-people" } },
        ],
      },
    });
  });

  it("from kind=absent: emits add only", async () => {
    const { client, calls } = makeMockClient();
    await swapAlias(
      client as never,
      "scholars-people",
      "scholars-people-v1",
      { kind: "absent" },
    );
    const update = calls.find((c) => c.method === "indices.updateAliases");
    expect(update?.args).toEqual({
      body: {
        actions: [
          { add: { index: "scholars-people-v1", alias: "scholars-people" } },
        ],
      },
    });
  });
});

describe("pruneOldVersions", () => {
  it("with 5 existing versions and retain=2, deletes the 3 oldest", async () => {
    const { client, calls } = makeMockClient({
      catIndices: [
        { index: "scholars-people-v1" },
        { index: "scholars-people-v3" },
        { index: "scholars-people-v5" },
        { index: "scholars-people-v2" },
        { index: "scholars-people-v4" },
      ],
    });
    const { deleted } = await pruneOldVersions(
      client as never,
      "scholars-people",
      2,
    );
    expect(deleted.sort()).toEqual(
      ["scholars-people-v1", "scholars-people-v2", "scholars-people-v3"].sort(),
    );
    const deletes = calls
      .filter((c) => c.method === "indices.delete")
      .map((c) => (c.args as { index: string }).index)
      .sort();
    expect(deletes).toEqual(deleted.sort());
  });

  it("with one existing version and retain=2, deletes nothing", async () => {
    const { client, calls } = makeMockClient({
      catIndices: [{ index: "scholars-people-v1" }],
    });
    const { deleted } = await pruneOldVersions(
      client as never,
      "scholars-people",
      2,
    );
    expect(deleted).toEqual([]);
    expect(calls.find((c) => c.method === "indices.delete")).toBeUndefined();
  });

  it("ignores indices that don't match the alias prefix", async () => {
    const { client } = makeMockClient({
      catIndices: [
        { index: "scholars-people-v1" },
        { index: "scholars-people-v2" },
        // Wrong-shape entries should be skipped, not crash the prune.
        { index: "scholars-publications-v9" },
        { index: "scholars-people-legacy" },
      ],
    });
    const { deleted } = await pruneOldVersions(
      client as never,
      "scholars-people",
      2,
    );
    // Two well-formed versions, retain=2 -> no deletions.
    expect(deleted).toEqual([]);
  });

  it("rejects retain < 1 (which would delete everything including the live target)", async () => {
    const { client } = makeMockClient({
      catIndices: [{ index: "scholars-people-v1" }],
    });
    await expect(
      pruneOldVersions(client as never, "scholars-people", 0),
    ).rejects.toThrow(/retain must be >= 1/);
  });
});

describe("cleanStaleNextVersion (orphaned-index guard)", () => {
  it("is a no-op when the next-version index does not exist", async () => {
    const { client, calls } = makeMockClient({ exists: false });
    await cleanStaleNextVersion(
      client as never,
      "scholars-people",
      "scholars-people-v4",
    );
    // Common path: only the existence probe runs; no alias re-read, no delete.
    expect(calls.find((c) => c.method === "indices.delete")).toBeUndefined();
    expect(calls.find((c) => c.method === "indices.getAlias")).toBeUndefined();
  });

  it("deletes a genuine orphan when the alias points at a different version", async () => {
    const { client, calls } = makeMockClient({
      exists: true,
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v3": { aliases: { "scholars-people": {} } } },
      },
    });
    await cleanStaleNextVersion(
      client as never,
      "scholars-people",
      "scholars-people-v4",
    );
    const deletes = calls
      .filter((c) => c.method === "indices.delete")
      .map((c) => (c.args as { index: string }).index);
    expect(deletes).toEqual(["scholars-people-v4"]);
  });

  // Load-bearing regression test: a blind delete would NOT throw and WOULD
  // delete v4 -- which is the live alias target here, i.e. a search outage.
  it("aborts (throws) and does NOT delete when the stale index is the live alias target", async () => {
    const { client, calls } = makeMockClient({
      exists: true,
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v4": { aliases: { "scholars-people": {} } } },
      },
    });
    await expect(
      cleanStaleNextVersion(
        client as never,
        "scholars-people",
        "scholars-people-v4",
      ),
    ).rejects.toThrow(/current target|concurrent/i);
    expect(calls.find((c) => c.method === "indices.delete")).toBeUndefined();
  });
});

describe("rebuildAliasedIndex", () => {
  it("orchestrates create -> fill -> swap -> prune in order", async () => {
    const { client, calls } = makeMockClient({
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v2": { aliases: { "scholars-people": {} } } },
      },
      catIndices: [
        { index: "scholars-people-v1" },
        { index: "scholars-people-v2" },
        // v3 doesn't exist on disk yet at cat-time (the mock returns a
        // pre-recorded list; in real life create() runs before cat()), but
        // the test only cares about order-of-calls.
      ],
    });
    const fillCalls: string[] = [];
    const result = await rebuildAliasedIndex({
      client: client as never,
      alias: "scholars-people",
      mapping: { settings: {} },
      fillFn: async (concreteIndex) => {
        fillCalls.push(concreteIndex);
        return 42;
      },
    });

    expect(result.newIndex).toBe("scholars-people-v3");
    expect(result.docsIndexed).toBe(42);
    expect(fillCalls).toEqual(["scholars-people-v3"]);

    // Order of calls: getAlias -> create -> (fill runs -- doesn't touch the
    // client because fillFn is the caller's responsibility) -> updateAliases
    // -> cat.indices -> delete(s).
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf("indices.getAlias")).toBeLessThan(
      methods.indexOf("indices.create"),
    );
    expect(methods.indexOf("indices.create")).toBeLessThan(
      methods.indexOf("indices.updateAliases"),
    );
    expect(methods.indexOf("indices.updateAliases")).toBeLessThan(
      methods.indexOf("cat.indices"),
    );
  });

  it("uses DEFAULT_RETENTION when retain is unset", () => {
    expect(DEFAULT_RETENTION).toBe(2);
  });

  it("deletes the new concrete index when fillFn throws (no orphan)", async () => {
    const { client, calls } = makeMockClient({
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v2": { aliases: { "scholars-people": {} } } },
      },
    });
    const fillError = new Error("ETL exploded mid-bulk-write");
    await expect(
      rebuildAliasedIndex({
        client: client as never,
        alias: "scholars-people",
        mapping: { settings: {} },
        fillFn: async () => {
          throw fillError;
        },
      }),
    ).rejects.toBe(fillError);

    // The orphan-cleanup delete must have fired against the new concrete
    // index, so the next rebuild attempt can re-use the same version name
    // without colliding.
    const deletes = calls
      .filter((c) => c.method === "indices.delete")
      .map((c) => (c.args as { index: string }).index);
    expect(deletes).toContain("scholars-people-v3");
    // swapAlias must NOT have been called (the failure happened before it).
    expect(
      calls.find((c) => c.method === "indices.updateAliases"),
    ).toBeUndefined();
  });

  it("deletes the new concrete index when swapAlias throws (no orphan)", async () => {
    // Mock that throws on updateAliases. Reuse the standard helper for the
    // happy-path calls, then wrap with a swap-throwing override.
    const { client, calls } = makeMockClient({
      getAlias: {
        statusCode: 200,
        body: { "scholars-people-v2": { aliases: { "scholars-people": {} } } },
      },
    });
    const swapError = new Error("cluster-state update failed");
    const originalSwap = client.indices.updateAliases;
    client.indices.updateAliases = async (args: unknown) => {
      calls.push({ method: "indices.updateAliases", args });
      throw swapError;
    };
    // Reference original to avoid unused-variable lint.
    void originalSwap;

    await expect(
      rebuildAliasedIndex({
        client: client as never,
        alias: "scholars-people",
        mapping: { settings: {} },
        fillFn: async () => 7,
      }),
    ).rejects.toBe(swapError);

    const deletes = calls
      .filter((c) => c.method === "indices.delete")
      .map((c) => (c.args as { index: string }).index);
    expect(deletes).toContain("scholars-people-v3");
  });

  it("aborts before create() when the next-version index is already the live alias target", async () => {
    const { client, calls } = makeMockClient({ exists: true });
    // Top-of-rebuild reads alias -> v3 (so newIndex = v4); the guard's re-read
    // sees alias -> v4, i.e. a concurrent reindex swapped it in between the two
    // reads. A blind delete here would wipe the live target (search outage).
    const topRead = {
      statusCode: 200,
      body: { "scholars-people-v3": { aliases: { "scholars-people": {} } } },
    };
    const guardReread = {
      statusCode: 200,
      body: { "scholars-people-v4": { aliases: { "scholars-people": {} } } },
    };
    let seen = false;
    client.indices.getAlias = async (args: unknown) => {
      calls.push({ method: "indices.getAlias", args });
      const resp = seen ? guardReread : topRead;
      seen = true;
      return resp;
    };

    await expect(
      rebuildAliasedIndex({
        client: client as never,
        alias: "scholars-people",
        mapping: { settings: {} },
        fillFn: async () => 1,
      }),
    ).rejects.toThrow(/current target|concurrent/i);

    // Must NOT delete the live target, and must NOT have created (aborted first).
    const deletes = calls
      .filter((c) => c.method === "indices.delete")
      .map((c) => (c.args as { index: string }).index);
    expect(deletes).not.toContain("scholars-people-v4");
    expect(calls.find((c) => c.method === "indices.create")).toBeUndefined();
  });
});
