// MATCHA_GLOSS_QUERY A/B — STEP 2 of 3, runs IN-VPC on `sps-etl-staging`.
//
// Retrieval needs OpenSearch, which is in-VPC only; extraction needs Bedrock, which this task role
// does NOT have. Step 1 already did the extraction on the laptop, so this seeds the extractor's
// memo and never calls Bedrock at all.
//
// THE SEED. `extractMatchaConcepts` memoises on `matcha:extract:<modelId>:<sha256(trimmed text)>`
// via `cachedReasonAgg` (#1800). Priming that exact key makes the spine's own extractor call a
// cache hit, so `rankResearchersForDescriptionSpine` runs unmodified and every MeSH argument it
// passes to `searchPeople` stays real — the thing a hand-rolled retrieval harness silently drops.
//
// THE THREE ARMS, on a STOCK image. The deployed spine composes the ON query as
// `glossByTerm.get(m) ?? m` — the gloss REPLACES the token. So seeding a doctored gloss of
// `"<term> <gloss>"` makes that same substituting code emit `term gloss`, which is exactly the
// append fix. That is why this measures the proposed fix without building or pushing an image.
//
//   off         flag unset  + real extraction      => members.join(" ")
//   substitute  flag on     + real extraction      => gloss alone        (today's staging)
//   append      flag on     + "<term> <gloss>"     => term + gloss       (the fix)
//
// ponytail: simulating `append` through the seed rather than shipping a patched image. Ceiling —
// it only holds while the ON arm substitutes; once the append fix is merged, the `append` arm here
// would double the term, so re-point this at the real flag and drop the doctored arm.
//
// ONE ARM PER PROCESS. The memo key does not include the arm, and `reason-agg-cache` exports no
// clear, so a second arm in the same process would be served the first arm's seeded value. The
// caller loops `ARM=... npx tsx gloss-ab-run.ts` so each arm starts on a cold Map.
//
// Run: ARM=off|substitute|append npx tsx gloss-ab-run.ts <extractions.json> [presigned-PUT-url]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import { rankResearchersForDescriptionSpine } from "@/lib/api/matcha-spine-run";
import { normalizeDescription } from "@/lib/api/matcha";
import type { MatchaExtraction } from "@/lib/api/matcha-extract";

type Arm = "off" | "substitute" | "append";
const ARM = (process.env.ARM ?? "") as Arm;
if (!["off", "substitute", "append"].includes(ARM)) throw new Error(`bad ARM: ${ARM}`);

/** The arm's seeded extraction. `append` doctors each gloss to "<term> <gloss>" so the deployed
 *  SUBSTITUTING composition emits the appended query. Concepts with no gloss are untouched in
 *  every arm — they contribute their bare token either way. */
function seedFor(extraction: MatchaExtraction, arm: Arm): MatchaExtraction {
  if (arm !== "append") return extraction;
  return {
    ...extraction,
    concepts: extraction.concepts.map((c) =>
      c.gloss ? { ...c, gloss: `${c.term} ${c.gloss}` } : c,
    ),
  };
}

async function main() {
  const payload = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
    modelId: string;
    fixtures: { id: string; paste: string; text: string; extraction: MatchaExtraction }[];
  };
  const putUrl = process.argv[3];

  // Enters the memo key. Pinned identically in step 1; the default is module-private.
  process.env.MATCHA_EXTRACT_MODEL = payload.modelId;
  if (ARM === "off") delete process.env.MATCHA_GLOSS_QUERY;
  else process.env.MATCHA_GLOSS_QUERY = "on";

  // REASON_AGG_BYPASS makes cachedReasonAgg call through instead of caching, which would send
  // every seed straight to a Bedrock call this role cannot make. Fail loudly, not silently.
  if (process.env.REASON_AGG_BYPASS) throw new Error("REASON_AGG_BYPASS is set — the seed cannot take");

  const ranked: Record<string, string[]> = {};
  const unmeasured: { id: string; why: string }[] = [];

  for (const f of payload.fixtures) {
    // Guard the image's `normalizeDescription` against the laptop's — they must agree or the key
    // this process derives is not the key the spine will look up.
    const text = normalizeDescription(f.paste);
    if (text !== f.text) {
      unmeasured.push({ id: f.id, why: "normalizeDescription drift between laptop and image" });
      continue;
    }

    const seed = seedFor(f.extraction, ARM);
    const key = `matcha:extract:${payload.modelId}:${createHash("sha256").update(text.trim(), "utf8").digest("hex")}`;
    // `() => true` so a seed is always retained; the default shouldCache is not ours to assume.
    await cachedReasonAgg<MatchaExtraction>(key, async () => seed, () => true);

    const result = await rankResearchersForDescriptionSpine(f.paste);

    // THE GUARD THAT MAKES THIS TRUSTWORTHY. A missed seed does not throw — extractMatchaConcepts
    // fail-softs to [] and the spine falls back to the v1 DICTIONARY extractor, which would return
    // a plausible-looking ranking off entirely different terms. Every returned concept must trace
    // to a seeded term (the spine caps and clusters, so a subset is expected; a stranger is not).
    const seeded = new Set(seed.concepts.map((c) => c.term));
    const strangers = result.concepts.map((c) => c.term).filter((t) => !seeded.has(t));
    if (strangers.length > 0) {
      unmeasured.push({ id: f.id, why: `seed MISSED — dictionary fallback: ${strangers.join(", ")}` });
      console.error(`  ✗ ${f.id} — seed missed (${strangers.slice(0, 3).join(", ")})`);
      continue;
    }
    if (result.candidates.length === 0) {
      unmeasured.push({ id: f.id, why: "zero candidates" });
      continue;
    }

    ranked[f.id] = result.candidates.map((c) => c.cwid);
    console.error(`  ✓ ${f.id} [${ARM}] ${result.candidates.length} candidates, ${result.concepts.length} concepts`);
  }

  const out = JSON.stringify({ arm: ARM, ranked, unmeasured }, null, 2);
  if (putUrl) {
    const res = await fetch(putUrl, { method: "PUT", body: out });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    console.error(`uploaded ${Object.keys(ranked).length} fixtures (${unmeasured.length} unmeasured)`);
  } else {
    console.log(out);
  }
}

void main();
