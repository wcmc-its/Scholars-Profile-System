/**
 * Guard: the app never returns 502/503/504 on purpose (#2503).
 *
 * CloudFront's distribution-wide custom error responses replace the BODY of
 * every 502/503/504 with the branded origin-down page, including responses the
 * origin sends itself. A route that answers `editError(503, "send_disabled")`
 * would reach the browser as an HTML outage page, and the client would never
 * see its `error` code. So an app-level dependency failure or dormant feature
 * is a `500` with a specific `error` code; 502/503/504 stay reserved for the
 * ALB and CloudFront.
 *
 * Allowlisted: the health probes. ALB and ECS hit them directly (no CloudFront)
 * and key on the status alone, so 503 there is load-bearing.
 *
 * The scan is line-based and skips comment lines. It looks for a 502/503/504
 * literal used as a status: `status: 503`, `status: ok ? 200 : 503`,
 * `editError(503, …)`, or `apiError("…", 502)`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["app", "lib", "proxy.ts"];
const SKIP_DIRS = new Set(["generated", "node_modules", "__tests__"]);
const SOURCE_EXT = /\.(ts|tsx)$/;

const ALLOWLIST: Record<string, string> = {
  "app/api/health/route.ts": "ALB target-group health check; 503 keeps a cold task out of rotation",
  "app/readiness/route.ts": "deep readiness probe; status-only machine consumer",
};

const STATUS_PATTERNS = [
  /\bstatus\s*:[^,}\n]*\b50[234]\b/,
  /\b(?:editError|jsonError|apiError|errorPage|err)\(\s*50[234]\b/,
  /\bapiError\([^)\n]*,\s*50[234]\s*[,)]/,
];

function collect(rel: string, out: string[]): void {
  const abs = path.join(REPO_ROOT, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      collect(path.join(rel, name), out);
    }
  } else if (SOURCE_EXT.test(rel) && !/\.test\.tsx?$/.test(rel)) {
    out.push(rel.split(path.sep).join("/"));
  }
}

function findGatewayStatusLiterals(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
    if (STATUS_PATTERNS.some((re) => re.test(line))) hits.push(`${file}:${i + 1}: ${t}`);
  });
  return hits;
}

describe("edge-safe status codes (#2503)", () => {
  it("detector flags the shapes it is meant to catch", () => {
    expect(findGatewayStatusLiterals("x.ts", `return editError(503, "x");`)).toHaveLength(1);
    expect(findGatewayStatusLiterals("x.ts", `  { status: 502 },`)).toHaveLength(1);
    expect(findGatewayStatusLiterals("x.ts", `{ status: ok ? 200 : 504 }`)).toHaveLength(1);
    expect(findGatewayStatusLiterals("x.ts", `return apiError("down", 502);`)).toHaveLength(1);
    expect(findGatewayStatusLiterals("x.ts", ` * returns 503 while cold`)).toHaveLength(0);
    expect(findGatewayStatusLiterals("x.ts", `return editError(500, "x");`)).toHaveLength(0);
  });

  it("no app/lib source returns 502/503/504 outside the allowlist", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collect(root, files);
    expect(files.length).toBeGreaterThan(100);
    const hits = files
      .filter((f) => !(f in ALLOWLIST))
      .flatMap((f) => findGatewayStatusLiterals(f, readFileSync(path.join(REPO_ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("allowlisted files still exist and still return a gateway code", () => {
    for (const f of Object.keys(ALLOWLIST)) {
      const hits = findGatewayStatusLiterals(f, readFileSync(path.join(REPO_ROOT, f), "utf8"));
      expect(hits.length, f).toBeGreaterThan(0);
    }
  });
});
