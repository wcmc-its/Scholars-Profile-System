// Self-check for the gloss A/B seed trick. No infra: no OpenSearch, no Bedrock, no DB.
//
// The whole vehicle rests on one unverified assumption — that the key this harness derives is the
// key `extractMatchaConcepts` looks up. If it is not, the in-VPC run does NOT fail: extraction
// fail-softs to [] and the spine quietly falls back to the v1 dictionary extractor, producing a
// plausible ranking off the wrong terms. So prove the seed lands BEFORE spending an ECS task.
//
// Run: npx tsx gloss-ab-selftest.ts     (asserts; non-zero exit on failure)
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import { extractMatchaConcepts, type MatchaExtraction } from "@/lib/api/matcha-extract";
import { normalizeDescription } from "@/lib/api/matcha";
import { PINNED_MODEL } from "./gloss-ab-extract";

// A term no extractor would ever emit — if we get it back, the value came from OUR seed and
// nothing else. Bedrock is never reached, so this also passes with no AWS credentials.
const SENTINEL = "zzz-sentinel-concept-not-from-bedrock";

function seedFor(extraction: MatchaExtraction, arm: "off" | "substitute" | "append"): MatchaExtraction {
  if (arm !== "append") return extraction;
  return {
    ...extraction,
    concepts: extraction.concepts.map((c) => (c.gloss ? { ...c, gloss: `${c.term} ${c.gloss}` } : c)),
  };
}

async function main() {
  process.env.MATCHA_EXTRACT_MODEL = PINNED_MODEL;
  assert.ok(!process.env.REASON_AGG_BYPASS, "REASON_AGG_BYPASS set — the seed cannot take");

  const paste = "We fund work on lysosomes, specifically lysosomal processing of ADC linkers.";
  const text = normalizeDescription(paste);
  const seeded: MatchaExtraction = {
    concepts: [
      { term: SENTINEL, kind: "concept", centrality: 1, gloss: "the sponsor's own words" },
      { term: "lysosomes", kind: "concept", centrality: 0.8 },
    ],
  };

  // 1. The key derivation matches extractMatchaConcepts (modelId + sha256 of the TRIMMED text).
  const key = `matcha:extract:${PINNED_MODEL}:${createHash("sha256").update(text.trim(), "utf8").digest("hex")}`;
  await cachedReasonAgg<MatchaExtraction>(key, async () => seeded, () => true);

  // 2. The spine's own extractor call is now a cache hit — Bedrock is never reached.
  const got = await extractMatchaConcepts(text);
  assert.equal(got.concepts[0]?.term, SENTINEL, "SEED MISSED — key derivation disagrees");
  assert.equal(got.concepts.length, 2);
  console.log("✓ seed lands: extractMatchaConcepts served the seeded extraction, no Bedrock call");

  // 3. The append arm doctors ONLY glossed concepts, and yields "<term> <gloss>" — which is what
  //    the deployed SUBSTITUTING composition (`glossByTerm.get(m) ?? m`) will emit as the query.
  const appended = seedFor(seeded, "append");
  assert.equal(appended.concepts[0].gloss, `${SENTINEL} the sponsor's own words`);
  assert.equal(appended.concepts[1].gloss, undefined, "an unglossed concept must stay untouched");
  console.log("✓ append arm: glossed concept becomes '<term> <gloss>', unglossed left alone");

  // 4. The off/substitute arms must not mutate the extraction at all.
  assert.deepEqual(seedFor(seeded, "off"), seeded);
  assert.deepEqual(seedFor(seeded, "substitute"), seeded);
  console.log("✓ off/substitute arms pass the extraction through unchanged");

  console.log("\nALL SELF-CHECKS PASSED — safe to dispatch");
}

void main();
