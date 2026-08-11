/**
 * GET /api/edit/center/[code]/collab-report/export[?cwid=<cwid>]
 *
 * The per-paper "why" behind the Collaboration & Cancer-Relevance report's
 * aggregate counts — CSV of one candidate's (`?cwid=`) or every candidate's
 * (no query param) post-cutoff Academic Article authorship: full citation
 * detail (title, journal, year, publication type), the ReCiterAI synopsis
 * and impact score/justification, and whether/why it matched the cancer
 * taxonomy — including the specific MeSH term(s) matched, not just the
 * rolled-up topic bucket(s). Exists so a curator can audit the classification
 * directly instead of re-deriving it by hand against reciterdb, the way
 * this report's numbers were validated once already.
 *
 * Re-derives per-paper detail at request time — the weekly
 * `CenterCollabCandidate` row only stores aggregate counts, not which papers
 * or which MeSH terms produced them — using the SAME `loadCancerTaxonomy`
 * the ETL step calls (the ETL only needs its boolean `isCancerRelated`; this
 * route additionally uses `matchedTopics`/`matchedUis` for the term-level
 * "why"), so the export can't drift from what was actually counted.
 *
 * Authz mirrors the parent report: Curator/Owner of the center, or
 * Superuser/comms_steward (`canEditUnit`).
 *
 * ponytail: the no-`cwid` (whole-report) mode pulls every candidate's
 * post-cutoff papers in one request — today that's ~2,400 candidates and
 * ~98k `PublicationAuthor` rows for Meyer (the only center with a program
 * taxonomy right now), same order of magnitude as what the weekly ETL step
 * already does for this center, but as an interactive request rather than a
 * background job. Rows are heavier now (title/journal/synopsis/impact text
 * per row, not just a handful of scalars), so this is the mode most likely
 * to actually need the streamed/background upgrade path someday. Fine for
 * an occasional manual audit at today's scale; if a future center is
 * meaningfully larger, or this starts brushing CloudFront's 30s origin
 * budget, split into a background/streamed export then rather than
 * pre-building it now.
 */
import { NextResponse, type NextRequest } from "next/server";

import { loadCancerTaxonomy, matchedTopics, matchedUis } from "@/lib/cancer-taxonomy";
import { DEFAULT_CUTOFF_YEAR, splitName } from "@/lib/center-collaboration/recommendations-core";
import { toCsv, type CsvCell } from "@/lib/csv";
import { db } from "@/lib/db";
import { canEditUnit, getEffectiveUnitRole, logEditDenial, type UnitAdminLookup } from "@/lib/edit/authz";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/collab-report/export";

const HEADERS = [
  "cwid",
  "surname",
  "given_name",
  "pmid",
  "article_title",
  "journal_title",
  "publication_type",
  "year",
  "is_cancer_related",
  "matched_terms",
  "matched_topics",
  "impact_score",
  "impact_justification",
  "synopsis",
] as const;

// Derived from HEADERS rather than hand-copied, so a future column reorder
// can't silently point the sort at the wrong cell.
const YEAR_COL = HEADERS.indexOf("year");

// `cwid` is an attacker-controlled query param that lands in a response
// header value (`Content-Disposition`) — strip it to the shape a real CWID
// always has before using it in the filename, so a crafted value can't break
// out of the quoted filename or smuggle a header.
function filename(code: string, cwid: string | null): string {
  const safeCwid = cwid?.replace(/[^a-zA-Z0-9_-]/g, "");
  return safeCwid ? `${code}-${safeCwid}-cancer-relevance.csv` : `${code}-cancer-relevance-full.csv`;
}

function csvResponse(rows: readonly (readonly CsvCell[])[], code: string, cwid: string | null): NextResponse {
  return new NextResponse(toCsv(HEADERS, rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename(code, cwid)}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");
  const { session, realCwid } = identity;

  const { code } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(404, "unit_not_found", "code");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: center.code,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  const cwidParam = request.nextUrl.searchParams.get("cwid");

  const candidates = await db.read.centerCollabCandidate.findMany({
    where: { centerCode: center.code, ...(cwidParam ? { cwid: cwidParam } : {}) },
    select: { cwid: true },
  });
  if (candidates.length === 0) return csvResponse([], center.code, cwidParam);
  const cwids = candidates.map((c) => c.cwid);

  const scholars = await db.read.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true },
  });
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, splitName(s.preferredName ?? s.cwid)]));

  const authorRows = await db.read.publicationAuthor.findMany({
    where: {
      cwid: { in: cwids },
      isConfirmed: true,
      publication: { publicationType: "Academic Article", year: { gte: DEFAULT_CUTOFF_YEAR } },
    },
    select: {
      pmid: true,
      cwid: true,
      publication: {
        select: {
          title: true,
          journal: true,
          publicationType: true,
          year: true,
          meshTerms: true,
          impactScore: true,
          impactJustification: true,
          synopsis: true,
        },
      },
    },
  });

  const lookup = await loadCancerTaxonomy(db.read.cancerTaxonomyDescriptor, db.read.meshDescriptor);

  const rows: CsvCell[][] = authorRows
    .filter((r): r is typeof r & { cwid: string } => r.cwid !== null)
    .map((r) => {
      const mt = r.publication.meshTerms;
      const meshUis = Array.isArray(mt)
        ? mt.flatMap((x) => (x && typeof x === "object" && "ui" in x && typeof x.ui === "string" ? [x.ui] : []))
        : [];
      const topics = matchedTopics(meshUis, lookup);
      const terms = matchedUis(meshUis, lookup).map((ui) => lookup.nameByUi.get(ui) ?? ui);
      const { given, surname } = nameByCwid.get(r.cwid) ?? { given: "", surname: r.cwid };
      return [
        r.cwid,
        surname,
        given,
        r.pmid,
        r.publication.title,
        r.publication.journal,
        r.publication.publicationType,
        r.publication.year,
        topics.length > 0 ? "yes" : "no",
        terms.join(";"),
        topics.join(";"),
        r.publication.impactScore !== null ? Number(r.publication.impactScore) : null,
        r.publication.impactJustification,
        r.publication.synopsis,
      ];
    })
    // Plain ASCII comparison, not `localeCompare` — cwids have no locale to
    // respect, and this sort runs over the whole-report row count (~98k for
    // Meyer today) on the shared app-server event loop.
    .sort((a, b) => {
      const acwid = String(a[0]);
      const bcwid = String(b[0]);
      return acwid < bcwid ? -1 : acwid > bcwid ? 1 : Number(a[YEAR_COL]) - Number(b[YEAR_COL]);
    });

  return csvResponse(rows, center.code, cwidParam);
}
