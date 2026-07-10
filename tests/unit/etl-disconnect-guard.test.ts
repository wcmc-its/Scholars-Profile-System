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
const cache = new Map<string, string>();
const read = (f: string) => {
  if (!cache.has(f)) cache.set(f, readFileSync(f, "utf8"));
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

const importsFromDb = (src: string, name: string) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*lib/db["']`).test(src);

/** Does this module issue a query against the reader pool (either alias)? */
const touchesReader = (f: string) => {
  const s = read(f);
  return /\bdb\.read\./.test(s) || (importsFromDb(s, "prisma") && /\bprisma\.\w/.test(s));
};
const touchesWriter = (f: string) => /\bdb\.write\./.test(read(f));

const entrypoints = readdirSync(path.join(ROOT, "etl"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(ROOT, "etl", d.name, "index.ts"))
  .filter(existsSync);

describe("ETL entrypoints close every pool they open", () => {
  it("finds the ETL entrypoints", () => {
    expect(entrypoints.length).toBeGreaterThan(10);
  });

  it.each(entrypoints.map((e) => [path.relative(ROOT, e), e] as const))("%s", (rel, entry) => {
    const src = read(entry);
    // `disconnect()` closes both pools; the `$disconnect` forms close exactly one.
    const usesHelper = importsFromDb(src, "disconnect");
    const disconnectsAnything = usesHelper || /\$disconnect/.test(src);
    if (!disconnectsAnything) return; // process.exit() style — pools die with the process

    const closesReader =
      usesHelper || /db\.read\.\$disconnect/.test(src) || /\bprisma\.\$disconnect/.test(src);
    const closesWriter = usesHelper || /db\.write\.\$disconnect/.test(src);

    const graph = moduleGraph(entry);
    const leaks: string[] = [];
    if (graph.some(touchesReader) && !closesReader) leaks.push("reader (db.read / prisma)");
    if (graph.some(touchesWriter) && !closesWriter) leaks.push("writer (db.write)");

    expect(
      leaks,
      `${rel} queries the ${leaks.join(" and ")} pool (directly or via an import) but never ` +
        `closes it. With DATABASE_URL_RO set, the open pool keeps the event loop alive and the ` +
        `process hangs after main() resolves. Fix: ` +
        `import { disconnect } from "../../lib/db"  →  .finally(disconnect)`,
    ).toEqual([]);
  });
});
