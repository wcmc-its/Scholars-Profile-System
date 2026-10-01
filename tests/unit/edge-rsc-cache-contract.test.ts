// @vitest-environment node
/**
 * Contract guard: every request header / query param the INSTALLED Next.js
 * uses to route or validate a React Flight (RSC) request must be in the
 * CloudFront cache key of the cacheable page behaviors in
 * `cdk/lib/edge-stack.ts` (`DefaultRscCache`, `QueryKeyedCache`).
 *
 * Why: CloudFront forwards to the origin ONLY what is in a cache policy's key
 * (no origin request policy on those behaviors). Next 16's origin recomputes
 * `?_rsc=` from the router headers and 307s on a mismatch, so a header Next
 * hashes but the edge strips becomes a redirect loop / retry storm -> WAF 429
 * (#2962, #2965). Nothing in CI could see that, because runners cannot reach
 * the WAF-allowlisted staging edge.
 *
 * This runs in the root `build` CI job, the only job with `next` installed
 * (the `cdk` job installs cdk/ deps only). It reads edge-stack.ts as TEXT:
 * a TS import from cdk/ here would break the Docker image build, where cdk/
 * is dockerignored. Next's side is read at RUNTIME from the installed
 * package, so a Next bump that adds or renames an input fails here.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// ---- Edge side (text parse of cdk/lib/edge-stack.ts) ----------------------

const EDGE_STACK = readFileSync(path.resolve(__dirname, "../../cdk/lib/edge-stack.ts"), "utf8");

function edgeRscHeaders(): string[] {
  const m = EDGE_STACK.match(/const rscCacheKeyHeaders = \[([\s\S]*?)\];/);
  if (!m) throw new Error("edge-stack.ts: `const rscCacheKeyHeaders = [...]` not found");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function edgeRscParam(): string {
  const m = EDGE_STACK.match(/const RSC_CACHE_BUST_PARAM = "([^"]+)";/);
  if (!m) throw new Error('edge-stack.ts: `const RSC_CACHE_BUST_PARAM = "..."` not found');
  return m[1];
}

/** Source of one `new cloudfront.CachePolicy(this, "<id>", { ... })` block. */
function cachePolicyBlock(id: string): string {
  const start = EDGE_STACK.indexOf(`new cloudfront.CachePolicy(this, "${id}"`);
  if (start < 0) throw new Error(`edge-stack.ts: CachePolicy "${id}" not found`);
  const end = EDGE_STACK.indexOf("\n    });", start);
  if (end < 0) throw new Error(`edge-stack.ts: end of CachePolicy "${id}" not found`);
  return EDGE_STACK.slice(start, end);
}

// ---- Next side (runtime, from the installed package) -----------------------

const headersMod = require("next/dist/client/components/app-router-headers") as Record<
  string,
  unknown
>;
const bustMod = require("next/dist/shared/lib/router/utils/cache-busting-search-param") as {
  computeCacheBustingSearchParam: (...args: unknown[]) => Promise<string>;
};
const BASE_SERVER = readFileSync(require.resolve("next/dist/server/base-server.js"), "utf8");

function nextConst(name: string): string {
  const v = headersMod[name];
  if (typeof v !== "string") throw new Error(`next app-router-headers no longer exports ${name}`);
  return v;
}

/**
 * Every `_approuterheaders.<CONST>` the origin reads while validating `_rsc`
 * (the block between the `validateRSCRequestHeaders` gate and the 307),
 * resolved to its runtime value. A new header Next starts hashing shows up
 * here even if the hash function's arity is unchanged.
 */
function originValidationInputs(): { name: string; value: string }[] {
  const start = BASE_SERVER.indexOf("validateRSCRequestHeaders");
  const end = BASE_SERVER.indexOf("res.statusCode = 307", start);
  if (start < 0 || end < 0) {
    throw new Error(
      "next/dist/server/base-server.js: RSC `_rsc` validation block not found -- " +
        "Next restructured it; re-audit which headers/params the origin hashes " +
        "against the edge cache policies before bumping.",
    );
  }
  const block = BASE_SERVER.slice(start, end);
  const names = [...new Set([...block.matchAll(/_approuterheaders\.([A-Z_]+)/g)].map((m) => m[1]))];
  return names.map((name) => ({ name, value: nextConst(name) }));
}

// Dev-only Flight header: `next dev` HMR, never sent to a deployed build.
const DEV_ONLY_FLIGHT_HEADERS = new Set(["next-hmr-refresh"]);

describe("edge cache policies forward every Next.js router header/param (#2962/#2965)", () => {
  const keyed = new Set(edgeRscHeaders().map((h) => h.toLowerCase()));
  const param = edgeRscParam();

  it("Next's `_rsc` cache-busting query name is the edge's RSC_CACHE_BUST_PARAM", () => {
    expect(param).toBe(nextConst("NEXT_RSC_UNION_QUERY"));
  });

  it("the RSC header and every `_rsc` hash-input header are keyed at the edge", () => {
    for (const name of [
      "RSC_HEADER",
      "NEXT_ROUTER_PREFETCH_HEADER",
      "NEXT_ROUTER_SEGMENT_PREFETCH_HEADER",
      "NEXT_ROUTER_STATE_TREE_HEADER",
      "NEXT_URL",
    ]) {
      expect(keyed, `${name} = "${nextConst(name)}" missing from rscCacheKeyHeaders`).toContain(
        nextConst(name),
      );
    }
  });

  it("the `_rsc` hash still takes exactly the 4 router-header inputs audited above", () => {
    // If Next adds a hash input, this arity changes: map the new input to its
    // header, add it to `rscCacheKeyHeaders`, then update this number.
    expect(bustMod.computeCacheBustingSearchParam.length).toBe(4);
  });

  it("every header/param the origin reads to validate `_rsc` reaches the origin", () => {
    const inputs = originValidationInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const { name, value } of inputs) {
      if (name === "NEXT_RSC_UNION_QUERY") {
        expect(value, "origin reads the `_rsc` query").toBe(param);
        continue;
      }
      expect(keyed, `origin hashes ${name} = "${value}" but the edge strips it`).toContain(value);
    }
  });

  it("every Flight-varying header Next declares (FLIGHT_HEADERS) is keyed", () => {
    const flight = headersMod.FLIGHT_HEADERS;
    expect(Array.isArray(flight)).toBe(true);
    for (const h of flight as string[]) {
      if (DEV_ONLY_FLIGHT_HEADERS.has(h)) continue;
      expect(keyed, `FLIGHT_HEADERS "${h}" missing from rscCacheKeyHeaders`).toContain(h);
    }
  });

  it.each(["DefaultRscCache", "QueryKeyedCache"])(
    "%s keys on rscCacheKeyHeaders and RSC_CACHE_BUST_PARAM",
    (id) => {
      const block = cachePolicyBlock(id);
      expect(block).toMatch(
        /headerBehavior: cloudfront\.CacheHeaderBehavior\.allowList\(\s*\.\.\.rscCacheKeyHeaders,?\s*\)/,
      );
      expect(block).toMatch(
        /queryStringBehavior: cloudfront\.CacheQueryStringBehavior\.allowList\([^)]*\bRSC_CACHE_BUST_PARAM\b[^)]*\)/,
      );
    },
  );
});
