/**
 * #807 — Concept-scope count-reconciliation audit.
 *
 * Quantifies WHY the "Scholars" tab badge and the Publications-tab "Author"
 * facet disagree under `?match=concept`. The two counts are not a bug — they
 * answer different questions on different indices with different fields:
 *
 *   - Scholars badge (N) = scholars whose OWN aggregated corpus concept-matches
 *       (people index, `terms { publicationMeshUi: descendantUis }` — the gate
 *       at lib/api/search.ts:977-978).
 *   - Author facet   (M) = distinct displayable WCM authors of the matched
 *       publications (pub index, `cardinality` over `wcmAuthorCwids` on the
 *       meshTerms/anchor-matched pubs — lib/api/search.ts:2312-2316, read :2584).
 *
 * This replicates the STRICT concept admission (`concept_filtered` when the
 * descriptor has curated ReciterAI anchors, else `concept_fallback`;
 * `concept_expanded` is a different branch and out of scope) and reports the
 * true SET RELATIONSHIP — crucially NOT assuming the two sets nest. A scholar
 * can concept-match on their broader corpus without authoring any of THESE
 * matched pubs (C\A), and a matched-pub co-author need not be a concept-scholar
 * (A\C). #807 confirmed neither set is a subset of the other, so "N of the M"
 * framing would be wrong.
 *
 * Numbers are FLUID: the local index is post-#718 re-ETL, reflects #806 alumni
 * soft-deletes, but NOT #804 (`SEARCH_REQUIRE_DISPLAYABLE_AUTHOR` off /
 * reindex-then-flip). Report mechanism + ratio, not literals. Re-baseline the
 * true "after" on a staging/prod index built with the flag on.
 *
 * Requires OpenSearch up (`npm run db:up`) + the dev DB (the MeSH resolver
 * loads its map from Prisma — see memory/feedback_verify_db_target). Run:
 *   DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
 *     npx tsx scripts/audit-807-concept-gap.ts crispr
 */
import { prisma } from "@/lib/db";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { searchClient, PEOPLE_INDEX, PUBLICATIONS_INDEX } from "@/lib/search";

// Above any single-concept author count (largest concepts are ~1.6k authors);
// keeps the author CWID enumeration complete so A\C is exact, not sampled.
const AUTHOR_AGG_CAP = 5000;
const SAMPLE = 15;

type OsCount = { hits: { total: { value: number } } };
type PubAgg = {
  hits: { total: { value: number } };
  aggregations: {
    authors: { buckets: { key: string; doc_count: number }[] };
    distinct: { value: number };
  };
};
type PeopleHits = { hits: { hits: { _source: { cwid: string } }[]; total: { value: number } } };

const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : "—");

async function main() {
  const q = process.argv.slice(2).join(" ").trim() || "crispr";
  const taxonomy = await matchQueryToTaxonomy(q);
  const res = taxonomy.meshResolution;
  if (!res) {
    console.error(
      `No MeSH descriptor resolved for "${q}". Concept scope would not gate — ` +
        `pick a concept term (crispr, melanoma, immunology…).`,
    );
    process.exit(1);
    return;
  }
  const uis = res.descendantUis;
  const anchors = res.curatedTopicAnchors;
  const queryShape = anchors.length > 0 ? "concept_filtered" : "concept_fallback";
  const client = searchClient();

  // (A) matched concept pubs + distinct displayable WCM authors (the "M").
  // Mirrors the searchPublications concept admission: match_phrase{meshTerms}
  // (Path A) OR terms{reciterParentTopicId: anchors} (Path B), msm:1.
  const should: Record<string, unknown>[] = [{ match_phrase: { meshTerms: { query: res.name } } }];
  if (anchors.length > 0) should.push({ terms: { reciterParentTopicId: anchors } });
  const pubResp = await client.search({
    index: PUBLICATIONS_INDEX,
    body: {
      size: 0,
      track_total_hits: true,
      query: { bool: { should, minimum_should_match: 1 } },
      aggs: {
        authors: { terms: { field: "wcmAuthorCwids", size: AUTHOR_AGG_CAP } },
        distinct: { cardinality: { field: "wcmAuthorCwids", precision_threshold: 4000 } },
      },
    },
  });
  const pub = pubResp.body as unknown as PubAgg;
  const pubsMatched = pub.hits.total.value;
  const authorCwids = pub.aggregations.authors.buckets.map((b) => b.key);
  const authorsDistinct = pub.aggregations.distinct.value;

  // (C) concept-scholar universe (the "N"): scholars whose own corpus matches.
  const universeResp = await client.search({
    index: PEOPLE_INDEX,
    body: { size: 0, track_total_hits: true, query: { terms: { publicationMeshUi: uis } } },
  });
  const conceptScholars = (universeResp.body as unknown as OsCount).hits.total.value;

  // (B) overlap A∩C: matched-pub authors who ALSO pass the people concept gate.
  let overlapCwids: string[] = [];
  if (authorCwids.length > 0) {
    const overlapResp = await client.search({
      index: PEOPLE_INDEX,
      body: {
        size: AUTHOR_AGG_CAP,
        _source: ["cwid"],
        track_total_hits: true,
        query: {
          bool: {
            filter: [{ terms: { cwid: authorCwids } }, { terms: { publicationMeshUi: uis } }],
          },
        },
      },
    });
    overlapCwids = (overlapResp.body as unknown as PeopleHits).hits.hits.map((h) => h._source.cwid);
  }
  const overlapSet = new Set(overlapCwids);
  const overlap = overlapSet.size;
  const coAuthorsNotScholars = authorCwids.filter((c) => !overlapSet.has(c)); // A\C
  const conceptScholarsNotAuthors = conceptScholars - overlap; // C\A (count only)

  // Hydrate a sample of A\C (co-authors who are NOT concept-scholars) — the
  // dominant gap component — so the result is eyeball-able. Guarded so a
  // schema/field drift degrades to CWID-only output rather than crashing.
  const sample = coAuthorsNotScholars.slice(0, SAMPLE);
  let nameByCwid = new Map<string, string>();
  if (sample.length) {
    try {
      const rows = await prisma.scholar.findMany({
        where: { cwid: { in: sample } },
        select: { cwid: true, preferredName: true },
      });
      nameByCwid = new Map(rows.map((s) => [s.cwid, s.preferredName]));
    } catch (e) {
      console.warn(`  (name hydration skipped: ${(e as Error).message})`);
    }
  }

  console.log(`\n#807 concept-count gap audit — query "${q}"`);
  console.log(
    `  resolved descriptor : ${res.name} (${res.descriptorUi}, ${res.confidence}` +
      `${res.ambiguous ? ", AMBIGUOUS" : ""})`,
  );
  console.log(
    `  descendant UIs      : ${uis.length}   curated anchors: ${anchors.length}` +
      `   → queryShape: ${queryShape}`,
  );
  console.log(`  matched publications: ${pubsMatched.toLocaleString()}`);
  console.log("");
  console.log(`  Author facet  (M) — distinct displayable WCM authors of matched pubs : ${authorsDistinct.toLocaleString()}`);
  console.log(`  Scholars tab  (N) — scholars whose OWN corpus concept-matches        : ${conceptScholars.toLocaleString()}`);
  if (authorCwids.length !== authorsDistinct) {
    console.log(
      `  (note: enumerated ${authorCwids.length} author CWIDs vs cardinality ${authorsDistinct} — ` +
        `agg cap ${AUTHOR_AGG_CAP} hit or cardinality estimate; A\\C below is over the enumerated set)`,
    );
  }
  console.log("");
  console.log(`  Set relationship (NOT nested — neither is a subset of the other):`);
  console.log(`    A∩C  authors of matched pubs who ARE concept-scholars : ${overlap}`);
  console.log(
    `    A\\C  co-authors who are NOT concept-scholars          : ${coAuthorsNotScholars.length}` +
      `  (${pct(coAuthorsNotScholars.length, authorCwids.length)} of matched-pub authors)`,
  );
  console.log(
    `    C\\A  concept-scholars who did NOT author these pubs   : ${conceptScholarsNotAuthors}` +
      `  (${pct(conceptScholarsNotAuthors, conceptScholars)} of concept-scholars)`,
  );
  console.log("");
  console.log(`  Sample of A\\C (co-author, not a concept-scholar — the dominant gap):`);
  if (!sample.length) console.log(`    (none)`);
  for (const c of sample) console.log(`    ${c}  ${nameByCwid.get(c) ?? "(name n/a)"}`);
  console.log("");
  console.log(`  Caveats: numbers are fluid (post-#718 re-ETL); the local index reflects #806`);
  console.log(`  alumni soft-deletes but NOT #804 (SEARCH_REQUIRE_DISPLAYABLE_AUTHOR off,`);
  console.log(`  reindex-then-flip). The facet headline (M) is index-side cardinality, NOT`);
  console.log(`  re-filtered against live Scholar status — the rendered chip list can be`);
  console.log(`  smaller. Report mechanism + ratio, not literals.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
