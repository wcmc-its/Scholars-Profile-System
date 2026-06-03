/**
 * #362 — §4/§7 Recall@3 harness for the People-relevance eval.
 *
 * Runs the frozen §3.1 labeled set (docs/people-relevance-baseline.md §6)
 * through `searchPeople()` and reports Recall@3 per query shape. Bypasses the
 * HTTP/route layer — calls the same `searchPeople` the route does, so the
 * ranking is faithful.
 *
 * Two modes (`SEARCH_PEOPLE_RELEVANCE_MODE`, mirroring the product env):
 *   - unset / "legacy" → the frozen §7 baseline (signed off 2026-05-27, PR-2's
 *     rollback target). Re-running reproduces those numbers; never re-freeze
 *     from a refreshed run (SPEC §4).
 *   - "v3" → the §6.1 shape-routed templates (#309–#311) + the #513 prominence
 *     factor. Replicates the route's classify + MeSH-resolve so each query
 *     routes to the same template production would use. Requires the index to
 *     carry PR-3's v3 fields (publicationMeshUi etc.) — rebuild first via
 *     `npm run search:index:people`.
 *
 * Requires OpenSearch up (`npm run db:up`) and a current `scholars-people`
 * index.
 *
 * Run (host dev DB reached via the OS-user socket — see
 * memory/feedback_verify_db_target):
 *   DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
 *     npx tsx scripts/people-relevance-dryrun.ts                 # legacy
 *   SEARCH_PEOPLE_RELEVANCE_MODE=v3 DATABASE_URL='…' \
 *     npx tsx scripts/people-relevance-dryrun.ts                 # v3
 */
import { searchPeople } from "@/lib/api/search";
import { meshMatchTier, type MeshMatchTier } from "@/lib/search";
import {
  classifyPeopleQuery,
  type PeopleQueryShape,
} from "@/lib/api/people-query-shape";
import { getPeopleClassifierSets } from "@/lib/api/people-classifier-sets";
import { resolveDeptLeadershipBoost } from "@/lib/api/search-flags";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";

type Shape = "name" | "topic" | "department" | "hybrid";
type Case = { n: number; shape: Shape; query: string; labeled: string[] };

const CASES: Case[] = [
  { n: 1,  shape: "name",       query: "iadecola",                   labeled: ["costantino-iadecola"] },
  { n: 2,  shape: "name",       query: "richard devereux",           labeled: ["richard-b-devereux"] },
  { n: 3,  shape: "name",       query: "harold varmus",              labeled: ["harold-e-varmus"] },
  { n: 4,  shape: "name",       query: "wong",                       labeled: ["stephen-t-c-wong", "shing-chiu-wong", "richard-j-wong"] },
  { n: 5,  shape: "topic",      query: "melanoma",                   labeled: ["jedd-d-wolchok", "taha-merghoub"] },
  { n: 6,  shape: "topic",      query: "breast cancer",              labeled: ["rulla-tamimi", "massimo-cristofanilli", "lisa-newman"] },
  { n: 7,  shape: "topic",      query: "spatial transcriptomics",    labeled: ["olivier-elemento", "christopher-e-mason"] },
  { n: 8,  shape: "topic",      query: "immunology",                 labeled: ["jedd-d-wolchok", "sallie-permar"] },
  { n: 9,  shape: "department", query: "pediatrics",                 labeled: ["james-b-bussel", "nai-kong-cheung", "richard-j-oreilly"] },
  { n: 10, shape: "department", query: "population health sciences", labeled: ["rulla-tamimi", "philip-goodney", "bjorn-redfors"] },
  { n: 11, shape: "hybrid",     query: "iadecola stroke",            labeled: ["costantino-iadecola"] },
  { n: 12, shape: "hybrid",     query: "medicine cardiology",        labeled: ["monika-m-safford", "parag-goyal", "jonathan-w-weinsaft"] },
];

const SHAPES: Shape[] = ["name", "topic", "department", "hybrid"];

const MODE: "legacy" | "v3" =
  process.env.SEARCH_PEOPLE_RELEVANCE_MODE === "v3" ? "v3" : "legacy";

/**
 * Mirror the route's classify + MeSH-resolve so a v3 run routes each query to
 * the same template production would. (Run in legacy mode too — the classified
 * shape is shown for reference; it just doesn't drive ranking.)
 */
async function classify(
  query: string,
  sets: Awaited<ReturnType<typeof getPeopleClassifierSets>>,
): Promise<{
  shape: PeopleQueryShape;
  meshDescendantUis?: string[];
  meshMatchTier?: MeshMatchTier;
  meshAmbiguous?: boolean;
  meshMatchedFormLength?: number;
}> {
  const taxonomy = await matchQueryToTaxonomy(query);
  const res = taxonomy.meshResolution;
  const shape = classifyPeopleQuery({
    query,
    meshResolved: res != null,
    knownCwids: sets.cwids,
    knownSurnames: sets.surnames,
    knownDepartments: sets.departments,
  });
  return {
    shape,
    meshDescendantUis: res?.descendantUis,
    // #726 — thread the same tier + floor inputs production uses, so the dryrun
    // exercises the graduated attribution AND the sparse concept escalation.
    meshMatchTier: res
      ? meshMatchTier(res.confidence, res.curatedTopicAnchors.length)
      : undefined,
    meshAmbiguous: res?.ambiguous,
    meshMatchedFormLength: res?.matchedForm.length,
  };
}

async function main() {
  const perShape: Record<Shape, { found: number; total: number }> = {
    name: { found: 0, total: 0 }, topic: { found: 0, total: 0 },
    department: { found: 0, total: 0 }, hybrid: { found: 0, total: 0 },
  };
  const ranks: number[] = [];
  const sets = await getPeopleClassifierSets();

  const title =
    MODE === "v3"
      ? "v3 (§6.1 templates + #513 prominence)"
      : "legacy (frozen §7 baseline)";
  console.log(`=== #362 People-relevance Recall@3 — ${title} ===\n`);
  console.log(
    " # | shape      | cls        | query                       | total | top-3 result slugs                              | hit",
  );
  console.log("-".repeat(140));

  for (const c of CASES) {
    let top3: string[] = [];
    let allHits: string[] = [];
    let total = 0;
    let err = "";
    let cls = "-";
    try {
      const {
        shape,
        meshDescendantUis,
        meshMatchTier,
        meshAmbiguous,
        meshMatchedFormLength,
      } = await classify(c.query, sets);
      cls = shape;
      const r = await searchPeople(
        MODE === "v3"
          ? {
              q: c.query,
              relevanceMode: "v3",
              shape,
              meshDescendantUis,
              meshMatchTier,
              meshAmbiguous,
              meshMatchedFormLength,
              // Issue #532 — surface the env-gated dept-leadership boost so
              // the dryrun mirrors the route's behavior under either flag
              // state. Toggle by exporting SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST.
              deptLeadershipBoost: resolveDeptLeadershipBoost(),
            }
          : { q: c.query },
      );
      total = r.total;
      allHits = r.hits.map((h: { slug: string }) => h.slug);
      top3 = allHits.slice(0, 3);
    } catch (e) {
      err = String((e as Error)?.message ?? e).split("\n")[0];
    }
    const found = c.labeled.filter((s) => top3.includes(s));
    perShape[c.shape].found += found.length;
    perShape[c.shape].total += c.labeled.length;
    for (const s of c.labeled) {
      const idx = allHits.indexOf(s);
      if (idx >= 0) ranks.push(idx + 1);
    }
    const miss = c.labeled.filter((s) => !top3.includes(s));
    console.log(
      ` ${String(c.n).padStart(2)} | ${c.shape.padEnd(10)} | ${cls.padEnd(10)} | ${c.query.padEnd(27)} | ` +
      `${String(total).padStart(5)} | ${(err ? "ERROR: " + err : top3.join(", ")).padEnd(47).slice(0, 47)} | ` +
      `${found.length}/${c.labeled.length}${miss.length ? "  miss: " + miss.join(",") : ""}`,
    );
  }

  console.log("-".repeat(124));
  console.log("\nRecall@3 — pooled (labeled scholars in top-3 / labeled scholars total):\n");
  let gFound = 0, gTotal = 0;
  for (const sh of SHAPES) {
    const { found, total } = perShape[sh];
    gFound += found; gTotal += total;
    const r3 = total ? (found / total).toFixed(3) : "n/a";
    console.log(`  ${sh.padEnd(12)} ${found}/${total} = ${r3}`);
  }
  console.log(`  ${"OVERALL".padEnd(12)} ${gFound}/${gTotal} = ${(gFound / gTotal).toFixed(3)}`);

  const meanRank = ranks.length
    ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2)
    : "n/a";
  console.log(
    `\n§3.3 secondary — mean rank of labeled scholars appearing on page 1: ${meanRank} (n=${ranks.length})`,
  );
  console.log(
    MODE === "v3"
      ? "\nv3 run. Gate: name-shape floor 0.95 (must clear #4 `wong`); topic 0.65 / dept 0.90 / hybrid 0.75 directional. Frozen legacy baseline = 0.16 (name 0.50 / topic 0.00 / dept 0.00 / hybrid 0.25)."
      : "\nFrozen §7 baseline (legacy). Name-shape floor is 0.95; topic 0.65 / dept 0.90 / hybrid 0.75 are directional.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
