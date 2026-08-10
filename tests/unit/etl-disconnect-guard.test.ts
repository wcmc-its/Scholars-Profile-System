/**
 * Guardrail — an ETL entrypoint must close every Prisma pool it opens.
 *
 * `lib/db.ts` hands out three names for two pools: `db.write`, `db.read`, and
 * the deprecated `prisma` alias (which IS `db.read`). When DATABASE_URL_RO is
 * unset the reader collapses onto the writer and any single `$disconnect()`
 * closes the one pool. When DATABASE_URL_RO IS set — the posture both
 * `sps-etl-staging` and `sps-etl-prod` moved to on 2026-07-08 — they are two
 * PrismaClients with two mariadb pools. Closing one leaves the other's sockets
 * open, which keeps the node event loop alive: main() resolves, the process
 * never exits, and the Step Function's `.sync` ECS task burns its full 14400s
 * timeout, three times, before giving up.
 *
 * That is not hypothetical. On the 2026-07-09 nightly:
 *   - `etl:coi-gap`      did ~20 min of work, then stalled 12h (3 x 4h timeout).
 *                        It closed `db.write` but read through `lib/coi-gap/compute.ts`
 *                        (`db.read`).
 *   - `etl:search-index` finished indexing, then stalled. It closed `prisma`
 *                        (the reader) but `withEtlRun` had opened `db.write`.
 *
 * Note the two failures are mirror images — one leaked the reader, the other the
 * writer. The sanctioned close is `disconnect()` from `lib/db`, which closes
 * every distinct client and is a no-op on a pool that was never opened.
 *
 * This test walks each ETL entrypoint's import graph and fails when a pool it
 * touches is not closed. Entrypoints that never disconnect at all are
 * `process.exit()`-style: the pools die with the process, so they are exempt.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
/**
 * Every pattern below matches plain source text, so a comment that merely
 * MENTIONS a pool reads as a real use. `etl/family-suppression/index.ts` has a
 * doc comment explaining why it does NOT query `db.read`, which is enough to
 * convict it. Strip block comments and whole-line `//` before matching; a
 * trailing `//` is left alone so `https://` inside a string literal survives.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const cache = new Map<string, string>();
const read = (f: string) => {
  if (!cache.has(f)) cache.set(f, stripComments(readFileSync(f, "utf8")));
  return cache.get(f)!;
};

/** Resolve an import specifier to a repo file, mirroring tsconfig `@/* -> ./*`. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // bare package import — not our source
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Every repo module reachable from `entry`, including `entry`. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of read(f).matchAll(/from\s+["']([^"']+)["']/g)) {
      const r = resolveSpec(m[1], f);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return [...seen];
}

/**
 * Static `import { X } from ".../lib/db"` OR the dynamic
 * `const { X } = await import(".../lib/db")` form. Matching only the static one
 * left a hole: a file that closes its pools via a lazy import scored "closes
 * nothing" and was exempted outright, so the guard could not regress-proof it.
 */
const importsFromDb = (src: string, name: string) => {
  const named = `\\{[^}]*\\b${name}\\b[^}]*\\}`;
  return new RegExp(
    `(?:import\\s*${named}\\s*from|${named}\\s*=\\s*await\\s+import\\s*\\()\\s*["'][^"']*lib/db["']`,
  ).test(src);
};

/**
 * Importing `disconnect` is not closing anything — the call has to be there too.
 *
 * Reverting `await disconnect()` to `db.write.$disconnect()` while LEAVING the
 * import in place used to satisfy this guard, `npm run typecheck` and `npm run
 * lint` (the now-unused import is not even warned on) — putting the 12h-stall
 * shape documented above one line away from returning with every gate green
 * (#2291). Drop the import that introduces the name, and any surviving mention
 * is a real use: a call, or a bare reference like `.finally(disconnect)`.
 *
 * ponytail: token-presence, not a call-graph. A file that imports `disconnect`
 * and only mentions it in a string would read as closing. Nothing in the repo
 * does that; upgrade to an AST walk if one ever appears.
 */
const callsHelper = (src: string) => {
  const withoutImport = src
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*lib\/db["']/g, "")
    .replace(/\{[^}]*\}\s*=\s*await\s+import\s*\(\s*["'][^"']*lib\/db["']\s*\)/g, "");
  return /(?<!\$)\bdisconnect\b/.test(withoutImport);
};

/**
 * Does this module reach the reader pool (either alias)?
 *
 * Matches bare `db.read`, not just `db.read.` — a client is just as opened when
 * it is PASSED somewhere as when a method is called on it. `2026-06-10-import-
 * unit-curation.ts` does `runAuditQueryC(db.read)`, which a trailing-dot pattern
 * misses entirely, and that file leaked the reader in exactly that shape.
 */
const touchesReader = (f: string) => {
  const s = read(f);
  return /\bdb\.read\b/.test(s) || (importsFromDb(s, "prisma") && /\bprisma\.\w/.test(s));
};
const touchesWriter = (f: string) => /\bdb\.write\b/.test(read(f));

/**
 * Every .ts under etl/ and scripts/, not just `etl/<dir>/index.ts` (#2009).
 * The narrow glob covered exactly the nightly/weekly chains — the watched ones.
 * It could not see `etl/honors/import-honors-seed.ts`, which leaked the reader
 * and left six sps-etl-prod tasks RUNNING for hours on 2026-07-27, nor the
 * operator-run one-offs under scripts/backfills/. Non-entrypoints need no
 * filtering here: a library disconnects nothing, so the `disconnectsAnything`
 * early-return below already exempts it.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : walk(p);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [p] : [];
  });

const entrypoints = [path.join(ROOT, "etl"), path.join(ROOT, "scripts")]
  .filter(existsSync)
  .flatMap(walk)
  .sort();

describe("ETL entrypoints close every pool they open", () => {
  it("finds the ETL entrypoints", () => {
    expect(entrypoints.length).toBeGreaterThan(10);
  });

  it.each(entrypoints.map((e) => [path.relative(ROOT, e), e] as const))("%s", (rel, entry) => {
    const src = read(entry);
    // `disconnect()` closes both pools; the `$disconnect` forms close exactly one.
    // Both the import AND the call are required — see `callsHelper` (#2291).
    const usesHelper = importsFromDb(src, "disconnect") && callsHelper(src);
    const disconnectsAnything = usesHelper || /\$disconnect/.test(src);
    if (!disconnectsAnything) return; // process.exit() style — pools die with the process

    const closesReader =
      usesHelper || /db\.read\.\$disconnect/.test(src) || /\bprisma\.\$disconnect/.test(src);
    const closesWriter = usesHelper || /db\.write\.\$disconnect/.test(src);

    // lib/db.ts DEFINES the clients — its own `new Set([db.write, db.read])`
    // inside disconnect() is not a consumer touching a pool, and it sits in
    // every graph, so leaving it in makes all 188 entrypoints look guilty.
    const graph = moduleGraph(entry).filter((f) => f !== path.join(ROOT, "lib", "db.ts"));
    const leaks: string[] = [];
    if (graph.some(touchesReader) && !closesReader) leaks.push("reader (db.read / prisma)");
    if (graph.some(touchesWriter) && !closesWriter) leaks.push("writer (db.write)");

    expect(
      leaks,
      `${rel} queries the ${leaks.join(" and ")} pool (directly or via an import) but never ` +
        `closes it. With DATABASE_URL_RO set, the open pool keeps the event loop alive and the ` +
        `process hangs after main() resolves. Fix: ` +
        `import { disconnect } from "../../lib/db"  →  .finally(disconnect). ` +
        `Importing it is not enough — this guard requires the CALL (#2291).`,
    ).toEqual([]);
  });
});
