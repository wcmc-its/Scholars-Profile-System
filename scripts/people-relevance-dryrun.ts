/**
 * #362 — provisional §4 Recall@3 dry-run for the People-relevance baseline.
 *
 * Runs the §3.1 candidate labeled set (docs/people-relevance-baseline.md §6)
 * through `searchPeople()` under the current ("legacy") ranking and reports
 * Recall@3 per query shape. Bypasses the HTTP/route layer — calls the same
 * `searchPeople` the route does, so the ranking is faithful.
 *
 * PROVISIONAL: the labeled set is not frozen. This is a sanity check, not the
 * signed-off §4 baseline (that is the eval owner's, per #362).
 *
 * Run (host dev DB reached via the OS-user socket — see
 * memory/feedback_verify_db_target):
 *   DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
 *     npx tsx scripts/people-relevance-dryrun.ts
 */
import { searchPeople } from "@/lib/api/search";

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

async function main() {
  const perShape: Record<Shape, { found: number; total: number }> = {
    name: { found: 0, total: 0 }, topic: { found: 0, total: 0 },
    department: { found: 0, total: 0 }, hybrid: { found: 0, total: 0 },
  };
  const ranks: number[] = [];

  console.log("=== #362 People-relevance §4 Recall@3 dry-run (PROVISIONAL — legacy ranking) ===\n");
  console.log(
    " # | shape      | query                       | total | top-3 result slugs                              | hit",
  );
  console.log("-".repeat(124));

  for (const c of CASES) {
    let top3: string[] = [];
    let allHits: string[] = [];
    let total = 0;
    let err = "";
    try {
      const r = await searchPeople({ q: c.query });
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
      ` ${String(c.n).padStart(2)} | ${c.shape.padEnd(10)} | ${c.query.padEnd(27)} | ` +
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
    "\nProvisional: labeled set unfrozen. Name-shape floor is 0.95; topic 0.65 / dept 0.90 / hybrid 0.75 are directional.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
