// MATCHA_GLOSS_QUERY A/B — STEP 1 of 3, runs LOCALLY.
//
// Extraction is the only half of the spine that needs Bedrock, and the in-VPC retrieval vehicle
// (`sps-etl-staging`) has ZERO Bedrock permissions. So extract here, on the laptop, and ship the
// result in. That is not just a workaround: ONE extraction shared by every arm means the
// extractor's ~0.0074 nDCG noise cancels WITHIN each pair instead of having to be averaged out
// across repeated draws.
//
// Emits the paste alongside its concepts so step 2 can re-derive the memo key from the same
// string. `MATCHA_EXTRACT_MODEL` is pinned on BOTH sides because it enters that key and the
// default is a module-private const.
//
// Run: AWS_REGION=us-east-1 npx tsx gloss-ab-extract.ts <pastes.json> > extractions.json
//   pastes.json = [{id, paste}]
import { readFileSync } from "node:fs";
import { extractMatchaConcepts } from "@/lib/api/matcha-extract";
import { normalizeDescription } from "@/lib/api/matcha";

export const PINNED_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

async function main() {
  process.env.MATCHA_EXTRACT_MODEL = PINNED_MODEL;
  const pastes: { id: string; paste: string }[] = JSON.parse(readFileSync(process.argv[2], "utf8"));

  const fixtures: unknown[] = [];
  for (const { id, paste } of pastes) {
    // The spine calls extractMatchaConcepts(normalizeDescription(description)), so the memo key
    // hashes THAT string. Re-derive it identically here or step 2's seed silently misses.
    const text = normalizeDescription(paste);
    const extraction = await extractMatchaConcepts(text);
    if (extraction.concepts.length === 0) {
      // A fail-soft [] would send the spine to its dictionary fallback and quietly measure the
      // WRONG engine. Refuse to ship it — an unmeasured fixture is not a zero.
      console.error(`!! ${id}: 0 concepts — UNMEASURED, dropped (Bedrock outage or empty)`);
      continue;
    }
    fixtures.push({ id, paste, text, extraction });
    console.error(
      `ok ${id}: ${extraction.concepts.length} concepts, ` +
        `${extraction.concepts.filter((c) => c.gloss).length} glossed`,
    );
  }

  if (fixtures.length === 0) throw new Error("every fixture came back empty — refusing to emit");
  console.log(JSON.stringify({ modelId: PINNED_MODEL, fixtures }, null, 2));
}

// Only extract when invoked directly — the self-check imports PINNED_MODEL from here, and the
// pin has to live in ONE place or the two sides can drift apart on the memo key.
if (require.main === module) void main();
