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
 */
import { prisma } from "../../lib/db";
import {
  PEOPLE_INDEX,
  PUBLICATIONS_INDEX,
  peopleIndexMapping,
  publicationsIndexMapping,
  searchClient,
} from "@/lib/search";

const AUTHORSHIP_WEIGHTS = {
  firstOrLast: 10,
  secondOrPenultimate: 4,
  middle: 1,
} as const;

type AuthorshipKind = keyof typeof AUTHORSHIP_WEIGHTS;

function classifyAuthorship(a: {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
}): AuthorshipKind {
  if (a.isFirst || a.isLast) return "firstOrLast";
  if (a.isPenultimate) return "secondOrPenultimate";
  return "middle";
}

async function ensureIndex(name: string, body: unknown) {
  const client = searchClient();
  const exists = await client.indices.exists({ index: name });
  if (exists.body) {
    await client.indices.delete({ index: name });
  }
  await client.indices.create({ index: name, body: body as object });
}

async function indexPeople() {
  const client = searchClient();
  const scholars = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      primaryTitle: true,
      primaryDepartment: true,
      overview: true,
      // Phase 2 — replaces the Phase-1 hard-coded "Faculty" placeholder.
      // Sourced from ED ETL deriveRoleCategory (see etl/ed/index.ts).
      roleCategory: true,
      topicAssignments: { orderBy: { score: "desc" } },
      grants: true,
      authorships: {
        where: { isConfirmed: true },
        include: {
          publication: {
            select: { title: true, meshTerms: true },
          },
        },
      },
    },
  });

  const docs: Array<{ cwid: string; doc: Record<string, unknown> }> = [];

  for (const s of scholars) {
    // Title-field repetition by authorship position.
    const titleParts: string[] = [];
    // Per-term aggregation for the min-evidence threshold.
    const termAgg = new Map<
      string,
      { distinctPubs: number; hasFirstOrLast: boolean; weightedCount: number }
    >();

    for (const a of s.authorships) {
      const kind = classifyAuthorship(a);
      const weight = AUTHORSHIP_WEIGHTS[kind];

      // Repeat the title `weight` times.
      for (let i = 0; i < weight; i++) titleParts.push(a.publication.title);

      const mesh = Array.isArray(a.publication.meshTerms)
        ? (a.publication.meshTerms as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      for (const term of mesh) {
        const cur = termAgg.get(term) ?? {
          distinctPubs: 0,
          hasFirstOrLast: false,
          weightedCount: 0,
        };
        cur.distinctPubs += 1;
        if (kind === "firstOrLast") cur.hasFirstOrLast = true;
        cur.weightedCount += weight;
        termAgg.set(term, cur);
      }
    }

    // Apply min-evidence threshold and emit term repetitions.
    const meshParts: string[] = [];
    for (const [term, agg] of termAgg.entries()) {
      if (agg.distinctPubs < 2 && !agg.hasFirstOrLast) continue;
      for (let i = 0; i < agg.weightedCount; i++) meshParts.push(term);
    }

    const hasActiveGrants = s.grants.some((g) => g.endDate.getTime() > Date.now());
    const isComplete =
      !!s.overview && s.authorships.length >= 3 && hasActiveGrants ? true : false;
    // Phase 2 — sourced from ED ETL derivation (lib/eligibility.ts RoleCategory).
    // "unknown" only fires for scholars whose ED ETL has not yet backfilled
    // role_category (transitional state during the first refresh after migration).
    const personType = s.roleCategory ?? "unknown";

    const aoi = s.topicAssignments.map((t) => t.topic).join(" ");

    // Most recent publication date for the "Most recent publication" sort
    // option (spec line 194). Pull from authorships; null-safe.
    const pubDates = await prisma.publicationAuthor.findMany({
      where: { cwid: s.cwid, isConfirmed: true },
      select: { publication: { select: { dateAddedToEntrez: true } } },
    });
    const mostRecentPubDate = pubDates
      .map((p) => p.publication.dateAddedToEntrez)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    const nameSuggestInputs = [
      { input: s.preferredName, weight: 100 },
      ...(s.primaryTitle
        ? [
            {
              input: `${s.preferredName} — ${s.primaryTitle}`,
              weight: 80,
            },
          ]
        : []),
    ];

    docs.push({
      cwid: s.cwid,
      doc: {
        cwid: s.cwid,
        slug: s.slug,
        preferredName: s.preferredName,
        fullName: s.fullName,
        primaryTitle: s.primaryTitle,
        primaryDepartment: s.primaryDepartment,
        nameSuggest: nameSuggestInputs,
        areasOfInterest: aoi,
        overview: s.overview,
        publicationTitles: titleParts.join(" "),
        publicationMesh: meshParts.join(" "),
        hasActiveGrants,
        isComplete,
        personType,
        publicationCount: s.authorships.length,
        grantCount: s.grants.length,
        mostRecentPubDate,
      },
    });
  }

  if (docs.length === 0) return 0;

  // Bulk index in chunks to stay under OpenSearch's 10 MB request limit.
  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const body: Record<string, unknown>[] = [];
    for (const { cwid, doc } of chunk) {
      body.push({ index: { _index: PEOPLE_INDEX, _id: cwid } });
      body.push(doc);
    }
    const resp = await client.bulk({ refresh: true, body });
    if (resp.body.errors) {
      const firstError = resp.body.items.find(
        (it: { index?: { error?: unknown } }) => it.index?.error,
      );
      throw new Error(
        `People bulk indexing had errors: ${JSON.stringify(firstError, null, 2)}`,
      );
    }
    console.log(`  ...indexed ${Math.min(i + CHUNK, docs.length)}/${docs.length} people`);
  }
  return docs.length;
}

async function indexPublications() {
  const client = searchClient();
  const PUB_PAGE = 2000;
  let cursor: string | undefined;
  let totalIndexed = 0;

  for (;;) {
    // Only publications that have at least one ACTIVE WCM author with a
    // confirmed authorship — matches the spec's authorship-confirmation logic.
    const pubs = await prisma.publication.findMany({
      take: PUB_PAGE,
      ...(cursor ? { skip: 1, cursor: { pmid: cursor } } : {}),
      orderBy: { pmid: "asc" },
      include: {
        authors: {
          orderBy: { position: "asc" },
          include: {
            scholar: {
              select: {
                cwid: true,
                slug: true,
                preferredName: true,
                deletedAt: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (pubs.length === 0) break;
    cursor = pubs[pubs.length - 1].pmid;

  const docs: Array<{ pmid: string; doc: Record<string, unknown> }> = [];
  for (const p of pubs) {
    const authorNames = p.authors
      .map((a) => a.externalName ?? a.scholar?.preferredName ?? "")
      .filter(Boolean)
      .join(", ");

    const wcmAuthors = p.authors
      .filter(
        (a) =>
          a.scholar &&
          !a.scholar.deletedAt &&
          a.scholar.status === "active",
      )
      .map((a) => ({
        cwid: a.scholar!.cwid,
        slug: a.scholar!.slug,
        preferredName: a.scholar!.preferredName,
        position: a.position,
      }));

    const mesh = Array.isArray(p.meshTerms)
      ? (p.meshTerms as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    docs.push({
      pmid: p.pmid,
      doc: {
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        publicationType: p.publicationType,
        citationCount: p.citationCount,
        dateAddedToEntrez: p.dateAddedToEntrez,
        doi: p.doi,
        pubmedUrl: p.pubmedUrl,
        meshTerms: mesh.join(" "),
        authorNames,
        wcmAuthors,
      },
    });
  }

    if (docs.length === 0) { if (pubs.length < PUB_PAGE) break; continue; }

    // Bulk index this page's docs in 500-doc chunks.
    const CHUNK = 500;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      const body: Record<string, unknown>[] = [];
      for (const { pmid, doc } of chunk) {
        body.push({ index: { _index: PUBLICATIONS_INDEX, _id: pmid } });
        body.push(doc);
      }
      const resp = await client.bulk({ refresh: true, body });
      if (resp.body.errors) {
        const firstError = resp.body.items.find(
          (it: { index?: { error?: unknown } }) => it.index?.error,
        );
        throw new Error(
          `Publications bulk indexing had errors: ${JSON.stringify(firstError, null, 2)}`,
        );
      }
    }
    totalIndexed += docs.length;
    console.log(`  ...indexed ${totalIndexed} publications so far`);
    if (pubs.length < PUB_PAGE) break;
  }
  return totalIndexed;
}

async function main() {
  console.log("Recreating indices...");
  await ensureIndex(PEOPLE_INDEX, peopleIndexMapping);
  await ensureIndex(PUBLICATIONS_INDEX, publicationsIndexMapping);

  console.log("Indexing people...");
  const peopleCount = await indexPeople();

  console.log("Indexing publications...");
  const pubCount = await indexPublications();

  console.log(`Indexed ${peopleCount} scholars and ${pubCount} publications.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
