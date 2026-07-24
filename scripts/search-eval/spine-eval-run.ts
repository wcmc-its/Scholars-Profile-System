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
// (see the spine's `clusterQuery` comment). The reusable vehicle now carries the MATCHA_GLOSS_RERANK
// λ-sweep: `ARM` selects the arm and `glossArmEnv` maps it to the rescore flags the spine reads.
//
// Run: npx tsx spine-eval-run.ts <extractions.json> [s3://bucket/key]   (ARM=base | ARM=gloss-0.5 …)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import { rankResearchersForDescriptionSpine } from "@/lib/api/matcha-spine-run";
import { fetchKeyPaper } from "@/lib/api/search";
import { normalizeDescription } from "@/lib/api/matcha";
import type { MatchaExtraction } from "@/lib/api/matcha-extract";
import { glossArmEnv } from "./spine-eval-arm";

/** The arm to run: `base` (rescore off, the ablation) or `gloss-<λ>`. Echoed into the artifact AND
 *  mapped to the gloss-rescore env below — one arm per process (the memo cache has no clear). */
const ARM = process.env.ARM ?? "default";

/** How deep to measure the key-paper evidence per fixture. The card only ever shows the top of the
 *  fused list, and each (candidate, concept) pair is one cached OpenSearch query — 10 keeps an arm
 *  to a few hundred, not thousands. Raise only if a concept's population sample looks too thin. */
const KEY_PAPER_EVAL_DEPTH = 10;

async function main() {
  const payload = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
    modelId: string;
    fixtures: { id: string; paste: string; text: string; extraction: MatchaExtraction }[];
  };
  const dest = process.argv[3]; // s3://bucket/key

  // Enters the memo key. Pinned identically in step 1; the default is module-private.
  process.env.MATCHA_EXTRACT_MODEL = payload.modelId;

  // Apply the arm's gloss-rescore flags BEFORE the spine reads process.env per fixture. `base`
  // unsets the flag (today's ordering); `gloss-<λ>` turns the rescore on at λ. Explicit unset so a
  // stray inherited MATCHA_GLOSS_RERANK can't leak the rescore into the ablation arm.
  const armEnv = glossArmEnv(ARM);
  if (armEnv.MATCHA_GLOSS_RERANK) {
    process.env.MATCHA_GLOSS_RERANK = armEnv.MATCHA_GLOSS_RERANK;
    process.env.MATCHA_GLOSS_RERANK_LAMBDA = armEnv.MATCHA_GLOSS_RERANK_LAMBDA;
  } else {
    delete process.env.MATCHA_GLOSS_RERANK;
  }
  console.error(`arm=${ARM} MATCHA_GLOSS_RERANK=${process.env.MATCHA_GLOSS_RERANK ?? "(off)"} λ=${process.env.MATCHA_GLOSS_RERANK_LAMBDA ?? "-"}`);

  // MATCHA_GLOSS_INWORDS — default ON so every arm emits the "in their words" evidence the §1
  // acceptance measurement counts (docs/2026-07-23-matcha-inwords-merged-next-steps-handoff.md).
  // It is a per-field highlight_query (search.ts): it computes highlights on hits the base query
  // already ranked, so it CANNOT change `ranked` — the nDCG λ-sweep reads `.ranked` only and is
  // unaffected on every arm. Overridable (set "off" for the exact pre-#1884 path).
  // ponytail: default-on beats threading a flag through the dispatch container — display-only, free.
  if (process.env.MATCHA_GLOSS_INWORDS == null) process.env.MATCHA_GLOSS_INWORDS = "on";
  console.error(`MATCHA_GLOSS_INWORDS=${process.env.MATCHA_GLOSS_INWORDS}`);

  // Reproduce the staging APP's search-evidence flag env. The eval runs on the sps-etl-<env> task
  // def, which carries NONE of these (verified: its env has zero SEARCH_* flags) — so `searchPeople`
  // gates OUT all evidence (`SEARCH_RESULT_EVIDENCE` off ⇒ no `evidence`/`evidenceLines`), the spine
  // then drops every (concept,cwid) block at `if (!hitEvidence) continue`, so no keyPaper is emitted
  // → the artifact's `.evidence` is present but every `blocks:[]`. Staging app has all of these ON
  // (SEARCH_RESULT_EVIDENCE / _EVIDENCE_REASON_COUNTS / _PEOPLE_MATCH_AWARE_SNIPPET / _PEOPLE_CONCEPT_HINT),
  // so the measured spine must too or it isn't the shipped path. Default-on, each overridable.
  for (const f of [
    "SEARCH_RESULT_EVIDENCE",
    "SEARCH_EVIDENCE_REASON_COUNTS",
    "SEARCH_PEOPLE_MATCH_AWARE_SNIPPET",
    "SEARCH_PEOPLE_CONCEPT_HINT",
  ]) {
    if (process.env[f] == null) process.env[f] = "on";
  }
  console.error(`SEARCH_RESULT_EVIDENCE=${process.env.SEARCH_RESULT_EVIDENCE} REASON_COUNTS=${process.env.SEARCH_EVIDENCE_REASON_COUNTS}`);

  // REASON_AGG_BYPASS makes cachedReasonAgg call through instead of caching, which would send
  // every seed straight to a Bedrock call this role cannot make. Fail loudly, not silently.
  if (process.env.REASON_AGG_BYPASS) throw new Error("REASON_AGG_BYPASS is set — the seed cannot take");

  const ranked: Record<string, string[]> = {};
  // MATCHA_GLOSS_INWORDS acceptance data. The evidence now lives on the LAZY key-paper fetch
  // (`fetchKeyPaper`, admission = this scholar AND this concept's MeSH descendants), which the spine
  // never calls — so the harness calls it per (concept, cwid) itself, bounded to the top
  // KEY_PAPER_EVAL_DEPTH candidates so one arm stays a few hundred cached queries, not thousands.
  // `pmid` is emitted so the §1 audit can PROVE the on-concept invariant rather than trust it;
  // `titleHtml` is the marked title (absent ⇒ no mark ⇒ no claim) and `glossTerms` is what was asked
  // for, so the scorer can attribute a mark to the gloss rather than to the concept/query clauses.
  // Additive: the dispatch's `jq '.ranked'` ignores it, so sponsor-eval.sh sees identical input.
  const evidence: Record<
    string,
    {
      cwid: string;
      rank: number;
      blocks: {
        term: string;
        glossTerms: string | null;
        pmid: string | null;
        titleHtml: string | null;
        leadMarked: boolean;
      }[];
    }[]
  > = {};
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
    evidence[f.id] = [];
    for (const [rank, c] of result.candidates.slice(0, KEY_PAPER_EVAL_DEPTH).entries()) {
      const blocks = [];
      for (const e of c.searchEvidence ?? []) {
        // The SAME call the card makes on disclosure — so the measurement is of the shipped path.
        const pubs = await fetchKeyPaper({ cwid: c.cwid, ...e.keyPaper });
        const marked = pubs.find((p) => p.titleHtml?.includes("<mark>")) ?? null;
        blocks.push({
          term: e.term,
          glossTerms: e.keyPaper.glossTerms ?? null,
          pmid: marked?.pmid ?? null,
          titleHtml: marked?.titleHtml ?? null,
          // `marked` scans all three returned pubs, but the card FACE shows only `papers[0]`
          // (evidence-line.tsx `ArtifactLead` — the rest sit behind "+N more pubs"). Reporting only
          // the any-of-3 rate would inflate the ship number against what an officer actually sees,
          // so carry both: `leadMarked` is the face rate, `marked` the one-click-reachable rate.
          leadMarked: pubs[0]?.titleHtml?.includes("<mark>") ?? false,
        });
      }
      evidence[f.id].push({ cwid: c.cwid, rank, blocks });
    }
    console.error(`  ✓ ${f.id} [${ARM}] ${result.candidates.length} candidates, ${result.concepts.length} concepts`);
  }

  const out = JSON.stringify({ arm: ARM, ranked, evidence, unmeasured }, null, 2);
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
