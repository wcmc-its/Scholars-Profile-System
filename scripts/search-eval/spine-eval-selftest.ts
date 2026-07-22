// Self-check for the in-VPC spine runner's seed. No infra: no OpenSearch, no Bedrock, no DB.
//
// The whole vehicle rests on one unverified assumption — that the key this harness derives is the
// key `extractMatchaConcepts` looks up. If it is not, the in-VPC run does NOT fail: extraction
// fail-softs to [] and the spine quietly falls back to the v1 dictionary extractor, producing a
// plausible ranking off the wrong terms. So prove the seed lands BEFORE spending an ECS task.
//
// Run: npx tsx spine-eval-selftest.ts     (asserts; non-zero exit on failure)
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import { extractMatchaConcepts, type MatchaExtraction } from "@/lib/api/matcha-extract";
import { normalizeDescription } from "@/lib/api/matcha";
import { PINNED_MODEL } from "./spine-eval-extract";
import { glossArmEnv } from "./spine-eval-arm";

// A term no extractor would ever emit — if we get it back, the value came from OUR seed and
// nothing else. Bedrock is never reached, so this also passes with no AWS credentials.
const SENTINEL = "zzz-sentinel-concept-not-from-bedrock";

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

  // 3. Arm → env mapping. A wrong mapping ⇒ a base arm and a gloss arm produce IDENTICAL rankings
  // and the sweep reads as "λ had no effect" — a false-negative kill, invisible to the seed guard.
  assert.deepEqual(glossArmEnv("base"), {}, "base arm must leave the rescore off");
  assert.deepEqual(glossArmEnv("gloss-0.25"), { MATCHA_GLOSS_RERANK: "on", MATCHA_GLOSS_RERANK_LAMBDA: "0.25" });
  assert.deepEqual(glossArmEnv("gloss-0.5"), { MATCHA_GLOSS_RERANK: "on", MATCHA_GLOSS_RERANK_LAMBDA: "0.5" });
  assert.deepEqual(glossArmEnv("gloss-1.0"), { MATCHA_GLOSS_RERANK: "on", MATCHA_GLOSS_RERANK_LAMBDA: "1.0" });
  console.log("✓ arm→env: base leaves the rescore off; gloss-<λ> turns it on at λ");

  console.log("\nALL SELF-CHECKS PASSED — safe to dispatch");
}

void main();
