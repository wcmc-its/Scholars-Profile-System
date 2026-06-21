/**
 * Generate NIH-biosketch drafts LOCALLY (Bedrock, shell creds) from a facts JSON
 * file produced by `scripts/edit/overview-facts-probe.ts`. Companion to that probe
 * for the #917 v5 biosketch validation (significance lens + entity-floor): the probe
 * assembles facts in-VPC, this calls Claude on Bedrock with those facts and writes
 * the Contributions-to-Science (or Personal Statement) drafts.
 *
 *   GEN_MODE=contributions GEN_MODEL=us.anthropic.claude-opus-4-8 \
 *     npx tsx --tsconfig tsconfig.json scripts/edit/biosketch-generate-from-facts.ts /tmp/overview-facts.json
 *
 *   GEN_MODE=personal_statement PROJECT_TITLE="AAV gene therapy for X" PROJECT_AIMS="Aim 1 ..." \
 *     npx tsx --tsconfig tsconfig.json scripts/edit/biosketch-generate-from-facts.ts /tmp/overview-facts.json
 *
 * Defaults: Opus 4.8 + contributions mode, faithfulness pass ON (validation wants the
 * significance lens, which depends on the verify→revise loop to strip invented entities
 * / superlatives / external-uptake while keeping an anchored implication). The temperature
 * gate in the generator omits `temperature` for Opus 4.x/Fable automatically, so no 400.
 * No DB access — facts come from the file; only Bedrock is touched.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";

import { generateBiosketch } from "@/lib/edit/biosketch-generator";
import {
  normalizeBiosketchParams,
  type BiosketchEntry,
  type BiosketchMode,
} from "@/lib/edit/biosketch-params";
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import type { UngroundedSpan } from "@/lib/edit/overview-generator";

interface FactsRecord {
  cwid: string;
  label: string;
  sparse: boolean | null;
  facts: OverviewFacts | null;
}

interface BiosketchDraftResult {
  cwid: string;
  label: string;
  mode?: BiosketchMode;
  entries?: BiosketchEntry[];
  entryChars?: number[];
  overflow?: { index: number; chars: number }[];
  removed?: UngroundedSpan[];
  products?: BiosketchProducts | null;
  model?: string;
  error?: string;
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? process.env.FACTS_FILE;
  if (!file) {
    throw new Error("usage: tsx biosketch-generate-from-facts.ts <facts.json>");
  }
  const model = process.env.GEN_MODEL ?? "us.anthropic.claude-opus-4-8";
  const mode = (process.env.GEN_MODE ?? "contributions") as BiosketchMode;
  // #917 v7 — the biosketch prompt version to validate ("v5" baseline / "v6" role+grounded-impact
  // overhaul / "v7" adds titled contributions). An invalid/unset value normalizes to the live
  // default (v7, steerable via BIOSKETCH_PROMPT_VERSION_DEFAULT).
  const promptVersion = process.env.GEN_VERSION;
  // Default ON for validation: the significance lens leans on the verify→revise loop to
  // keep anchored implications while stripping invented entities / superlatives.
  const faithfulnessPass = process.env.BIOSKETCH_FAITHFULNESS !== "off";
  const projectTitle = process.env.PROJECT_TITLE ?? "";
  const aims = process.env.PROJECT_AIMS ?? "";

  const params = normalizeBiosketchParams({ mode, projectTitle, aims, promptVersion });

  const recs = JSON.parse(await fs.readFile(file, "utf8")) as FactsRecord[];
  const results: BiosketchDraftResult[] = [];

  for (const r of recs) {
    if (!r.facts) {
      results.push({ cwid: r.cwid, label: r.label, error: "no facts" });
      console.warn(`[biosketch] ${r.cwid}: no facts — skipped`);
      continue;
    }
    try {
      const res = await generateBiosketch(r.facts, params, { model, faithfulnessPass });
      results.push({
        cwid: r.cwid,
        label: r.label,
        mode: res.mode,
        entries: res.entries,
        entryChars: res.entries.map((e) => e.body.length),
        overflow: res.overflow,
        removed: res.removed,
        products: res.products,
        model: res.model,
      });
      console.warn(
        `[biosketch] ${r.cwid}: ok (${res.model}, ${res.mode}, ` +
          `${res.entries.length} entr${res.entries.length === 1 ? "y" : "ies"}, ` +
          `${res.overflow.length} over cap, ${res.removed.length} removed)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ cwid: r.cwid, label: r.label, error: msg });
      console.warn(`[biosketch] ${r.cwid}: ERROR ${msg}`);
    }
  }

  // Write to a file (awaited → guaranteed flush before exit; a large JSON written
  // to stdout is truncated by the immediate process.exit below).
  const out = process.argv[3] ?? process.env.OUT ?? "/tmp/biosketch-drafts.json";
  await fs.writeFile(out, JSON.stringify(results, null, 2), "utf8");
  console.warn(`[biosketch] wrote ${results.length} drafts to ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
