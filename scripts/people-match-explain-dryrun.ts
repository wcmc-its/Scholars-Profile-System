/**
 * #702 — match-explainability coverage eval (the #307-pattern gate before
 * defaulting `SEARCH_PEOPLE_MATCH_EXPLAIN` on).
 *
 * Runs a set of topic queries through `searchPeople()` twice — once with #702
 * OFF, once ON — and reports, per query:
 *   - blank-card rate OFF vs ON (fraction of top-page results the card would
 *     render bare: no snippet, no pub snippet, no MeSH note, no chip), and
 *   - the ON composition (which element explains each non-blank card:
 *     self / pub / note / chip), and
 *   - whether the result ORDER is byte-identical OFF vs ON — the regression
 *     guard: #702 only widens the highlight request, so ranking MUST NOT move.
 *
 * Mirrors the route: classify the query, MeSH-resolve (with the #692 content
 * retry), force `SEARCH_GENERIC_TERM_DEMOTE=on` (the staging condition that
 * exposed the blank cards), and run `matchProvenance: true` on both passes so
 * the only variable is `matchExplain`.
 *
 * Bypasses HTTP — calls the same `searchPeople` the route does. Requires
 * OpenSearch up (`npm run db:up`) with a current `scholars-people` index.
 *
 * Run (host dev DB via the OS-user socket — memory/feedback_verify_db_target):
 *   DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
 *     npx tsx scripts/people-match-explain-dryrun.ts
 *
 * NOTE: locally the dev DB usually lacks `mesh_curated_alias`, so MeSH
 * resolution fails closed → the "note" column reads 0 and topic resolution is
 * absent. The pub-highlight + chip effect (the dominant blank-card lever) is
 * still faithful; the provenance-note contribution is additive and is what the
 * staging run adds on top.
 */
import { searchPeople } from "@/lib/api/search";
import { classifyPeopleQuery } from "@/lib/api/people-query-shape";
import { getPeopleClassifierSets } from "@/lib/api/people-classifier-sets";
import { resolveDeptLeadershipBoost } from "@/lib/api/search-flags";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { stripDeprioritized } from "@/lib/api/deprioritized-terms";
import { classifyHitExplain, type ExplainKind } from "@/lib/api/match-explain";

const QUERIES = [
  "microbiome research",
  "microbiome",
  "crispr",
  "immunotherapy",
  "machine learning",
  "cardiology",
  "single cell rna sequencing",
  "melanoma",
  "breast cancer",
];

type Sets = Awaited<ReturnType<typeof getPeopleClassifierSets>>;

async function resolveForQuery(q: string, sets: Sets) {
  const { contentQuery, removed } = stripDeprioritized(q);
  // The harness forces SEARCH_GENERIC_TERM_DEMOTE=on (the staging condition).
  const genericDemote = removed.length > 0;
  let taxonomy: Awaited<ReturnType<typeof matchQueryToTaxonomy>> | null = null;
  try {
    taxonomy = await matchQueryToTaxonomy(q);
    if (taxonomy.meshResolution == null && genericDemote) {
      const retry = await matchQueryToTaxonomy(contentQuery);
      if (retry.meshResolution != null) taxonomy = retry;
    }
  } catch {
    taxonomy = null; // getMeshMap fails closed (no mesh_curated_alias locally)
  }
  const shape = classifyPeopleQuery({
    query: q,
    meshResolved: taxonomy?.meshResolution != null,
    knownCwids: sets.cwids,
    knownSurnames: sets.surnames,
    knownDepartments: sets.departments,
  });
  return { shape, taxonomy, contentQuery, genericDemote };
}

function optsFor(
  q: string,
  r: Awaited<ReturnType<typeof resolveForQuery>>,
  matchExplain: boolean,
) {
  return {
    q,
    relevanceMode: "v3" as const,
    shape: r.shape,
    meshDescendantUis: r.taxonomy?.meshResolution?.descendantUis,
    meshDescriptorName: r.taxonomy?.meshResolution?.name,
    matchProvenance: true,
    matchExplain,
    deptLeadershipBoost: resolveDeptLeadershipBoost(),
    genericDemote: r.genericDemote,
    contentQuery: r.contentQuery,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

async function main() {
  const sets = await getPeopleClassifierSets();

  console.log("=== #702 People match-explainability coverage (SEARCH_PEOPLE_MATCH_EXPLAIN) ===");
  console.log("Both passes: SEARCH_PEOPLE_MATCH_PROVENANCE=on, SEARCH_GENERIC_TERM_DEMOTE=on.\n");
  console.log(
    " query                        |  n | blank OFF | blank ON | self pub note chip | order",
  );
  console.log("-".repeat(96));

  let gN = 0;
  let gBlankOff = 0;
  let gBlankOn = 0;
  const comp: Record<ExplainKind, number> = { self: 0, pub: 0, note: 0, chip: 0, blank: 0 };
  let orderStableAll = true;
  let resolvedCount = 0;

  for (const q of QUERIES) {
    const r = await resolveForQuery(q, sets);
    if (r.taxonomy?.meshResolution != null) resolvedCount++;
    let off, on;
    try {
      off = await searchPeople(optsFor(q, r, false));
      on = await searchPeople(optsFor(q, r, true));
    } catch (e) {
      console.log(
        ` ${q.padEnd(28)} | ERROR: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 60)}`,
      );
      orderStableAll = false;
      continue;
    }

    const n = on.hits.length;
    const blankOff = off.hits.filter((h) => !classifyHitExplain(h).nonBlank).length;
    const blankOn = on.hits.filter((h) => !classifyHitExplain(h).nonBlank).length;

    const local: Record<ExplainKind, number> = { self: 0, pub: 0, note: 0, chip: 0, blank: 0 };
    for (const h of on.hits) {
      const k = classifyHitExplain(h).primary;
      local[k]++;
      comp[k]++;
    }

    const orderStable =
      off.hits.length === on.hits.length &&
      off.hits.every((h, i) => h.slug === on.hits[i]?.slug);
    orderStableAll &&= orderStable;

    gN += n;
    gBlankOff += blankOff;
    gBlankOn += blankOn;

    console.log(
      ` ${q.padEnd(28)} | ${String(n).padStart(2)} | ` +
        `${pct(blankOff, off.hits.length)} (${String(blankOff).padStart(2)}) | ` +
        `${pct(blankOn, n)} (${String(blankOn).padStart(2)}) | ` +
        `${String(local.self).padStart(4)} ${String(local.pub).padStart(3)} ${String(local.note).padStart(4)} ${String(local.chip).padStart(4)} | ` +
        `${orderStable ? "same" : "MOVED"}`,
    );
  }

  console.log("-".repeat(96));
  console.log(
    `\nAggregate blank-card rate:  OFF ${pct(gBlankOff, gN)} (${gBlankOff}/${gN})   →   ON ${pct(gBlankOn, gN)} (${gBlankOn}/${gN})`,
  );
  console.log(
    `ON composition (primary explainer):  self=${comp.self}  pub=${comp.pub}  note=${comp.note}  chip=${comp.chip}  blank=${comp.blank}`,
  );
  console.log(
    `MeSH resolution: ${resolvedCount}/${QUERIES.length} queries resolved (note column is 0 when 0 — see header).`,
  );
  console.log(
    `\nGATE — ranking-regression guard (#702 is presentation-only): ${
      orderStableAll ? "PASS (order identical OFF vs ON on every query)" : "FAIL (a query reordered — investigate)"
    }`,
  );
  console.log(
    "GATE — coverage: blank ON must be well below blank OFF; remaining blanks are pure-subsumption hits that need SEARCH_PEOPLE_MATCH_PROVENANCE (note) which is dark without mesh_curated_alias locally.",
  );

  process.exit(orderStableAll ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
