/**
 * Guardrail — report "who" filters go through ONE parser.
 *
 * `type` / `unit` are reserved (`PERSON_FILTER_PARAMS`, `lib/edit/person-filter.ts`).
 * A report, report route, report body or /edit page that reads them itself
 * (`sp.getAll("unit")`, `sp.get("type")`, `valuesOf("unit")`) would grow a
 * third copy of the rule report 8 and the Profiles roster now share — so any
 * such read in the scanned files fails here; use `parsePersonFilter`.
 *
 * Second check: every `app/api/edit/reports/<slug>/route.ts` (the download)
 * parses its query string with the same `parse…Params` function its page body
 * (`components/edit/reports/<slug>-body.tsx`) calls, imported from the same
 * module — page and export share one parser.
 *
 * ponytail: text-level only. It sees literal-string reads, not a key built at
 * runtime (`sp.get(k)` with k = "unit") or a read via a helper outside the
 * scanned globs; and the route/body check matches parser NAMES and import
 * paths, not that both feed the same query. Good enough to catch the copy-paste
 * way this drifts; not a proof.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel, keep) : keep(rel) ? [rel] : [];
  });
}

const ALLOWLIST = new Set(["lib/edit/person-filter.ts"]);

const SCANNED = [
  ...walk("lib/edit", (f) => path.dirname(f) === "lib/edit" && /report[^/]*\.ts$/.test(f)),
  ...walk("components/edit/reports", (f) => path.dirname(f) === "components/edit/reports" && f.endsWith(".tsx")),
  ...walk("app/api/edit/reports", (f) => f.endsWith("/route.ts")),
  ...walk("app/edit", (f) => f.endsWith("/page.tsx") || f.endsWith("/route.ts")),
  "lib/edit/orcid-coverage.ts",
  "lib/api/data-quality.ts",
].filter((f) => !ALLOWLIST.has(f));

const RESERVED_READ = /\b(?:getAll|get|valuesOf)\(\s*["'`](?:type|unit)["'`]\s*\)/;

describe("report filter guard — reserved person-filter params", () => {
  it("scans a non-trivial file set", () => {
    expect(SCANNED).toContain("lib/edit/article-count-report.ts");
    expect(SCANNED).toContain("components/edit/reports/article-count-body.tsx");
    expect(SCANNED).toContain("app/api/edit/reports/article-count/route.ts");
    expect(SCANNED.filter((f) => f.startsWith("app/edit/")).length).toBeGreaterThan(5);
  });

  it("no scanned file reads `type` / `unit` directly — use parsePersonFilter", () => {
    const offenders = SCANNED.flatMap((f) =>
      readFileSync(path.join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((line, i) => (RESERVED_READ.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  it("report 8 takes its who-filter from @/lib/edit/person-filter", () => {
    const src = readFileSync(path.join(ROOT, "lib/edit/article-count-report.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bparsePersonFilter\b[^}]*\} from "@\/lib\/edit\/person-filter"/);
    expect(src).toMatch(/\bpersonFilterSql\(/);
  });
});

describe("report filter guard — download route and page body share one parser", () => {
  const routes = walk("app/api/edit/reports", (f) => /^app\/api\/edit\/reports\/[^/]+\/route\.ts$/.test(f));

  /** `parseXParams` names this file calls, each with the module it imports from. */
  function parsers(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of src.matchAll(/import \{([^}]*)\} from "([^"]+)"/g)) {
      for (const name of m[1].split(",").map((s) => s.replace(/^type\s+/, "").trim())) {
        if (/^parse\w*Params$/.test(name) && new RegExp(`\\b${name}\\(`).test(src)) out.set(name, m[2]);
      }
    }
    return out;
  }

  it("finds the report routes", () => {
    expect(routes).toContain("app/api/edit/reports/article-count/route.ts");
  });

  it.each(routes)("%s", (route) => {
    const slug = route.split("/")[4];
    const body = `components/edit/reports/${slug}-body.tsx`;
    expect(existsSync(path.join(ROOT, body)), `${route} has no page body at ${body}`).toBe(true);
    const routeParsers = parsers(readFileSync(path.join(ROOT, route), "utf8"));
    const bodyParsers = parsers(readFileSync(path.join(ROOT, body), "utf8"));
    expect(routeParsers.size, `${route} calls no parse…Params`).toBeGreaterThan(0);
    for (const [name, from] of routeParsers) expect(bodyParsers.get(name), `${body} must call ${name} from ${from}`).toBe(from);
  });
});
