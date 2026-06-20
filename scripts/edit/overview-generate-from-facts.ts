/**
 * Generate overview drafts LOCALLY (Bedrock, shell creds) from a facts JSON file
 * produced by `scripts/edit/overview-facts-probe.ts`. Companion to that probe for
 * the #742 model+prompt validation (Opus 4.8 + v4): the probe assembles facts
 * in-VPC, this calls Claude on Bedrock with those facts and prints the drafts.
 *
 *   GEN_MODEL=us.anthropic.claude-opus-4-8 GEN_VERSION=v4 \
 *     npx tsx --tsconfig tsconfig.json scripts/edit/overview-generate-from-facts.ts /tmp/overview-facts.json
 *
 * Defaults: Opus 4.8 + v4, faithfulness pass OFF (validates the bare prompt — the
 * deployed default). The temperature gate in the generator omits `temperature`
 * for Opus 4.x/Fable automatically, so no 400. No DB access — facts come from the
 * file; only Bedrock is touched.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";

import { generateOverviewDraft } from "@/lib/edit/overview-generator";
import { DEFAULT_OVERVIEW_PARAMS } from "@/lib/edit/overview-params";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import type { OverviewPromptVersionId } from "@/lib/edit/overview-prompt-versions";

interface FactsRecord {
  cwid: string;
  label: string;
  sparse: boolean | null;
  facts: OverviewFacts | null;
}

interface DraftResult {
  cwid: string;
  label: string;
  sparse: boolean | null;
  model?: string;
  promptVersion?: string;
  draft?: string;
  error?: string;
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? process.env.FACTS_FILE;
  if (!file) {
    throw new Error("usage: tsx overview-generate-from-facts.ts <facts.json>");
  }
  const model = process.env.GEN_MODEL ?? "us.anthropic.claude-opus-4-8";
  const version = (process.env.GEN_VERSION ?? "v4") as OverviewPromptVersionId;

  const recs = JSON.parse(await fs.readFile(file, "utf8")) as FactsRecord[];
  const results: DraftResult[] = [];

  for (const r of recs) {
    if (!r.facts) {
      results.push({ cwid: r.cwid, label: r.label, sparse: r.sparse, error: "no facts" });
      console.warn(`[generate] ${r.cwid}: no facts — skipped`);
      continue;
    }
    try {
      const res = await generateOverviewDraft(
        r.facts,
        { ...DEFAULT_OVERVIEW_PARAMS, promptVersion: version },
        { model, promptVersion: version, faithfulnessPass: false },
      );
      results.push({
        cwid: r.cwid,
        label: r.label,
        sparse: r.sparse,
        model: res.model,
        promptVersion: res.promptVersion,
        draft: res.draft,
      });
      console.warn(`[generate] ${r.cwid}: ok (${res.model}, ${res.promptVersion})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ cwid: r.cwid, label: r.label, sparse: r.sparse, error: msg });
      console.warn(`[generate] ${r.cwid}: ERROR ${msg}`);
    }
  }

  // Write to a file (awaited → guaranteed flush before exit; a large JSON written
  // to stdout is truncated by the immediate process.exit below).
  const out = process.argv[3] ?? process.env.OUT ?? "/tmp/overview-drafts.json";
  await fs.writeFile(out, JSON.stringify(results, null, 2), "utf8");
  console.warn(`[generate] wrote ${results.length} drafts to ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
