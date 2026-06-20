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
import { loadPublicationSuppressions, resolveDarkPmids } from "@/lib/api/manual-layer";
import {
  isMethodsLensPubModalEnabled,
  isMethodsLensToolContextOn,
  isMethodPagesEnabled,
} from "@/lib/profile/methods-lens-flags";
import {
  loadFamilyOverlayGate,
  isFamilyPubliclyVisible,
} from "@/lib/api/methods-overlay";
import { methodFamilyPath } from "@/lib/method-url";

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

/**
 * #917 Phase 2 — one representative tool under a method family, with its #1119
 * usage-context snippet. `name` is the exemplar-tool DISPLAY NAME
 * (`scholar_family.exemplarTools`); `context` is the best snippet for that tool
 * (`scholar_family.exemplarContexts[name]`), or null when the tool-context flag
 * (`METHODS_LENS_TOOL_CONTEXT`) is off or no snippet exists. The name is part of
 * the families surface (gated by `METHODS_LENS_PUB_MODAL`); only the snippet is
 * tool-context-gated — the same flag split the rest of the Methods lens uses.
 */
export type PublicationDetailMethodTool = {
  name: string;
  context: string | null;
  /** #1158 — the PMID the `context` snippet was extracted from
   *  (`scholar_family.exemplarContextPmids[name]`), or null when the tool-context
   *  flag is off, the snippet is absent, or the row predates #1158 (back-compat).
   *  Lets the modal say "from this paper" when it equals the viewed pmid. */
  sourcePmid: string | null;
};

/**
 * #917 — one method family attributed to this pmid, aggregated across every
 * confirmed WCM author of the paper and de-duped by the stable
 * `(supercategory, familyLabel)` identity. Already #800-suppressed /
 * #801-sensitivity-gated by the time it reaches the payload (same gate the rest
 * of the Methods lens applies), so the modal can render it verbatim.
 */
export type PublicationDetailMethodFamily = {
  supercategory: string;
  familyLabel: string;
  /** Precomputed cross-scholar Method-page path, or null when the standalone
   *  Method pages are gated off (`METHODS_LENS_PAGES`) — the UI then renders the
   *  label as plain text instead of a dead link. */
  href: string | null;
  /** #917 Phase 2 — the family's representative tools (`exemplarTools`, salience-
   *  ordered) with their #1119 usage snippets. Empty when the family has no
   *  exemplar tools; the UI then renders the family chip alone, as in Phase 1. */
  tools: PublicationDetailMethodTool[];
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
  /** #917 — method families attributed to this pmid (de-duped across WCM
   *  authors), gated + suppression-filtered. Empty when the Methods lens is off
   *  or the paper has no surfaced family; the modal omits the section then. */
  methodFamilies: PublicationDetailMethodFamily[];
  /** Up to CITING_PUBS_CAP distinct citers from `analysis_nih_cites` joined to
   *  `analysis_summary_article` (the iCite-derived subset that reciterdb
   *  also has article metadata for), ordered by date desc. De-duped on the
   *  citing pmid — `analysis_nih_cites` can hold the same (cited, citing) pair
   *  twice (#1041). Null when reciterdb was unreachable — the modal renders
   *  "Citation list temporarily unavailable" in that case. */
  citingPubs: PublicationDetailCitingPub[] | null;
  /** Count of distinct citing pmids in `analysis_nih_cites` for this
   *  `cited_pmid`. Typically
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

/**
 * #917 Phase 2 — resolve a family row's representative tools (+ #1119 snippets)
 * for the modal. `exemplarTools` is the salience-ordered display-name array;
 * `exemplarContexts` is a `{ name: snippet }` object whose KEY ORDER is unreliable
 * (Aurora MySQL re-sorts JSON keys), so we iterate the array and look snippets up
 * by name. The snippet is gated on `METHODS_LENS_TOOL_CONTEXT` — off ⇒ tool names
 * still render (they are part of the #917 families surface), but `context: null`.
 */
function resolveFamilyTools(
  exemplarTools: unknown,
  exemplarContexts: unknown,
  exemplarContextPmids: unknown,
): PublicationDetailMethodTool[] {
  const names = Array.isArray(exemplarTools)
    ? exemplarTools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (names.length === 0) return [];

  const ctx =
    isMethodsLensToolContextOn() &&
    exemplarContexts &&
    typeof exemplarContexts === "object" &&
    !Array.isArray(exemplarContexts)
      ? (exemplarContexts as Record<string, unknown>)
      : null;
  // #1158 — the parallel `{ name: pmid }` map (same flag gate as the snippet; a
  // source link is meaningless without the snippet). Null on a pre-#1158 row.
  const pmidMap =
    ctx &&
    exemplarContextPmids &&
    typeof exemplarContextPmids === "object" &&
    !Array.isArray(exemplarContextPmids)
      ? (exemplarContextPmids as Record<string, unknown>)
      : null;

  const seen = new Set<string>();
  const out: PublicationDetailMethodTool[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const raw = ctx ? ctx[name] : undefined;
    const context = typeof raw === "string" && raw.length > 0 ? raw : null;
    // Only carry a source pmid alongside a real snippet.
    const rawPmid = context && pmidMap ? pmidMap[name] : undefined;
    out.push({
      name,
      context,
      sourcePmid: typeof rawPmid === "string" && rawPmid.length > 0 ? rawPmid : null,
    });
  }
  return out;
}

/**
 * #917 — method families attributed to ONE pmid, de-duped across every confirmed
 * WCM author of the paper (the modal has no cwid, so it aggregates exactly like
 * the Topics rows do). Mirrors the cross-scholar Method-page data layer
 * (`lib/api/methods.ts`): the per-surface #917 gate (which composes the master
 * lens gate), the same `(deletedAt, status)`
 * active-scholar filter, the same in-JS `pmids[]` membership scan (no
 * `JSON_CONTAINS` anywhere in the codebase), and the SAME #800/#801 overlay gate
 * so a family the rest of the site hides can never leak through the modal.
 *
 * Bounded: the row scan is limited to the paper's confirmed WCM authors, so it is
 * not the unbounded supercategory scan `collectSupercategoryFamilyPmids` does.
 */
async function resolveMethodFamilies(
  pmid: string,
): Promise<PublicationDetailMethodFamily[]> {
  // Per-surface render gate (#917) — composes the master lens gate, so off (prod,
  // or master lens off) → nothing renders, no side channel (#799). Lets the modal
  // Methods section roll out independently of the rest of the lens.
  if (!isMethodsLensPubModalEnabled()) return [];

  // Confirmed WCM authors of this paper (LOCAL `publication_author`, indexed on
  // pmid). NULL cwid = non-WCM author; an unconfirmed authorship is not "theirs".
  const authorRows = await prisma.publicationAuthor.findMany({
    where: { pmid, isConfirmed: true, cwid: { not: null } },
    select: { cwid: true },
  });
  const cwids = [
    ...new Set(authorRows.map((r) => r.cwid).filter((c): c is string => !!c)),
  ];
  if (cwids.length === 0) return [];

  // Their family rows (active scholars only — same filter the lens uses).
  const familyRows = await prisma.scholarFamily.findMany({
    where: {
      cwid: { in: cwids },
      scholar: { deletedAt: null, status: "active" },
    },
    select: {
      supercategory: true,
      familyLabel: true,
      familyId: true,
      pmids: true,
      exemplarTools: true,
      exemplarContexts: true,
      exemplarContextPmids: true,
    },
  });
  if (familyRows.length === 0) return [];

  const gate = await loadFamilyOverlayGate();
  const linkable = isMethodPagesEnabled();

  // De-dupe by the stable (supercategory, familyLabel) identity. familyId is only
  // a Method-page link disambiguator (the loader re-derives & matches on
  // (sc,label) — see lib/method-url.ts), so keeping the first one seen is correct.
  const byKey = new Map<string, PublicationDetailMethodFamily>();
  for (const row of familyRows) {
    if (!Array.isArray(row.pmids)) continue;
    if (!row.pmids.some((p) => String(p) === pmid)) continue;
    if (!isFamilyPubliclyVisible(row.supercategory, row.familyLabel, gate)) {
      continue;
    }
    const key = `${row.supercategory}::${row.familyLabel}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      supercategory: row.supercategory,
      familyLabel: row.familyLabel,
      href: linkable
        ? methodFamilyPath(row.supercategory, row.familyId, row.familyLabel)
        : null,
      // #917 Phase 2 — the first-kept row's exemplar tools (same row the family
      // identity is taken from). exemplar_tools is salience-ordered; the snippet
      // is looked up off the ARRAY order, not the exemplar_contexts object keys
      // (Aurora re-sorts JSON keys — #1119).
      tools: resolveFamilyTools(
        row.exemplarTools,
        row.exemplarContexts,
        row.exemplarContextPmids,
      ),
    });
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.supercategory.localeCompare(b.supercategory) ||
      a.familyLabel.localeCompare(b.familyLabel),
  );
}

/** Coerce the stored `publication_citing.citingPubs` JSON into the payload
 *  shape, dropping malformed entries and capping defensively at CITING_PUBS_CAP
 *  (the exporter already caps, but a JSON column carries no guarantee). */
function parseBridgedCitingPubs(raw: unknown): PublicationDetailCitingPub[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicationDetailCitingPub[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.pmid === undefined || o.pmid === null) continue;
    const pmidStr = String(o.pmid);
    if (seen.has(pmidStr)) continue;
    seen.add(pmidStr);
    out.push({
      pmid: pmidStr,
      title: typeof o.title === "string" ? o.title : "",
      journal: typeof o.journal === "string" ? o.journal : null,
      year: typeof o.year === "number" ? o.year : null,
    });
    if (out.length >= CITING_PUBS_CAP) break;
  }
  return out;
}

/**
 * #928 — read the modal's cited-by list + total from the `publication_citing`
 * bridge instead of live WCM ReciterDB (unreachable in-VPC). Degrades HONESTLY:
 * a present row → its total + ≤500 list; this pmid absent but the table has rows
 * → a genuine zero (`0`/`[]`); the table globally empty (flag flipped before the
 * import ran) → `null`/`null`, exactly the live-outage shape the modal renders as
 * "temporarily unavailable". The cheap global existence probe runs only on the
 * absent-pmid path, so it costs nothing for the common (present-row) case.
 */
async function readCitingFromBridge(
  pmidInt: number,
): Promise<{
  citingPubs: PublicationDetailCitingPub[] | null;
  citingPubsTotal: number | null;
}> {
  try {
    const row = await prisma.publicationCiting.findUnique({
      where: { pmid: pmidInt },
      select: { total: true, citingPubs: true },
    });
    if (row) {
      return {
        citingPubs: parseBridgedCitingPubs(row.citingPubs),
        citingPubsTotal: row.total,
      };
    }
    const anyRow = await prisma.publicationCiting.findFirst({
      select: { pmid: true },
    });
    return anyRow
      ? { citingPubs: [], citingPubsTotal: 0 } // table populated → genuinely uncited
      : { citingPubs: null, citingPubsTotal: null }; // empty/un-imported → degrade
  } catch (err) {
    console.error("[publication-detail] publication_citing bridge read failed", err);
    return { citingPubs: null, citingPubsTotal: null };
  }
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

  // #356 — a whole-publication takedown, or a derived-dark publication (every
  // confirmed WCM author per-author-hidden), must not be reachable by direct
  // URL: the detail modal returns null exactly as it does for an unknown pmid.
  const suppressions = await loadPublicationSuppressions([pmid], prisma);
  const darkPmids = await resolveDarkPmids([pmid], suppressions, prisma);
  if (darkPmids.has(pmid)) return null;

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

  // #917 — method families for this pmid (gated; [] when the lens is off).
  const methodFamilies = await resolveMethodFamilies(pmid);

  // Citing publications. With PUBLICATION_CITING_BRIDGE=on the in-VPC app serves
  // the pre-computed `publication_citing` bridge (#928); otherwise it queries WCM
  // ReciterDB live. Either path soft-degrades to null so a downstream outage (or
  // an un-imported bridge) shows "Citation list temporarily unavailable" rather
  // than 500ing the whole modal — pub + topics + methods still return.
  let citingPubs: PublicationDetailCitingPub[] | null = null;
  let citingPubsTotal: number | null = null;
  if (process.env.PUBLICATION_CITING_BRIDGE === "on") {
    const bridged = await readCitingFromBridge(pmidInt);
    citingPubs = bridged.citingPubs;
    citingPubsTotal = bridged.citingPubsTotal;
  } else {
    try {
      await withReciterConnection(async (conn) => {
        const totalRow = (await conn.query(
          "SELECT COUNT(DISTINCT citing_pmid) AS n FROM analysis_nih_cites WHERE cited_pmid = ?",
          [pmidInt],
        )) as Array<{ n: number | bigint }>;
        citingPubsTotal = Number(totalRow[0]?.n ?? 0);

        const rows = (await conn.query(
          `SELECT a.pmid AS pmid,
                  a.articleTitle AS title,
                  a.journalTitleVerbose AS journal,
                  a.articleYear AS year
             FROM (SELECT DISTINCT citing_pmid FROM analysis_nih_cites WHERE cited_pmid = ?) c
             JOIN analysis_summary_article a ON a.pmid = c.citing_pmid
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
    methodFamilies,
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
 *
 * #928 — with `PUBLICATION_CITING_BRIDGE=on` (the in-VPC posture) it serves the
 * bridged `publication_citing` rows instead. The bridge stores only the ≤500
 * most-recent citers and does not retain `publicationDate`, so the in-VPC CSV is
 * the same ≤500 the modal shows (ordering preserved). For the rare paper with
 * >500 NIH-cites the full 50k export only ever existed on the WCM network where
 * the live path below still runs; in-VPC the cap is the bridged 500.
 */
export async function getCitingPublicationsForCsv(
  pmid: string,
): Promise<PublicationDetailCsvRow[] | null> {
  const pmidInt = parsePmid(pmid);
  if (pmidInt === null) return null;

  if (process.env.PUBLICATION_CITING_BRIDGE === "on") {
    const row = await prisma.publicationCiting.findUnique({
      where: { pmid: pmidInt },
      select: { citingPubs: true },
    });
    // No row = genuinely uncited OR the table is empty/un-imported. The modal
    // only renders the download button when citingPubsTotal > 0, so a direct hit
    // here gets an empty CSV rather than a 5xx (honest degrade, no fake rows).
    if (!row) return [];
    return parseBridgedCitingPubs(row.citingPubs).map((p) => ({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      year: p.year,
      publicationDate: null,
    }));
  }

  let rows: PublicationDetailCsvRow[] = [];
  await withReciterConnection(async (conn) => {
    const raw = (await conn.query(
      `SELECT a.pmid AS pmid,
              a.articleTitle AS title,
              a.journalTitleVerbose AS journal,
              a.articleYear AS year,
              a.publicationDateStandardized AS publicationDate
         FROM (SELECT DISTINCT citing_pmid FROM analysis_nih_cites WHERE cited_pmid = ?) c
         JOIN analysis_summary_article a ON a.pmid = c.citing_pmid
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
