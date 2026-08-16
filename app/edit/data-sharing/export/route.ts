/**
 * GET /edit/data-sharing/export — CSV download of the S-Index Phase 1
 * admin/CTSA dashboard (`/edit/data-sharing`). Item-level: one row per
 * suppression-filtered (person, dataset) link, reusing `loadDatasetLinkRows`
 * — that loader already returns the full, unpaginated, suppression-filtered
 * set, which is exactly what an unpaginated export needs; a second loader
 * would just duplicate the same query (see `lib/api/data-sharing-report.ts`'s
 * CSV-export section header).
 *
 * No scope/filter concept: `/edit/data-sharing` is global-only, no unit
 * scoping and no query-param filters (per its own page header comment), so
 * this route carries none either — unlike `/edit/data-quality/export`.
 *
 * v3 additions (2026-08-16 stakeholder pass), stacked on the `?section=`
 * aggregate CSVs:
 * - `?section=methods` — the Methods document as a markdown attachment
 *   (`buildMethodsDoc` + `methodsMarkdown`), so the narrative can travel with
 *   the numbers instead of living only in the on-page dialog. Not a
 *   `CSV_SECTIONS` member — it's not a CSV.
 * - `?section=<X>&grain=items` — ITEM-level (one row per (person, dataset)
 *   link) CSV scoped/organized per section (`buildSectionItemsCsv`), the
 *   drill-down behind each aggregate table. `grain` values other than
 *   `"items"` → 400; `grain=items` without a section, or with
 *   `section=tiers` (no items grain on purpose — the repositories grain IS
 *   the tier drill-down), → 400.
 *
 * Gate order: flag off → 404 · no session → 401 · failed view gate → 404 ·
 * else text/csv attachment. Mirrors `/edit/data-quality/export`.
 */
import { NextResponse } from "next/server";

import {
  buildDataSharingCsv,
  buildSectionCsv,
  buildSectionItemsCsv,
  capDatasetLinkRows,
  CSV_SECTIONS,
  loadDataSharingReport,
  loadDatasetLinkRows,
  SHARE_RATE_YEAR_FLOOR,
  type CsvSection,
} from "@/lib/api/data-sharing-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { canViewDataSharingDashboard, isDataSharingDashboardEnabled } from "@/lib/edit/data-sharing-dashboard";
import { buildMethodsDoc, methodsMarkdown } from "@/lib/edit/data-sharing-methods-doc";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout (`/edit*` behavior).

export async function GET(request: Request) {
  if (!isDataSharingDashboardEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!canViewDataSharingDashboard(session)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // ?section=<aggregate> → per-table CSV of the corresponding on-page table;
  // no param keeps the original item-level export. Unknown section → 400.
  const searchParams = new URL(request.url).searchParams;
  const rawSection = searchParams.get("section");
  const rawGrain = searchParams.get("grain");

  // `grain` is item-grain-only vocabulary: any other value (when present) is
  // a caller error, 400 before touching the DB — same posture as the unknown-
  // section 400 below.
  if (rawGrain !== null && rawGrain !== "items") {
    return new NextResponse("Unknown grain", { status: 400 });
  }
  if (rawGrain === "items") {
    // Item grain needs a section to organize by (a bare grain=items would
    // just duplicate the default export), and `tiers` has no items grain on
    // purpose — `buildSectionItemsCsv`'s doc comment has the rationale.
    if (
      rawSection === null ||
      rawSection === "tiers" ||
      !(CSV_SECTIONS as readonly string[]).includes(rawSection)
    ) {
      return new NextResponse("No items grain for that section", { status: 400 });
    }
    const section = rawSection as CsvSection;
    const linkRows = await loadDatasetLinkRows(db.read);
    const csv = buildSectionItemsCsv(linkRows, section);
    // Unreachable for the sections admitted above (only "tiers" returns
    // null) — defensive so a future null-returning section can't 200 an
    // empty body.
    if (csv === null) {
      return new NextResponse("No items grain for that section", { status: 400 });
    }
    console.log(
      JSON.stringify({
        event: "export_data_sharing",
        cwid: session.cwid,
        section,
        grain: "items",
        ts: new Date().toISOString(),
      }),
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-sharing-${section}-items-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // ?section=methods → the Methods document as a markdown attachment. Checked
  // before the CSV_SECTIONS membership test since "methods" deliberately
  // isn't a CSV section.
  if (rawSection === "methods") {
    const report = await loadDataSharingReport(db.read);
    const doc = buildMethodsDoc(report, { shareRateYearFloor: SHARE_RATE_YEAR_FLOOR });
    console.log(
      JSON.stringify({
        event: "export_data_sharing",
        cwid: session.cwid,
        section: "methods",
        ts: new Date().toISOString(),
      }),
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(methodsMarkdown(doc, report.dataAsOf), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-sharing-methods-${date}.md"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (rawSection !== null) {
    if (!(CSV_SECTIONS as readonly string[]).includes(rawSection)) {
      return new NextResponse("Unknown section", { status: 400 });
    }
    const section = rawSection as CsvSection;
    const report = await loadDataSharingReport(db.read);
    console.log(
      JSON.stringify({
        event: "export_data_sharing",
        cwid: session.cwid,
        section,
        ts: new Date().toISOString(),
      }),
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(buildSectionCsv(report, section), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-sharing-${section}-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const linkRows = await loadDatasetLinkRows(db.read);
  const { rows, total, truncated } = capDatasetLinkRows(linkRows);

  console.log(
    JSON.stringify({
      event: "export_data_sharing",
      cwid: session.cwid,
      rows: rows.length,
      total,
      truncated,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildDataSharingCsv(rows);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="data-sharing-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
