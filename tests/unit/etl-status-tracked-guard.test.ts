/**
 * Guardrail — every `etl_run` source a DEPLOYED step writes is listed on Data Sync.
 *
 * `etl-run-coverage-guard` proves each step writes a row. That is not enough:
 * `/edit/etl-status` and the freshness heartbeat read TRACKED x etl_run, so a
 * row whose source is not in TRACKED is written and never shown. Seven deployed
 * steps sat in exactly that gap (CenterPubRelevance, HeadshotMissing, ...).
 *
 * "Deployed" = an npm script cdk/lib/etl-stack.ts runs (read as text; no cdk
 * import outside cdk). Every source literal in that script's etl/ dir must be
 * TRACKED or exempt below with a reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { TRACKED } from "@/lib/etl/freshness-policy";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

// Sibling writers in a deployed step's dir that no schedule runs.
const EXEMPT: Record<string, string> = {
  "ClinicalTrials-Import": "hand-run bridge import (etl:clinical-trials:import), no schedule",
  "DataSharing-Import": "hand-run bridge import (etl:data-sharing:import), no schedule",
  "ED-StewardNames-Import": "hand-run (etl:ed:import-steward-names), no schedule",
  "ED-Student-Programs": "hand-run (etl:ed:student-programs), no schedule",
  "InfoEd-Biosketch-backfill": "hand-run --backfill of the tracked InfoEd-Biosketch step",
  "Jenzabar-GS-Faculty": "hand-run (etl:jenzabar:import-gs-faculty), no schedule",
  "COI-Statements-Import": "hand-run (etl:reciter:import-coi-statements), no schedule",
  "HonorsSeed-Import": "hand-run seed (etl:honors:import-seed), no schedule",
};

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const cdk = read("cdk/lib/etl-stack.ts");
const scripts = new Set(
  [...cdk.matchAll(/npmScript: "([^"]+)"|"npm", "run", "([^"]+)"/g)].map((m) => m[1] ?? m[2]),
);
const dirs = new Set(
  [...scripts]
    .map((s) => pkg.scripts[s]?.match(/(etl\/[^\s]+)\/[^/\s]+\.ts/)?.[1])
    .filter((d): d is string => d !== undefined),
);

/** Quoted source literals: `withEtlRun("X"...` (incl. a ternary) and `etlRun.create({ data: { source: "X"`. */
function writtenSources(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/withEtlRun\(([^,]*(?:\?[^,]*)?),/g))
    out.push(...[...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).filter((s) => !s.startsWith("-")));
  for (const m of src.matchAll(/etlRun\.create\(([\s\S]{0,200})/g)) {
    const s = m[1].match(/source: "([^"]+)"/);
    if (s) out.push(s[1]);
  }
  return out;
}

describe("Data Sync lists every deployed etl_run source", () => {
  it("finds enough deployed step dirs to be worth policing", () => {
    expect(dirs.size).toBeGreaterThan(40);
  });

  it("has no deployed source missing from TRACKED", () => {
    const missing: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(".ts"))) {
        for (const s of writtenSources(read(`${dir}/${f}`)))
          if (TRACKED[s] === undefined && EXEMPT[s] === undefined) missing.push(`${dir}/${f}: ${s}`);
      }
    }
    // Add the source to TRACKED (lib/etl/freshness-policy.ts) and its copy
    // (lib/edit/etl-source-copy.ts), or exempt it above with a reason.
    expect(missing).toEqual([]);
  });
});
