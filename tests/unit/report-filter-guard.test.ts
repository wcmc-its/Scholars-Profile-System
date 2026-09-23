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
 * Third check: no scanned file writes its OWN who-filter — a who-column in a
 * filter position (`role_category IN (`, `dept_code IN (` …, or Prisma
 * `roleCategory: { in` …). The legitimate hits (a report scoping to its own
 * unit, the viewer-scope clause) are listed in `WHO_FILTER_ALLOWLIST` with the
 * exact hit count and a one-line reason; a new file, or a new hit in a listed
 * one, fails.
 *
 * Then the mechanically checkable items of the "Adding a report" checklist
 * (`lib/edit/report-registry.ts` header): an export built on `parsePersonFilter`
 * states its who-filter via `personFilterCriteria`; a `"use client"` file under
 * `components/edit` never value-imports `@/lib/db`, `@/lib/edit/person-filter`
 * or the generated Prisma client, directly or one hop away; an export that
 * emits an `email` column references `SCHOLAR_EXPORT_CAP`.
 *
 * ponytail: text-level only. It sees literal-string reads, not a key built at
 * runtime (`sp.get(k)` with k = "unit") or a read via a helper outside the
 * scanned globs; the route/body check matches parser NAMES and import paths,
 * not that both feed the same query; the who-column check sees `IN` lists only
 * (not `=` / `ANY`, not a column name built at runtime); the import checks
 * follow ONE hop (a client file → module → module → `@/lib/db` passes; the
 * Next build is the real gate there); the email check sees an `"email"` /
 * `"Email"` string literal in the route or a module it imports, not a header
 * assembled at runtime, and "capped" means that reach imports (or defines)
 * `SCHOLAR_EXPORT_CAP`, not that the cap gates this very column. Good enough to catch the copy-paste way this drifts;
 * not a proof.
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

/** Every server module under `lib/edit` and `lib/api` (any depth, any name), so
 *  a new report module is scanned wherever it lands and whatever it is called —
 *  not only files named `*report*`. Non-report hits are allowlisted below. */
const TS = (f: string) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f);
const SCANNED = [
  ...walk("lib/edit", TS),
  ...walk("lib/api", TS),
  ...walk("components/edit/reports", (f) => path.dirname(f) === "components/edit/reports" && f.endsWith(".tsx")),
  ...walk("app/api/edit/reports", (f) => f.endsWith("/route.ts")),
  ...walk("app/edit", (f) => f.endsWith("/page.tsx") || f.endsWith("/route.ts")),
].filter((f) => !ALLOWLIST.has(f));

const RESERVED_READ = /\b(?:getAll|get|valuesOf)\(\s*["'`](?:type|unit)["'`]\s*\)/;

describe("report filter guard — reserved person-filter params", () => {
  it("scans a non-trivial file set", () => {
    expect(SCANNED).toContain("lib/edit/article-count-report.ts");
    expect(SCANNED).toContain("components/edit/reports/article-count-body.tsx");
    expect(SCANNED).toContain("app/api/edit/reports/article-count/route.ts");
    expect(SCANNED.filter((f) => f.startsWith("app/edit/")).length).toBeGreaterThan(5);
    // Scanned by location, not by name: the non-`*report*` modules are in.
    expect(SCANNED).toContain("lib/edit/orcid-coverage.ts");
    expect(SCANNED).toContain("lib/api/data-quality.ts");
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

// ---------------------------------------------------------------------------
// Who-columns in a filter position (#8).
// ---------------------------------------------------------------------------

const WHO_FILTER =
  /\b(?:role_category|dept_code|div_code|primary_org_code|center_code)\s+IN\s*\(|\b(?:roleCategory|deptCode|divCode|primaryOrgCode|centerCode)\s*:\s*\{\s*in\b/;

/** File → exact number of who-filter lines it may have, and why. A changed
 *  count fails too: re-read the new hit, then update the number. */
const WHO_FILTER_ALLOWLIST: Record<string, { hits: number; reason: string }> = {
  "lib/api/data-quality.ts": {
    hits: 4,
    reason: "viewer SCOPE clause (granted dept/div/institution codes) + the one center-membership read that resolves both scope and personFilterWhere's selected centers",
  },
  "lib/edit/cancer-center-reports.ts": {
    hits: 5,
    reason: "reports 1–6 index/liveness: per-unit program, collab, funding and active-member reads keyed on the report's OWN units, not a person filter",
  },
  // Not reports — scanned because every lib/edit + lib/api module is.
  "lib/edit/administrators.ts": {
    hits: 1,
    reason: "dept→division cascade: expands the admin's OWNED departments to their divisions, not a person filter",
  },
  "lib/edit/data-quality.ts": {
    hits: 1,
    reason: "dept→division cascade: expands the viewer's MANAGED departments into their scope, not a person filter",
  },
  "lib/api/browse.ts": {
    hits: 1,
    reason: "public browse tree: loads the divisions of the listed departments, not a person filter",
  },
  "lib/api/center-member-count.ts": {
    hits: 1,
    reason: "public center member counts: memberships of the requested centers, not a person filter",
  },
  "lib/api/centers.ts": {
    hits: 1,
    reason: "public center page role chip: members of the center narrowed to the chip's role group",
  },
  "lib/api/unit-members.ts": {
    hits: 6,
    reason: "public unit page role chip (#2537): the unit's members narrowed to the chip's role group (3 code + 3 docblock/comment lines)",
  },
  "lib/api/match-researchers.ts": {
    hits: 2,
    reason: "public ranking eligibility: fixed TOP_SCHOLARS_ELIGIBLE_ROLES carve, not a user-selected filter",
  },
  "lib/api/matcha.ts": {
    hits: 1,
    reason: "public ranking eligibility: fixed TOP_SCHOLARS_ELIGIBLE_ROLES carve, not a user-selected filter",
  },
  "lib/api/methods.ts": {
    hits: 2,
    reason: "public ranking eligibility: fixed TOP_SCHOLARS_ELIGIBLE_ROLES carve, not a user-selected filter",
  },
  "lib/api/topics.ts": {
    hits: 4,
    reason: "public ranking eligibility: fixed TOP_SCHOLARS / SEARCH_BOOST eligible-role carves, not a user-selected filter",
  },
};

describe("report filter guard — no hand-written who-filter", () => {
  const hitsIn = (f: string) =>
    readFileSync(path.join(ROOT, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (WHO_FILTER.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []));

  it("no scanned file filters on a who-column outside the allowlist — use personFilterSql / personFilterWhere", () => {
    const offenders = SCANNED.flatMap((f) => {
      const hits = hitsIn(f);
      const allowed = WHO_FILTER_ALLOWLIST[f];
      if (hits.length === 0 || allowed?.hits === hits.length) return [];
      return [`${f}: ${hits.length} who-filter line(s)${allowed ? `, allowlisted for ${allowed.hits}` : ""}\n  ${hits.join("\n  ")}`];
    });
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry is scanned, still has hits, and has a reason", () => {
    for (const [f, { hits, reason }] of Object.entries(WHO_FILTER_ALLOWLIST)) {
      expect(SCANNED, `${f} is not in the scanned set — stale entry`).toContain(f);
      expect(hitsIn(f).length, `${f}: stale count`).toBe(hits);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// Checklist enforcement (#9): imports, criteria, the email cap.
// ---------------------------------------------------------------------------

type Import = { spec: string; typeOnly: boolean; names: string[] };

/** `import … from "x"` / `export … from "x"` clauses (no side-effect imports). */
function importsOf(src: string): Import[] {
  const out: Import[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;"'`]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[2];
    const braces = /\{([^}]*)\}/.exec(clause);
    const specifiers = braces ? braces[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
    const hasDefault = /^[\w$]+\s*(?:,|$)/.test(clause.trim()) || /^\*\s+as\b/.test(clause.trim());
    const typeOnly =
      Boolean(m[1]) || (!hasDefault && specifiers.length > 0 && specifiers.every((x) => x.startsWith("type ")));
    out.push({ spec: m[3], typeOnly, names: specifiers.map((x) => x.replace(/^type\s+/, "").split(/\s+as\s+/)[0]) });
  }
  return out;
}

/** A local import specifier → repo-relative file, or null (a package). */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? spec.slice(2)
    : spec.startsWith(".")
      ? path.join(path.dirname(fromFile), spec)
      : null;
  if (base === null) return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const rel = base + ext;
    if (existsSync(path.join(ROOT, rel)) && statSync(path.join(ROOT, rel)).isFile()) return rel;
  }
  return null;
}

const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

const EXPORT_ROUTES = [
  ...walk("app/api/edit/reports", (f) => f.endsWith("/route.ts")),
  ...walk("app", (f) => f.endsWith("/route.ts") && f.split("/").includes("export")),
];

describe("report checklist — an export built on parsePersonFilter states its who-filter", () => {
  /** Profiles / COI roster CSVs predate the criteria rule: a per-person table
   *  with no criteria block yet. Remove an entry when its export gains one. */
  const CRITERIA_ALLOWLIST = new Set([
    "app/edit/scholars/export/route.ts", // Profiles roster CSV — table only, no criteria block yet
    "app/edit/coi/export/route.ts", // COI roster CSV — table only, no criteria block yet
  ]);

  /** The modules this route takes a `parse…Params` from (one hop). */
  const parserModules = (route: string) =>
    importsOf(read(route))
      .filter((i) => !i.typeOnly && i.names.some((n) => /^parse\w*Params$/.test(n)))
      .map((i) => resolveLocal(route, i.spec))
      .filter((f): f is string => f !== null);

  const personFilterRoutes = EXPORT_ROUTES.filter(
    (r) => /\bparsePersonFilter\(/.test(read(r)) || parserModules(r).some((m) => /\bparsePersonFilter\(/.test(read(m))),
  );

  it("finds the person-filter exports", () => {
    expect(personFilterRoutes).toEqual(
      expect.arrayContaining(["app/api/edit/reports/article-count/route.ts", "app/edit/orcid-coverage/export/route.ts"]),
    );
  });

  it("each calls personFilterCriteria (in the route or the parser's module)", () => {
    const missing = personFilterRoutes.filter(
      (r) =>
        !CRITERIA_ALLOWLIST.has(r) &&
        ![r, ...parserModules(r)].some((f) => /\bpersonFilterCriteria\(/.test(read(f))),
    );
    expect(missing).toEqual([]);
    for (const r of CRITERIA_ALLOWLIST) expect(personFilterRoutes, `stale allowlist entry ${r}`).toContain(r);
  });
});

describe("report checklist — no server-only module in a \"use client\" file", () => {
  const FORBIDDEN = ["@/lib/db", "@/lib/edit/person-filter", "@/lib/generated/prisma/client"];
  const forbiddenValueImports = (f: string) =>
    importsOf(read(f)).filter((i) => !i.typeOnly && FORBIDDEN.includes(i.spec)).map((i) => i.spec);

  const clientFiles = walk("components/edit", (f) => /\.tsx?$/.test(f)).filter((f) =>
    /^\s*["']use client["']/m.test(read(f).split("\n").slice(0, 20).join("\n")),
  );

  it("finds the client islands", () => {
    expect(clientFiles).toContain("components/edit/reports/article-count-facets.tsx");
  });

  it("direct: no value import of @/lib/db, person-filter or the Prisma client", () => {
    expect(clientFiles.flatMap((f) => forbiddenValueImports(f).map((spec) => `${f} → ${spec}`))).toEqual([]);
  });

  it("one hop: no value-imported local module value-imports them either", () => {
    const offenders = clientFiles.flatMap((f) =>
      importsOf(read(f))
        .filter((i) => !i.typeOnly)
        .flatMap((i) => {
          const mod = resolveLocal(f, i.spec);
          return mod ? forbiddenValueImports(mod).map((spec) => `${f} → ${mod} → ${spec}`) : [];
        }),
    );
    expect(offenders).toEqual([]);
  });
});

describe("report checklist — an export with an email column is capped", () => {
  /** Exports that emit email by an explicit, documented decision other than the cap. */
  const EMAIL_ALLOWLIST: Record<string, string> = {
    "app/edit/center/[code]/export/route.ts":
      "#1102 per-unit roster an admin already edits; #847 no-email superseded for this surface (lib/edit/unit-roster-export.ts header)",
    "app/edit/department/[code]/export/route.ts": "#1102 per-unit faculty roster, same decision (lib/edit/unit-faculty-export.ts)",
    "app/edit/division/[code]/export/route.ts": "#1102 per-unit faculty roster, same decision (lib/edit/unit-faculty-export.ts)",
  };
  const EMAIL_HEADER = /["']e-?mail["']/i;
  /** Imports the cap (or is its home) — a comment naming it does not count. */
  const usesCap = (f: string) =>
    /\bexport const SCHOLAR_EXPORT_CAP\b/.test(read(f)) ||
    importsOf(read(f)).some((i) => !i.typeOnly && i.names.includes("SCHOLAR_EXPORT_CAP"));

  /** The route plus the local modules it value-imports (one hop). */
  const reach = (route: string) => [
    route,
    ...importsOf(read(route))
      .filter((i) => !i.typeOnly)
      .map((i) => resolveLocal(route, i.spec))
      .filter((f): f is string => f !== null),
  ];

  const emailRoutes = EXPORT_ROUTES.filter((r) => reach(r).some((f) => EMAIL_HEADER.test(read(f))));

  it("finds the email-emitting exports", () => {
    expect(emailRoutes).toContain("app/api/export/scholars/[scope]/route.ts");
  });

  it("each imports SCHOLAR_EXPORT_CAP (route or a module it imports)", () => {
    const missing = emailRoutes.filter((r) => !(r in EMAIL_ALLOWLIST) && !reach(r).some(usesCap));
    expect(missing).toEqual([]);
    for (const r of Object.keys(EMAIL_ALLOWLIST)) expect(emailRoutes, `stale allowlist entry ${r}`).toContain(r);
  });
});
