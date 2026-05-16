/**
 * Publication detail payload for the #288 PR-B modal. Aggregates per-pmid
 * publication fields, multi-author topic rows collapsed to one row per
 * parent topic, and a capped list of citing publications from reciterdb.
 *
 * Same pure-function shape as `lib/api/profile.ts` etc. — the route file
 * (`app/api/publications/[pmid]/route.ts`) is a thin delegator.
 */
import { prisma } from "@/lib/db";
import { withReciterConnection } from "@/lib/sources/reciterdb";
import { normalizeMeshTerms } from "@/lib/api/profile";

const CITING_PUBS_CAP = 500;
const CITING_PUBS_CSV_CAP = 50_000;

export type PublicationDetailTopic = {
  topicId: string;
  topicName: string;
  /** Topic.id IS the slug (D-02 candidate (e)). Kept as a separate key so
   *  the UI doesn't have to know that detail. */
  topicSlug: string;
  /** Best parent-topic score across all (cwid) rows for this pmid. The score
   *  is per-paper in practice; the (pmid, cwid) keying on publication_topic
   *  is a denormalization artifact, so MAX across cwids collapses safely. */
  score: number;
  primarySubtopicId: string | null;
  subtopics: Array<{
    slug: string;
    name: string;
    confidence: number | null;
  }>;
};

export type PublicationDetailCitingPub = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
};

export type PublicationDetailPayload = {
  pub: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    volume: string | null;
    issue: string | null;
    pages: string | null;
    fullAuthorsString: string | null;
    abstract: string | null;
    impactScore: number | null;
    impactJustification: string | null;
    /**
     * Scopus-broad citation count from `Publication.citationCount` — the
     * canonical "this paper has been cited N times" number. Distinct from
     * `citingPubsTotal` below, which is the (much narrower) count of citing
     * pmids that reciterdb's `analysis_nih_cites` table tracks for citing-
     * link display. Surface this as the headline citation count; surface
     * `citingPubsTotal` only to qualify the listed window.
     */
    citationCount: number;
    pmcid: string | null;
    doi: string | null;
    pubmedUrl: string | null;
    meshTerms: Array<{ ui: string | null; label: string }>;
    /** One-line plain-language synopsis per pmid (#329). Read from
     *  `Publication.synopsis`. Null when no synopsis exists. */
    synopsis: string | null;
  };
  topics: PublicationDetailTopic[];
  /** Up to CITING_PUBS_CAP rows from `analysis_nih_cites` joined to
   *  `analysis_summary_article` (the iCite-derived subset that reciterdb
   *  also has article metadata for), ordered by date desc. Null when
   *  reciterdb was unreachable — the modal renders "Citation list
   *  temporarily unavailable" in that case. */
  citingPubs: PublicationDetailCitingPub[] | null;
  /** Total rows in `analysis_nih_cites` for this `cited_pmid`. Typically
   *  smaller than `pub.citationCount` because the upstream table is iCite-
   *  derived and Cornell-indexed (NIH-funded citers only, and only those
   *  also present in `analysis_summary_article`). Null when reciterdb was
   *  unreachable. */
  citingPubsTotal: number | null;
};

type SubtopicConfidences = Record<string, number> | null;

function parseSubtopicIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function parseSubtopicConfidences(raw: unknown): SubtopicConfidences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

/**
 * Validate a pmid string is digits only and within DB column length.
 * Returns the numeric form for the reciterdb int(11) column, or null on bad input.
 */
function parsePmid(pmid: string): number | null {
  if (!/^\d{1,16}$/.test(pmid)) return null;
  const n = Number(pmid);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function getPublicationDetail(
  pmid: string,
): Promise<PublicationDetailPayload | null> {
  const pmidInt = parsePmid(pmid);
  if (pmidInt === null) return null;

  const pub = await prisma.publication.findUnique({
    where: { pmid },
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      volume: true,
      issue: true,
      pages: true,
      fullAuthorsString: true,
      abstract: true,
      impactScore: true,
      impactJustification: true,
      citationCount: true,
      pmcid: true,
      doi: true,
      pubmedUrl: true,
      meshTerms: true,
      synopsis: true,
      publicationTopics: {
        select: {
          parentTopicId: true,
          score: true,
          primarySubtopicId: true,
          subtopicIds: true,
          subtopicConfidences: true,
          topic: { select: { id: true, label: true } },
        },
      },
    },
  });
  if (!pub) return null;

  // Collapse multi-author rows into one row per parent topic by MAX(score).
  // The score column is per-(pmid, cwid, topic) on PublicationTopic but the
  // value is per-paper in practice; the cwid dimension is a denormalization
  // artifact left over from the DDB TOPIC# key. Synopsis already moved to
  // Publication in #329 — read directly off `pub.synopsis`.
  const byTopic = new Map<
    string,
    {
      topicId: string;
      topicName: string;
      score: number;
      primarySubtopicId: string | null;
      subtopicIds: string[];
      subtopicConfidences: SubtopicConfidences;
    }
  >();
  for (const row of pub.publicationTopics) {
    if (!row.topic) continue;
    const score = Number(row.score);
    const existing = byTopic.get(row.parentTopicId);
    if (!existing || score > existing.score) {
      byTopic.set(row.parentTopicId, {
        topicId: row.topic.id,
        topicName: row.topic.label,
        score,
        primarySubtopicId: row.primarySubtopicId ?? null,
        subtopicIds: parseSubtopicIds(row.subtopicIds),
        subtopicConfidences: parseSubtopicConfidences(row.subtopicConfidences),
      });
    }
  }

  // Subtopic resolution: gather all referenced subtopic ids and resolve to
  // {id, displayName, label}. parentTopicId scope so naming collisions across
  // parent topics don't cross-pollinate.
  const subtopicIdsAll = new Set<string>();
  for (const t of byTopic.values()) {
    for (const id of t.subtopicIds) subtopicIdsAll.add(id);
    if (t.primarySubtopicId) subtopicIdsAll.add(t.primarySubtopicId);
  }
  const subtopicLookup =
    subtopicIdsAll.size === 0
      ? new Map<string, { id: string; displayName: string }>()
      : new Map(
          (
            await prisma.subtopic.findMany({
              where: { id: { in: [...subtopicIdsAll] } },
              select: { id: true, label: true, displayName: true },
            })
          ).map((s) => [
            s.id,
            { id: s.id, displayName: s.displayName ?? s.label },
          ]),
        );

  const topics: PublicationDetailTopic[] = [...byTopic.values()]
    .map((t) => ({
      topicId: t.topicId,
      topicName: t.topicName,
      topicSlug: t.topicId,
      score: t.score,
      primarySubtopicId: t.primarySubtopicId,
      subtopics: t.subtopicIds
        .map((id) => {
          const looked = subtopicLookup.get(id);
          if (!looked) return null;
          const confidence = t.subtopicConfidences?.[id] ?? null;
          return {
            slug: looked.id,
            name: looked.displayName,
            confidence,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .sort((a, b) => {
          // Primary subtopic first, then by confidence desc, then by name.
          if (t.primarySubtopicId === a.slug && t.primarySubtopicId !== b.slug)
            return -1;
          if (t.primarySubtopicId === b.slug && t.primarySubtopicId !== a.slug)
            return 1;
          const ac = a.confidence ?? -Infinity;
          const bc = b.confidence ?? -Infinity;
          if (ac !== bc) return bc - ac;
          return a.name.localeCompare(b.name);
        }),
    }))
    .sort((a, b) => b.score - a.score);

  // Citing publications via reciterdb. Try/catch so a downstream MySQL
  // outage doesn't 500 the whole modal — pub + topics still return; citingPubs
  // becomes null and the UI shows the fallback message.
  let citingPubs: PublicationDetailCitingPub[] | null = null;
  let citingPubsTotal: number | null = null;
  try {
    await withReciterConnection(async (conn) => {
      const totalRow = (await conn.query(
        "SELECT COUNT(*) AS n FROM analysis_nih_cites WHERE cited_pmid = ?",
        [pmidInt],
      )) as Array<{ n: number | bigint }>;
      citingPubsTotal = Number(totalRow[0]?.n ?? 0);

      const rows = (await conn.query(
        `SELECT a.pmid AS pmid,
                a.articleTitle AS title,
                a.journalTitleVerbose AS journal,
                a.articleYear AS year
           FROM analysis_nih_cites c
           JOIN analysis_summary_article a ON a.pmid = c.citing_pmid
          WHERE c.cited_pmid = ?
          ORDER BY a.publicationDateStandardized DESC, a.pmid DESC
          LIMIT ?`,
        [pmidInt, CITING_PUBS_CAP],
      )) as Array<{
        pmid: number | bigint;
        title: string | null;
        journal: string | null;
        year: number | null;
      }>;
      citingPubs = rows.map((r) => ({
        pmid: String(r.pmid),
        title: r.title ?? "",
        journal: r.journal ?? null,
        year: r.year ?? null,
      }));
    });
  } catch (err) {
    // Soft-fail — log and let the API still return the rest.
    console.error("[publication-detail] reciterdb citingPubs query failed", err);
    citingPubs = null;
    citingPubsTotal = null;
  }

  return {
    pub: {
      pmid: pub.pmid,
      title: pub.title,
      journal: pub.journal,
      year: pub.year,
      volume: pub.volume,
      issue: pub.issue,
      pages: pub.pages,
      fullAuthorsString: pub.fullAuthorsString,
      abstract: pub.abstract && pub.abstract.length > 0 ? pub.abstract : null,
      impactScore:
        pub.impactScore !== null && pub.impactScore !== undefined
          ? Number(pub.impactScore)
          : null,
      impactJustification:
        pub.impactJustification && pub.impactJustification.length > 0
          ? pub.impactJustification
          : null,
      citationCount: pub.citationCount,
      pmcid: pub.pmcid,
      doi: pub.doi,
      pubmedUrl: pub.pubmedUrl,
      meshTerms: normalizeMeshTerms(pub.meshTerms),
      synopsis: pub.synopsis && pub.synopsis.length > 0 ? pub.synopsis : null,
    },
    topics,
    citingPubs,
    citingPubsTotal,
  };
}

export const PUBLICATION_DETAIL_CITING_PUBS_CAP = CITING_PUBS_CAP;

export type PublicationDetailCsvRow = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  publicationDate: string | null;
};

/**
 * Streams the full list of citing publications for a pmid as plain rows
 * (caller is responsible for CSV serialization + HTTP transport). Capped
 * at CITING_PUBS_CSV_CAP — far above CITING_PUBS_CAP so highly cited
 * papers (5,000+ citers) export completely. Returns `null` when the pmid
 * is invalid; throws on reciterdb failure so the caller can return a
 * 5xx instead of an empty/misleading CSV.
 */
export async function getCitingPublicationsForCsv(
  pmid: string,
): Promise<PublicationDetailCsvRow[] | null> {
  const pmidInt = parsePmid(pmid);
  if (pmidInt === null) return null;
  let rows: PublicationDetailCsvRow[] = [];
  await withReciterConnection(async (conn) => {
    const raw = (await conn.query(
      `SELECT a.pmid AS pmid,
              a.articleTitle AS title,
              a.journalTitleVerbose AS journal,
              a.articleYear AS year,
              a.publicationDateStandardized AS publicationDate
         FROM analysis_nih_cites c
         JOIN analysis_summary_article a ON a.pmid = c.citing_pmid
        WHERE c.cited_pmid = ?
        ORDER BY a.publicationDateStandardized DESC, a.pmid DESC
        LIMIT ?`,
      [pmidInt, CITING_PUBS_CSV_CAP],
    )) as Array<{
      pmid: number | bigint;
      title: string | null;
      journal: string | null;
      year: number | null;
      publicationDate: string | null;
    }>;
    rows = raw.map((r) => ({
      pmid: String(r.pmid),
      title: r.title ?? "",
      journal: r.journal ?? null,
      year: r.year ?? null,
      publicationDate: r.publicationDate ?? null,
    }));
  });
  return rows;
}

/** RFC 4180 CSV field encoding: double-quote-wrap, double-up inner quotes. */
export function encodeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize citing-pub rows into a CSV document. Header row included. */
export function serializeCitingPubsCsv(rows: PublicationDetailCsvRow[]): string {
  const header = ["PMID", "Title", "Journal", "Year", "Publication date"];
  const out: string[] = [header.join(",")];
  for (const r of rows) {
    out.push(
      [
        encodeCsvField(r.pmid),
        encodeCsvField(r.title),
        encodeCsvField(r.journal),
        encodeCsvField(r.year),
        encodeCsvField(r.publicationDate),
      ].join(","),
    );
  }
  return out.join("\r\n") + "\r\n";
}
