/**
 * Build the OpenSearch people + publications indices from MySQL.
 *
 * In production this lives behind EventBridge, fired after the daily ETL chain
 * completes (decision #5 chain order: ED → ASMS → InfoEd → ReCiter → COI →
 * search-index). For the prototype, run on demand via `npm run search:index`.
 *
 * Key indexing decisions (spec lines 156-177):
 *   - Per-field boosts apply at QUERY time (multi_match), not at index time.
 *   - Authorship-weighted contributions (×1.0 / ×0.4 / ×0.1) apply at INDEX
 *     time via term repetition into the publication_titles and
 *     publication_mesh fields. We use the integer ratio 10:4:1.
 *   - Minimum-evidence threshold for MeSH terms: term contributes only if it
 *     appears in ≥2 of a scholar's publications OR in ≥1 first/last-author
 *     publication. Filters BEFORE emission.
 *   - Sparse-profile filter (spec line 196): scholars below the completeness
 *     threshold are still indexed (so name searches find them) but flagged
 *     `isComplete: false`. The query layer applies the filter for default
 *     browse-style searches.
 *   - Soft-deleted and suppressed scholars are NOT indexed (decision #4).
 *
 * Phase 4b C2 — the document shapes, the Prisma fetch constants, and the
 * pure helpers they depend on live in `lib/search-index-docs.ts`, shared
 * with the C5 suppression fast-path. This file owns the orchestration —
 * DB pagination, bulk writes, smoke assertions — and consults the builders
 * for the actual `_source` shape.
 */
import { prisma } from "../../lib/db";
import { coreProjectNum } from "@/lib/award-number";
import {
  loadAllGrantSuppressions,
  loadAllPublicationSuppressions,
} from "@/lib/api/manual-layer";
import { parseExternalId, projectFromRows } from "@/lib/funding-projection";
import {
  FUNDING_INDEX,
  PEOPLE_INDEX,
  PUBLICATIONS_INDEX,
  fundingIndexMapping,
  peopleIndexMapping,
  publicationsIndexMapping,
  searchClient,
} from "@/lib/search";
import {
  PEOPLE_INDEX_SELECT,
  PEOPLE_INDEX_WHERE,
  PUBLICATION_INDEX_INCLUDE,
  PUBLICATION_INDEX_WHERE,
  buildPeopleDoc,
  buildPublicationDoc,
} from "@/lib/search-index-docs";
import { rebuildAliasedIndex } from "./alias-swap";

// Rebuilds happen via the alias-swap pattern (B18, #117) -- see
// `./alias-swap.ts`. The three exported names in `lib/search.ts`
// (`scholars-people`, `scholars-publications`, `scholars-funding`) are
// aliases pointing at concrete versioned indices (`-v{N}`); each rebuild
// creates the next version, fills it, then atomically repoints the alias
// in a single OpenSearch `_aliases` call. Reads against the alias name
// transition between versions without a zero-result window.

// #485 — bulk-index one request body with retry/backoff on 429. The first real
// `search:index` run revealed two problems with the original
// `client.bulk({ refresh: true, body })` per-chunk pattern: (1) a synchronous
// refresh after every 500-doc chunk is needlessly expensive, and (2) on a small
// single-node domain it (plus AWS's throttling of burstable instance types)
// returns 429 "Too Many Requests" with no recovery, aborting the whole build.
// This helper drops the per-chunk refresh (callers refresh once at the end) and
// retries the chunk with exponential backoff on a 429 — whether the throttle
// surfaces as a thrown transport error or as per-item `status: 429`. Index ops
// carry explicit `_id`s, so re-sending a chunk is idempotent.
async function bulkIndex(
  client: ReturnType<typeof searchClient>,
  body: Record<string, unknown>[],
  label: string,
): Promise<void> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; ; attempt++) {
    const backoff = () =>
      new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
    let resp;
    try {
      resp = await client.bulk({ body });
    } catch (err) {
      const status =
        (err as { meta?: { statusCode?: number } })?.meta?.statusCode ??
        (err as { statusCode?: number })?.statusCode;
      if (status === 429 && attempt < MAX_ATTEMPTS) {
        console.log(
          `  ...429 on ${label} bulk; backing off (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await backoff();
        continue;
      }
      throw err;
    }
    if (resp.body.errors) {
      const items = resp.body.items as Array<{
        index?: { status?: number; error?: unknown };
      }>;
      const hardError = items.find(
        (it) => it.index?.error && it.index?.status !== 429,
      );
      if (hardError) {
        throw new Error(
          `${label} bulk indexing had errors: ${JSON.stringify(hardError, null, 2)}`,
        );
      }
      // Only 429s remain — retry the whole (idempotent) chunk.
      if (attempt < MAX_ATTEMPTS) {
        console.log(
          `  ...429 (per-item) on ${label} bulk; backing off (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await backoff();
        continue;
      }
      throw new Error(
        `${label} bulk indexing throttled (429) after ${MAX_ATTEMPTS} retries`,
      );
    }
    return;
  }
}

async function indexPeople(concreteIndex: string) {
  const client = searchClient();
  // Phase 4b C4 — load the active publication-suppression set once per run
  // (same contract as the indexPublications load — see comment there).
  const sup = await loadAllPublicationSuppressions(prisma);
  const scholars = await prisma.scholar.findMany({
    where: PEOPLE_INDEX_WHERE,
    select: PEOPLE_INDEX_SELECT,
  });

  // Phase 4b C2 alignment — `buildPeopleDoc` now queries each scholar's
  // `centerMembership` rows itself via the passed-in client (D4b.3 sidecar
  // model). The prior whole-table `centerCodesByCwid` preload is dropped:
  // the batch trades one preload for N small indexed queries (one per
  // scholar) in exchange for the fast-path getting the one-cwid variant
  // naturally and for `buildPeopleDoc`'s extra-data surface being fully
  // closed-over by `(s, client, sup)`.
  const docs: Array<{ cwid: string; doc: Record<string, unknown> }> = [];
  for (const s of scholars) {
    const doc = await buildPeopleDoc(s, prisma, sup);
    if (doc !== null) docs.push({ cwid: s.cwid, doc });
  }

  if (docs.length === 0) return 0;

  // Bulk index in chunks to stay under OpenSearch's 10 MB request limit.
  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const body: Record<string, unknown>[] = [];
    for (const { cwid, doc } of chunk) {
      body.push({ index: { _index: concreteIndex, _id: cwid } });
      body.push(doc);
    }
    await bulkIndex(client, body, "People");
    console.log(`  ...indexed ${Math.min(i + CHUNK, docs.length)}/${docs.length} people`);
  }
  // #485 — refresh once after the full load (was per-chunk refresh:true).
  await client.indices.refresh({ index: concreteIndex });
  return docs.length;
}

async function indexPublications(concreteIndex: string) {
  const client = searchClient();
  // Phase 4b C3 — load the active publication-suppression set once per run.
  // `loadAllPublicationSuppressions` is whole-table by contract
  // (lib/api/manual-layer.ts); the build is a single batch over the corpus
  // with no per-request staleness concern, so reading the whole `suppression`
  // table here is correct — and explicitly fenced from the per-request path.
  const sup = await loadAllPublicationSuppressions(prisma);
  const PUB_PAGE = 2000;
  let cursor: string | undefined;
  let totalIndexed = 0;

  for (;;) {
    // Only publications that have at least one ACTIVE WCM author with a
    // confirmed authorship — matches the spec's authorship-confirmation
    // logic. The publicationType filter (Retraction / Erratum exclusion,
    // issue #63) is in PUBLICATION_INDEX_WHERE; the include shape (authors
    // + publicationTopics) is in PUBLICATION_INDEX_INCLUDE.
    const pubs = await prisma.publication.findMany({
      take: PUB_PAGE,
      ...(cursor ? { skip: 1, cursor: { pmid: cursor } } : {}),
      orderBy: { pmid: "asc" },
      where: PUBLICATION_INDEX_WHERE,
      include: PUBLICATION_INDEX_INCLUDE,
    });

    if (pubs.length === 0) break;
    cursor = pubs[pubs.length - 1].pmid;

    const docs: Array<{ pmid: string; doc: Record<string, unknown> }> = [];
    for (const p of pubs) {
      const doc = buildPublicationDoc(p, sup);
      if (doc !== null) docs.push({ pmid: p.pmid, doc });
    }

    if (docs.length === 0) {
      if (pubs.length < PUB_PAGE) break;
      continue;
    }

    // Bulk index this page's docs in 500-doc chunks.
    const CHUNK = 500;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      const body: Record<string, unknown>[] = [];
      for (const { pmid, doc } of chunk) {
        body.push({ index: { _index: concreteIndex, _id: pmid } });
        body.push(doc);
      }
      await bulkIndex(client, body, "Publications");
    }
    totalIndexed += docs.length;
    console.log(`  ...indexed ${totalIndexed} publications so far`);
    if (pubs.length < PUB_PAGE) break;
  }
  // #485 — refresh once after the full load (was per-chunk refresh:true).
  await client.indices.refresh({ index: concreteIndex });
  return totalIndexed;
}

async function indexFunding(concreteIndex: string) {
  const client = searchClient();
  // #160 — active grant suppressions (whole-table batch load). A suppressed
  // grant row is one investigator's role; dropping it here removes that person
  // from the project's people / wcmInvestigatorCwids projection, and a project
  // with no surviving rows never forms a group below (-> dark, never indexed).
  const suppressedGrants = await loadAllGrantSuppressions(prisma);
  const rows = await prisma.grant.findMany({
    where: { scholar: { deletedAt: null, status: "active" } },
    select: {
      cwid: true,
      externalId: true,
      title: true,
      role: true,
      startDate: true,
      endDate: true,
      awardNumber: true,
      programType: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      directSponsor: true,
      directSponsorRaw: true,
      mechanism: true,
      nihIc: true,
      isSubaward: true,
      // Issue #86 — pulled into the OpenSearch funding doc for sort
      // (pubCount), full-text relevance (abstract), and the inline
      // publications-expand UX on result rows.
      abstract: true,
      abstractSource: true,
      applId: true,
      // Issue #291 — RePORTER project keywords, indexed as a topical signal.
      keywords: true,
      // Issue #295 — RePORTER keywords resolved to NLM MeSH descriptor UIs.
      meshDescriptorUis: true,
      publications: {
        select: {
          pmid: true,
          sourceReporter: true,
          sourceReciterdb: true,
          reciterdbFirstSeen: true,
          publication: {
            select: {
              title: true,
              journal: true,
              year: true,
              citationCount: true,
            },
          },
        },
      },
      scholar: {
        select: {
          slug: true,
          preferredName: true,
          primaryDepartment: true,
        },
      },
    },
  });

  // Group key: coreProjectNum when available, else Account_Number.
  // InfoEd sometimes splits one NIH award across multiple Account_Numbers
  // (rebookings, supplements, administrative continuations); coreProjectNum
  // collapses those into one search result. Non-NIH grants fall back to
  // Account_Number since they have no coreProjectNum.
  const byProject = new Map<string, typeof rows>();
  for (const r of rows) {
    // #160 — drop a suppressed grant role before grouping/projection.
    if (r.externalId && suppressedGrants.has(r.externalId)) continue;
    const ext = parseExternalId(r.externalId);
    if (!ext) continue;
    const key = coreProjectNum(r.awardNumber) ?? ext.accountNumber;
    const arr = byProject.get(key) ?? [];
    arr.push(r);
    byProject.set(key, arr);
  }

  const docs: Array<{ projectId: string; doc: Record<string, unknown> }> = [];
  for (const [key, projectRows] of byProject.entries()) {
    const doc = projectFromRows(projectRows);
    if (!doc) continue;
    // Override projectId to the grouping key so the OpenSearch _id stays
    // stable across re-indexes even when the order of merged
    // Account_Numbers under one coreProjectNum changes.
    doc.projectId = key;
    docs.push({ projectId: key, doc: doc as unknown as Record<string, unknown> });
  }

  if (docs.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const body: Record<string, unknown>[] = [];
    for (const { projectId, doc } of chunk) {
      body.push({ index: { _index: concreteIndex, _id: projectId } });
      body.push(doc);
    }
    await bulkIndex(client, body, "Funding");
    console.log(`  ...indexed ${Math.min(i + CHUNK, docs.length)}/${docs.length} funding projects`);
  }
  // #485 — refresh once after the full load (was per-chunk refresh:true).
  await client.indices.refresh({ index: concreteIndex });
  return docs.length;
}

type SourceType = "people" | "publications" | "funding";

function parseSelected(argv: string[]): Set<SourceType> {
  const all: SourceType[] = ["people", "publications", "funding"];
  const flagMap: Record<string, SourceType> = {
    "--people-only": "people",
    "--publications-only": "publications",
    "--funding-only": "funding",
  };
  const selected = new Set<SourceType>();
  for (const arg of argv) {
    if (arg in flagMap) selected.add(flagMap[arg]);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx etl/search-index/index.ts [--people-only] [--publications-only] [--funding-only]\n" +
          "  Flags are additive; pass none to (re)index all three sources.\n" +
          "  Each selected source has its index dropped and recreated; unselected indices are left alone.",
      );
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  if (selected.size === 0) for (const s of all) selected.add(s);
  return selected;
}

/**
 * Issue #275 — post-indexing smoke assertions.
 *
 * These run after each selected source finishes bulk-loading. The bar is
 * "would this have caught the all-empty-meshTerms regression that shipped
 * silently in #278?" — not full data validation. Each assertion is a
 * single count query against OpenSearch (cheap, ~ms), and each one names
 * a specific invariant that, if it fails, points the operator at the
 * code path that broke it.
 *
 * Strict failure: any assertion that fails throws. The ETL exits non-zero
 * and a downstream EventBridge alarm fires. Soft warnings (e.g. coverage
 * below an expected band) are stderr-only and DO NOT fail the run; a hard
 * failure should always mean "the index is unusable" so on-call doesn't
 * learn to ignore the alarm.
 */
async function assertPeopleIndexHealth(
  client: ReturnType<typeof searchClient>,
): Promise<void> {
  const total = await client.count({ index: PEOPLE_INDEX });
  if (total.body.count === 0) {
    throw new Error("[smoke] scholars-people index is empty after indexPeople()");
  }

  // publicationMesh is the people-side rollup of joined Publication.meshTerms.
  // Pre-#278 it was always "" across every doc because extractMeshLabels
  // didn't exist; the {ui,label} object rows were dropped before join.
  // We probe with a `match_phrase` against a content descriptor that's
  // dense in this corpus — "Neoplasms" parallels the publications-side
  // smoke below — instead of negating an empty term query, which doesn't
  // behave as expected on analyzed text fields (a `term: {field: ""}`
  // clause matches nothing, so the must_not would mark every doc as a
  // hit). MeSH check-tags (Humans, Male, Female, Adult, ...) are filtered
  // upstream by ReciterDB and don't appear in this field — see #292.
  const withMesh = await client.count({
    index: PEOPLE_INDEX,
    body: { query: { match_phrase: { publicationMesh: "Neoplasms" } } },
  });
  if (withMesh.body.count === 0) {
    throw new Error(
      "[smoke] scholars-people: no scholar's publicationMesh contains \"Neoplasms\" — extractMeshLabels regression suspected (see #278)",
    );
  }
}

async function assertPublicationsIndexHealth(
  client: ReturnType<typeof searchClient>,
): Promise<void> {
  const total = await client.count({ index: PUBLICATIONS_INDEX });
  if (total.body.count === 0) {
    throw new Error("[smoke] scholars-publications index is empty after indexPublications()");
  }

  // "Neoplasms" is the most heavily-tagged MeSH descriptor in any
  // biomedical corpus we'd ever load. Zero hits means the indexer dropped
  // the meshTerms field on every doc — the exact silent-regression mode
  // from #278.
  const meshHit = await client.count({
    index: PUBLICATIONS_INDEX,
    body: { query: { match_phrase: { meshTerms: "Neoplasms" } } },
  });
  if (meshHit.body.count === 0) {
    throw new Error(
      `[smoke] scholars-publications: match_phrase: meshTerms = "Neoplasms" returned 0 ` +
        `across ${total.body.count} docs — meshTerms regression suspected (see #278)`,
    );
  }

  // Issue #259 — MeSH defaults rebalance. The same regression class as #278
  // applies to the UI extractor: a future code change to the JSON column shape
  // (or to `extractMeshDescriptorUis`) could silently zero out the new field
  // on every doc. Smoke against D001943 (Breast Neoplasms), the densest
  // content descriptor in the WCM corpus (~4.5k indexed pubs). The earlier
  // smoke targeted D006801 ("Humans") assuming PubMed-average tag density
  // (~60%), but MeSH check-tags (Humans, Male, Female, Adult, ...) are
  // filtered upstream by ReciterDB and never enter this pipeline — see
  // #292. The 2,500 floor gives ~45% headroom on the current count and
  // catches any regression that drops the field on more than ~half the docs.
  const meshUiSmoke = await client.search({
    index: PUBLICATIONS_INDEX,
    body: { query: { term: { meshDescriptorUi: "D001943" } } },
    size: 0,
  });
  if ((meshUiSmoke.body.hits.total as { value: number }).value < 2_500) {
    throw new Error(
      `[smoke] scholars-publications: term: meshDescriptorUi = "D001943" returned ` +
        `${(meshUiSmoke.body.hits.total as { value: number }).value} hits ` +
        `(expected > 2,500) — extractMeshDescriptorUis regression suspected (see SPEC §5.4.1)`,
    );
  }

  // reciterParentTopicId is the #259 §1.6 OR-of-evidence anchor field.
  // Omit-on-empty per `buildReciterParentTopicIdField`: docs with no
  // topic rows shouldn't carry the field. A healthy index has it on at
  // least one publication.
  const withTopicId = await client.count({
    index: PUBLICATIONS_INDEX,
    body: { query: { exists: { field: "reciterParentTopicId" } } },
  });
  if (withTopicId.body.count === 0) {
    throw new Error(
      "[smoke] scholars-publications: no doc carries reciterParentTopicId — §1.6 OR-of-evidence path is dead",
    );
  }
}

async function assertFundingIndexHealth(
  client: ReturnType<typeof searchClient>,
): Promise<void> {
  const total = await client.count({ index: FUNDING_INDEX });
  if (total.body.count === 0) {
    throw new Error("[smoke] scholars-funding index is empty after indexFunding()");
  }

  // Issue #291 — keyword-coverage check. A soft warning, not a throw:
  // `grant.keywords` is populated only after ReCiterDB's retrieveReporter.py
  // captures the term columns (cross-repo — issue #291 PR A) and the reporter
  // ETL re-runs against the refreshed reciterdb. Until that pipeline is live,
  // 0 docs carry keywords and that is expected — warn so the signal is visible
  // without bricking the index build. Promote to a throw once keyword data is
  // established (cf. the meshTerms hard assertion on the publications index).
  const withKeywords = await client.count({
    index: FUNDING_INDEX,
    body: { query: { exists: { field: "keywords" } } },
  });
  if (withKeywords.body.count === 0) {
    console.warn(
      `[smoke] scholars-funding: 0/${total.body.count} docs carry keywords — ` +
        `expected until issue #291's RePORTER term pipeline is live`,
    );
  } else {
    console.log(
      `[smoke] scholars-funding: ${withKeywords.body.count}/${total.body.count} docs carry keywords`,
    );
  }

  // Issue #295 — meshDescriptorUi coverage. Soft warning, same rationale as
  // the keyword check above: the field populates only after the reporter
  // ETL's MeSH resolution pass (step 3) runs and the funding index is
  // rebuilt. Promote to a throw once a green resolver + reindex cycle is
  // established (cf. the meshTerms hard assertion on the publications index).
  const withMeshUi = await client.count({
    index: FUNDING_INDEX,
    body: { query: { exists: { field: "meshDescriptorUi" } } },
  });
  if (withMeshUi.body.count === 0) {
    console.warn(
      `[smoke] scholars-funding: 0/${total.body.count} docs carry meshDescriptorUi — ` +
        `expected until issue #295's MeSH resolution pass has run + reindexed`,
    );
  } else {
    console.log(
      `[smoke] scholars-funding: ${withMeshUi.body.count}/${total.body.count} docs carry meshDescriptorUi`,
    );
  }
}

async function main() {
  const selected = parseSelected(process.argv.slice(2));
  const counts: Partial<Record<SourceType, number>> = {};

  const client = searchClient();

  if (selected.has("people")) {
    console.log(`Rebuilding ${PEOPLE_INDEX} via alias swap...`);
    const { docsIndexed, newIndex, deleted } = await rebuildAliasedIndex({
      client,
      alias: PEOPLE_INDEX,
      mapping: peopleIndexMapping,
      fillFn: indexPeople,
    });
    counts.people = docsIndexed;
    console.log(
      `  ...swapped ${PEOPLE_INDEX} -> ${newIndex}` +
        (deleted.length > 0 ? ` (pruned ${deleted.join(", ")})` : ""),
    );
  }

  if (selected.has("publications")) {
    console.log(`Rebuilding ${PUBLICATIONS_INDEX} via alias swap...`);
    const { docsIndexed, newIndex, deleted } = await rebuildAliasedIndex({
      client,
      alias: PUBLICATIONS_INDEX,
      mapping: publicationsIndexMapping,
      fillFn: indexPublications,
    });
    counts.publications = docsIndexed;
    console.log(
      `  ...swapped ${PUBLICATIONS_INDEX} -> ${newIndex}` +
        (deleted.length > 0 ? ` (pruned ${deleted.join(", ")})` : ""),
    );
  }

  if (selected.has("funding")) {
    console.log(`Rebuilding ${FUNDING_INDEX} via alias swap...`);
    const { docsIndexed, newIndex, deleted } = await rebuildAliasedIndex({
      client,
      alias: FUNDING_INDEX,
      mapping: fundingIndexMapping,
      fillFn: indexFunding,
    });
    counts.funding = docsIndexed;
    console.log(
      `  ...swapped ${FUNDING_INDEX} -> ${newIndex}` +
        (deleted.length > 0 ? ` (pruned ${deleted.join(", ")})` : ""),
    );
  }

  console.log("Running smoke checks...");
  if (selected.has("people")) await assertPeopleIndexHealth(client);
  if (selected.has("publications")) await assertPublicationsIndexHealth(client);
  if (selected.has("funding")) await assertFundingIndexHealth(client);
  console.log("Smoke checks passed.");

  const parts: string[] = [];
  if (counts.people !== undefined) parts.push(`${counts.people} scholars`);
  if (counts.publications !== undefined) parts.push(`${counts.publications} publications`);
  if (counts.funding !== undefined) parts.push(`${counts.funding} funding projects`);
  console.log(`Indexed ${parts.join(", ")}.`);
}

// Run the indexer only when this file is executed as a script — never when
// it is imported. The pure helpers now live in `lib/search-index-docs.ts`
// (Phase 4b C2) — they were previously exported from this module solely
// for unit tests, which triggered `main()` inside the vitest worker if the
// guard wasn't in place. The guard stays because this file remains a script
// entry point (`npm run search:index` → `tsx etl/search-index/index.ts`).
if (!process.env.VITEST) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
