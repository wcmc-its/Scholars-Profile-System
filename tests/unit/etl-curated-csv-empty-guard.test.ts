/**
 * A curated CSV that is PRESENT but parses to zero rows must not be honoured.
 *
 * All three of these loaders reseed by replacing: `replaceRows([])` keeps no
 * seed key, so every `source='seed'` row is pruned as stale inside the
 * transaction; `replaceAliases([])` runs an unconditional `deleteMany({})` and
 * inserts nothing. Either way `main()` then records
 * `{ status: 'success', rowsProcessed: 0 }`.
 *
 * That combination is invisible to every detector we have. `evaluate()` in
 * etl/freshness/index.ts grades a source solely on the recency of its most
 * recent `status:'success'` row and NEVER reads `rowsProcessed`, so a run that
 * succeeded having wiped the overlay reads as perfectly FRESH. etl:integrity's
 * volume guard cannot see these three either (their row counts sit under the
 * minPreviousRows=100 floor). The pre-existing ENOENT guard closed only the
 * missing-file half of the hole; a header-only or truncated file walked
 * straight through it.
 *
 * Throwing instead makes the run FAIL, which is the state the freshness entry
 * for each source actually detects.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below can close over it. The spy stands in
// for the destructive write: if a loader reaches its $transaction with an
// empty row set, this fires and the test says so.
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      $transaction: transaction,
      $disconnect: vi.fn(),
      etlRun: { create: vi.fn() },
    },
    read: {},
  },
}));

type Loader = {
  readonly source: string;
  readonly envVar: string;
  /** A header line this loader's parser accepts and yields zero rows from. */
  readonly headerOnly: string;
  readonly load: () => Promise<{
    readCurated: () => unknown[];
    replaceRows?: (rows: never[]) => Promise<unknown>;
    replaceAliases?: (rows: never[]) => Promise<unknown>;
  }>;
  readonly refusal: RegExp;
};

const LOADERS: readonly Loader[] = [
  {
    source: "FamilySuppression",
    envVar: "FAMILY_SUPPRESSION_CURATED_PATH",
    headerOnly: "supercategory,family_label,source_note\n",
    load: () => import("@/etl/family-suppression"),
    refusal: /parsed to 0 rows.*refusing to wipe the overlay/,
  },
  {
    source: "FamilySensitivity",
    envVar: "FAMILY_SENSITIVITY_CURATED_PATH",
    headerOnly: "supercategory,family_label,source_note\n",
    load: () => import("@/etl/family-sensitivity"),
    refusal: /parsed to 0 rows.*refusing to wipe the overlay/,
  },
  {
    source: "MeshAlias",
    envVar: "MESH_ALIAS_CURATED_PATH",
    // parseAliasCsv validates the header, so an alias file's empty shape is
    // this exact line — and it returns [] from it, which is the whole point.
    headerOnly: "alias,descriptor_ui,source_note\n",
    load: () => import("@/etl/mesh-aliases"),
    refusal: /parsed to 0 rows.*refusing to wipe the alias table/,
  },
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sps-curated-"));
  transaction.mockReset();
  // Default behaviour: reaching the destructive call is itself the failure, so
  // make it loud rather than silently resolving.
  transaction.mockImplementation(async () => {
    throw new Error("destructive reseed ran");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Point the loader at `content` and re-import it so it re-reads the env var. */
async function loadPointedAt(loader: Loader, filename: string, content: string) {
  const path = join(dir, filename);
  writeFileSync(path, content, "utf-8");
  vi.stubEnv(loader.envVar, path);
  vi.resetModules();
  return loader.load();
}

describe.each(LOADERS)("$source curated CSV empty guard", (loader) => {
  it("refuses a header-only file instead of wiping, and never reaches the destructive write", async () => {
    const mod = await loadPointedAt(loader, "curated.csv", loader.headerOnly);
    expect(() => mod.readCurated()).toThrow(loader.refusal);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a fully empty (truncated) file", async () => {
    const mod = await loadPointedAt(loader, "curated.csv", "");
    expect(() => mod.readCurated()).toThrow(loader.refusal);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still returns rows for a populated file, so the guard is not a blanket refusal", async () => {
    const populated =
      loader.source === "MeshAlias"
        ? `${loader.headerOnly}Robotic surgery,D065287,note\n`
        : `${loader.headerOnly}computational_statistical,Regression modeling,note\n`;
    const mod = await loadPointedAt(loader, "curated.csv", populated);
    expect(mod.readCurated()).toHaveLength(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  // Non-vacuity for the two assertions above: prove the spy really is wired to
  // this loader's destructive call, so "not called" means the guard stopped it
  // rather than the mock never having been on the path at all.
  it("the destructive-write spy is on the reseed path (so `not.toHaveBeenCalled` means something)", async () => {
    const mod = await loadPointedAt(loader, "curated.csv", loader.headerOnly);
    const destructive = mod.replaceRows ?? mod.replaceAliases;
    expect(destructive).toBeDefined();
    await expect(destructive!([])).rejects.toThrow("destructive reseed ran");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
