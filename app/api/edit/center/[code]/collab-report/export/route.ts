/**
 * GET /api/edit/center/[code]/collab-report/export?cwid=<cwid>
 *
 * The per-paper "why" behind one Optimize membership (report 1) row: a CSV of
 * that candidate's post-cutoff Academic Article authorship with full citation
 * detail (title, journal, year, publication type), the ReCiterAI synopsis
 * and impact score/justification, and whether/why it matched the cancer
 * taxonomy, including the specific MeSH term(s) matched, not just the
 * rolled-up topic bucket(s). Reached from the person's name in the report
 * table. Exists so a curator can audit the classification directly instead
 * of re-deriving it by hand against reciterdb.
 *
 * Re-derives per-paper detail at request time (the weekly
 * `CenterCollabCandidate` row only stores aggregate counts) using the SAME
 * `loadCancerTaxonomy` the ETL step calls, so the export can't drift from
 * what was actually counted.
 *
 * `cwid` is required (400 `missing_cwid`). The whole-report mode (no `cwid`,
 * every candidate, ~2,400 people for Meyer) is retired (plan D1): a list
 * download is the capped `.xlsx` at `../xlsx`. A `cwid` that isn't one of this
 * center's candidates gets a header-only CSV.
 *
 * Gate: `gateCollabReportRoute` (signed in, center exists, `canEditUnit`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { loadCancerTaxonomy, matchedTopics, matchedUis } from "@/lib/cancer-taxonomy";
import { DEFAULT_CUTOFF_YEAR, splitName } from "@/lib/center-collaboration/recommendations-core";
import { toCsv, type CsvCell } from "@/lib/csv";
import { db } from "@/lib/db";
import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";
import { editError } from "@/lib/edit/request";
import { institutionDisplayName } from "@/lib/institutions";

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
  // Appended LAST (YEAR_COL below is index-derived; a consumer's indices never shift).
  "institution",
] as const;

// Derived from HEADERS rather than hand-copied, so a future column reorder
// can't silently point the sort at the wrong cell.
const YEAR_COL = HEADERS.indexOf("year");

// `cwid` is an attacker-controlled query param that lands in a response
// header value (`Content-Disposition`) — strip it to the shape a real CWID
// always has before using it in the filename, so a crafted value can't break
// out of the quoted filename or smuggle a header.
function filename(code: string, cwid: string): string {
  return `${code}-${cwid.replace(/[^a-zA-Z0-9_-]/g, "")}-cancer-relevance.csv`;
}

function csvResponse(rows: readonly (readonly CsvCell[])[], code: string, cwid: string): NextResponse {
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
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const cwidParam = request.nextUrl.searchParams.get("cwid")?.trim();
  if (!cwidParam) return editError(400, "missing_cwid", "cwid");

  const candidates = await db.read.centerCollabCandidate.findMany({
    where: { centerCode: center.code, cwid: cwidParam },
    select: { cwid: true },
  });
  if (candidates.length === 0) return csvResponse([], center.code, cwidParam);
  const cwids = candidates.map((c) => c.cwid);

  const scholars = await db.read.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true, primaryOrgCode: true },
  });
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, splitName(s.preferredName ?? s.cwid)]));
  const institutionByCwid = new Map(
    scholars.map((s) => [s.cwid, s.primaryOrgCode ? institutionDisplayName(s.primaryOrgCode) : ""]),
  );

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
        institutionByCwid.get(r.cwid) ?? "",
      ];
    })
    // Plain ASCII comparison, not `localeCompare`: cwids have no locale.
    .sort((a, b) => {
      const acwid = String(a[0]);
      const bcwid = String(b[0]);
      return acwid < bcwid ? -1 : acwid > bcwid ? 1 : Number(a[YEAR_COL]) - Number(b[YEAR_COL]);
    });

  return csvResponse(rows, center.code, cwidParam);
}
