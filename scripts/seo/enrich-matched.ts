/**
 * Enrich the matched-researcher file with OpenAlex eminence covariates so the
 * matched head-to-head is controlled for researcher caliber.
 *
 *   npm run seo:enrich-matched                      # fill missing h-index/age
 *   npm run seo:enrich-matched -- --force            # re-resolve every record
 *   npm run seo:enrich-matched -- --year 2026        # reference year for academic age
 *
 * For each record it resolves an OpenAlex author (by ORCID if present, else by
 * name + institution), then writes back `hIndex`, `academicAge`, `openalexId`,
 * `eminenceSource`. ONE source for every institution, by design (see
 * lib/seo/openalex.ts). Free API, no key; set OPENALEX_MAILTO for the polite
 * pool. Idempotent: skips records that already have covariates unless --force.
 *
 * Records that don't resolve (e.g. a placeholder name awaiting comms
 * validation) are left with null covariates and logged — never invented.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveEminence } from "@/lib/seo/openalex";

const MATCHED_FILE = path.resolve(process.cwd(), "data", "seo", "matched-researchers.json");

interface MatchedRecord {
  matchGroup: string;
  institution: string;
  name: string;
  orcid?: string;
  openalexId?: string;
  hIndex?: number;
  academicAge?: number;
  eminenceSource?: string;
  [k: string]: unknown; // preserve scaffold annotations (e.g. "verified")
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = getFlag(argv, "--file") ?? MATCHED_FILE;
  const force = argv.includes("--force");
  // tsx script (not a Workflow) — a wall-clock year is fine and overridable.
  const referenceYear = Number(getFlag(argv, "--year") ?? new Date().getFullYear());

  const records = JSON.parse(await fs.readFile(file, "utf8")) as MatchedRecord[];
  let resolved = 0;
  let missed = 0;

  for (const r of records) {
    if (!force && r.hIndex != null && r.academicAge != null) continue;
    const placeholder = /replace_me|tbd|^\s*$/i.test(r.name);
    if (placeholder) {
      console.warn(`[seo:enrich-matched] skip placeholder: ${r.matchGroup} / ${r.institution} ("${r.name}")`);
      continue;
    }
    const e = await resolveEminence({ orcid: r.orcid, name: r.name, institution: r.institution }, referenceYear);
    if (e.openalexId === null) {
      missed++;
      console.warn(`[seo:enrich-matched] NO MATCH: ${r.name} (${r.institution}) — leaving covariates null`);
    } else {
      resolved++;
      console.log(
        `[seo:enrich-matched] ${r.name} (${r.institution}) → h=${e.hIndex ?? "?"}, age=${e.academicAge ?? "?"} [matched: ${e.matchedName}]`,
      );
    }
    if (e.hIndex != null) r.hIndex = e.hIndex;
    if (e.academicAge != null) r.academicAge = e.academicAge;
    if (e.openalexId != null) r.openalexId = e.openalexId;
    r.eminenceSource = e.source;
    await sleep(200); // be polite to OpenAlex
  }

  await fs.writeFile(file, JSON.stringify(records, null, 2) + "\n", "utf8");
  console.log(`[seo:enrich-matched] resolved ${resolved}, missed ${missed}, of ${records.length} records → ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
