// In-VPC spine runner — STEP 2 of 3. Runs on a one-off `sps-etl-staging` task.
//
// Produces a ranked cwid list per fixture by calling the REAL spine against the REAL staging
// OpenSearch, in the `{id: [cwid, ...]}` shape `sponsor-eval.sh` consumes.
//
// WHY IT IS SPLIT ACROSS TWO ENVIRONMENTS. Retrieval needs OpenSearch, which is in-VPC only.
// Extraction needs Bedrock, which the `sps-etl` task role does NOT have. Neither environment has
// both, so step 1 extracts on the laptop and this step seeds the result in.
//
// THE SEED. `extractMatchaConcepts` memoises on `matcha:extract:<modelId>:<sha256(trimmed text)>`
// via `cachedReasonAgg` (#1800). Priming that exact key makes the spine's own extractor call a
// cache hit, so `rankResearchersForDescriptionSpine` runs UNMODIFIED and every MeSH argument it
// hands `searchPeople` stays real — the thing a hand-rolled retrieval harness silently drops.
// It also means one extraction is shared by every arm of a comparison, so the extractor's
// ~0.0074 nDCG noise cancels WITHIN a pair instead of needing repeated draws.
//
// ONE ARM PER PROCESS. The memo key does not include any arm identity and `reason-agg-cache`
// exports no clear, so re-seeding the same key in one process serves the FIRST value. Whatever a
// caller varies between arms (an env flag, a doctored extraction), it must run this script once
// per arm — see `spine-eval-dispatch.sh`.
//
// History: this began as the MATCHA_GLOSS_QUERY A/B harness. That flag was measured and DELETED
// (see the spine's `clusterQuery` comment), so the gloss-specific arms are gone and what remains
// is the reusable vehicle.
//
// Run: npx tsx spine-eval-run.ts <extractions.json> [s3://bucket/key]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import { rankResearchersForDescriptionSpine } from "@/lib/api/matcha-spine-run";
import { normalizeDescription } from "@/lib/api/matcha";
import type { MatchaExtraction } from "@/lib/api/matcha-extract";

/** Label for this run, echoed into the artifact. Free-form — the caller uses it to tell arms
 *  apart when it varies something (an env flag, a patched image) between invocations. */
const ARM = process.env.ARM ?? "default";

async function main() {
  const payload = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
    modelId: string;
    fixtures: { id: string; paste: string; text: string; extraction: MatchaExtraction }[];
  };
  const dest = process.argv[3]; // s3://bucket/key

  // Enters the memo key. Pinned identically in step 1; the default is module-private.
  process.env.MATCHA_EXTRACT_MODEL = payload.modelId;

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

    const key = `matcha:extract:${payload.modelId}:${createHash("sha256").update(text.trim(), "utf8").digest("hex")}`;
    // `() => true` so a seed is always retained; the default shouldCache is not ours to assume.
    await cachedReasonAgg<MatchaExtraction>(key, async () => f.extraction, () => true);

    const result = await rankResearchersForDescriptionSpine(f.paste);

    // THE GUARD THAT MAKES THIS TRUSTWORTHY. A missed seed does not throw — extractMatchaConcepts
    // fail-softs to [] and the spine falls back to the v1 DICTIONARY extractor, which would return
    // a plausible-looking ranking off entirely different terms. Every returned concept must trace
    // to a seeded term (the spine caps and clusters, so a subset is expected; a stranger is not).
    const seeded = new Set(f.extraction.concepts.map((c) => c.term));
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
  if (dest) {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(dest);
    if (!m) throw new Error(`bad destination (want s3://bucket/key): ${dest}`);
    await new S3Client({}).send(
      new PutObjectCommand({ Bucket: m[1], Key: m[2], Body: out, ContentType: "application/json" }),
    );
    console.error(`uploaded ${Object.keys(ranked).length} fixtures (${unmeasured.length} unmeasured)`);
  } else {
    console.log(out);
  }
}

// EXIT EXPLICITLY. `main()` resolving is not enough to end the process: the Prisma pool and the
// OpenSearch client's keep-alive sockets stay open, so node keeps the event loop alive and a
// caller looping over arms never reaches the next one. The results are already durable here.
void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
