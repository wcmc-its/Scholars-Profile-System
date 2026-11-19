/**
 * GET /edit/research-security/export?view=&campus=&list=&category=&entity=&person=&from=&to=&consortia=&q=&sort=&dir=
 *
 * The current view of the research security dashboard as an `.xlsx`, under the
 * same filters the page reads (`parseResearchSecurityParams`): every row of
 * the view, then Criteria and Methods sheets. `view=paper` adds the exact
 * matched affiliation strings. The view's search text and sort apply as on the
 * page (Not yet attributed is always one row per candidate and paper). `?section=methods` is the Methods text as
 * markdown.
 *
 * Gate order, the same as `/edit/data-sharing/export`: flag off → 404 · no
 * session → 401 · failed view gate → 404. The data is sensitive and
 * per-person, so the log line carries counts and WHO received the file only:
 * `realCwid` is the signed-in person, `impersonatedCwid` the "View as" target
 * (null when there is none).
 */
import { NextResponse } from "next/server";

import {
  arrangeEntityRows,
  arrangeFundingRows,
  arrangePaperRows,
  arrangePersonRows,
  buildEntityRows,
  buildFundingRows,
  buildPaperRows,
  buildPersonRows,
  buildUnattributedRows,
  forConfirmedAuthors,
  loadCategories,
  loadEntities,
  loadMatchedStrings,
  loadResearchSecurityFacts,
  searchUnattributedRows,
} from "@/lib/api/research-security-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import {
  isResearchSecurityDashboardEnabled,
  parseResearchSecurityParams,
  withKnownCategory,
  withKnownEntity,
} from "@/lib/edit/research-security-dashboard";
import {
  buildResearchSecurityMethodsDoc,
  researchSecurityMethodsMarkdown,
} from "@/lib/edit/research-security-methods-doc";
import {
  buildResearchSecurityWorkbook,
  entitySheet,
  fundingSheet,
  matchedStringsSheet,
  paperSheet,
  personSheet,
  unattributedSheet,
} from "@/lib/edit/research-security-xlsx";

export const dynamic = "force-dynamic";

/** Affiliation strings are loaded for at most this many papers per query. */
const STRINGS_BATCH = 2000;

export async function GET(request: Request) {
  if (!isResearchSecurityDashboardEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!(await canViewDashboard(session, "research-security"))) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Audit attribution reads the REAL cwid (effective-identity.ts): under
  // "View as" the file goes to the person signed in, not to the target.
  const realCwid = (await getSession())?.cwid ?? session.cwid;
  const who = { realCwid, impersonatedCwid: session.cwid === realCwid ? null : session.cwid };

  const searchParams = new URL(request.url).searchParams;
  const requested = parseResearchSecurityParams(Object.fromEntries(searchParams));
  const view = requested.view;
  // Same rule as the page: a category the selected list does not have is
  // dropped, so the workbook is never silently empty and its Criteria sheet
  // names the filters that were really applied.
  const known = withKnownCategory(
    requested.filters,
    await loadCategories(db.read, requested.filters),
  );
  const filters = withKnownEntity(known, await loadEntities(db.read, known));
  const methods = buildResearchSecurityMethodsDoc();
  const date = new Date().toISOString().slice(0, 10);
  const facts = await loadResearchSecurityFacts(db.read, filters);

  if (searchParams.get("section") === "methods") {
    console.log(
      JSON.stringify({
        event: "export_research_security",
        ...who,
        section: "methods",
        ts: new Date().toISOString(),
      }),
    );
    return new NextResponse(researchSecurityMethodsMarkdown(methods, facts.dataAsOf), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="research-security-methods-${date}.md"`,
        "Cache-Control": "no-store",
      },
    });
  }

  let matchedStrings;
  let sheet;
  if (view === "person")
    sheet = personSheet(arrangePersonRows(buildPersonRows(facts, filters.campus), requested));
  else if (view === "funding")
    sheet = fundingSheet(arrangeFundingRows(buildFundingRows(facts, filters.campus), requested));
  else if (view === "unattributed")
    sheet = unattributedSheet(
      searchUnattributedRows(buildUnattributedRows(facts, filters.campus), requested.q),
    );
  else if (view === "paper") {
    const papers = arrangePaperRows(buildPaperRows(facts, filters.campus), requested);
    sheet = paperSheet(papers);
    const ids = papers.map((p) => p.article.articleId);
    const strings = [];
    for (let i = 0; i < ids.length; i += STRINGS_BATCH) {
      strings.push(...(await loadMatchedStrings(db.read, ids.slice(i, i + STRINGS_BATCH), filters)));
    }
    matchedStrings = matchedStringsSheet(forConfirmedAuthors(strings, facts, filters.campus));
  } else sheet = entitySheet(arrangeEntityRows(buildEntityRows(facts, filters.campus), requested));

  console.log(
    JSON.stringify({
      event: "export_research_security",
      ...who,
      view,
      rows: sheet.rows.length,
      ts: new Date().toISOString(),
    }),
  );

  const buffer = await buildResearchSecurityWorkbook({
    view,
    filters,
    search: requested.q,
    sheet,
    matchedStrings,
    methods,
    dataAsOf: facts.dataAsOf,
    generatedAt: new Date(),
  });
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="research-security-${view}-${date}.xlsx"`,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
