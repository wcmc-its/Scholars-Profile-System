/**
 * GET /edit/data-sharing/export — CSV download of the S-Index Phase 1
 * admin/CTSA dashboard (`/edit/data-sharing`). Item-level: one row per
 * suppression-filtered (person, dataset) link, reusing `loadDatasetLinkRows`
 * — that loader already returns the full, unpaginated, suppression-filtered
 * set, which is exactly what an unpaginated export needs; a second loader
 * would just duplicate the same query (see `lib/api/data-sharing-report.ts`'s
 * CSV-export section header).
 *
 * No UNIT-scope concept: `/edit/data-sharing` is global-only (no unit
 * scoping), unlike `/edit/data-quality/export`. It DOES have query params of
 * its own: `?section=<X>&grain=items` carries a per-row department/cwid/
 * repository/category/subtype drill-down filter (below), and the on-page
 * year/tier/nihFunded filters (`lib/api/data-sharing-report.ts`'s
 * `DataSharingReportFilters`) now narrow every export path the same way they
 * narrow the on-page tables (2026-08-16, GitHub #2470: this route used to
 * ignore them entirely; the dashboard's `FilterBar` caption says so). All
 * three export paths below parse the same `?yearFrom`/`yearTo`/`tier`/
 * `nihFunded` query params the page itself reads, via `parseDataSharingParams`
 * (this route builds that function's expected input from its own
 * `URLSearchParams` via `searchParamsToRecord`, since a Route Handler doesn't
 * get the page's already-parsed `searchParams` object for free).
 *
 * v3 additions (2026-08-16 stakeholder pass), stacked on the `?section=`
 * aggregate CSVs:
 * - `?section=methods` — the Methods document as a markdown attachment
 *   (`buildMethodsDoc` + `methodsMarkdown`), so the narrative can travel with
 *   the numbers instead of living only in the on-page dialog. Not a
 *   `CSV_SECTIONS` member (it's not a CSV), and it does NOT apply the active
 *   filter (it isn't a `DownloadLink` on the page either, so there is no
 *   filter state to carry): it describes the methodology, not a filtered
 *   slice of the data.
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
  applyNihFilter,
  applyReportFilters,
  buildDataSharingCsv,
  buildSectionCsv,
  buildSectionItemsCsv,
  capDatasetLinkRows,
  CSV_SECTIONS,
  loadDataSharingReport,
  loadDatasetLinkRows,
  loadFundingSplit,
  SHARE_RATE_YEAR_FLOOR,
  type DataSharingReportClient,
  type DataSharingReportFilters,
  type DatasetLinkRow,
  type CsvSection,
  type SectionItemsFilter,
} from "@/lib/api/data-sharing-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  canViewDataSharingDashboard,
  isDataSharingDashboardEnabled,
  parseDataSharingParams,
} from "@/lib/edit/data-sharing-dashboard";
import { buildMethodsDoc, methodsMarkdown } from "@/lib/edit/data-sharing-methods-doc";

/** Converts a `URLSearchParams` into the `Record<string, string | string[] |
 *  undefined>` shape `parseDataSharingParams` expects (the page itself gets
 *  this shape for free from Next's `searchParams` prop; a Route Handler only
 *  gets a `Request`, so this route builds it). A plain `Object.fromEntries`
 *  would silently keep just the LAST value of a repeated key, dropping every
 *  tier but one from a multi-tier `tier=` filter (checkboxes emit exactly
 *  that shape), so repeated keys are collected into an array instead. */
function searchParamsToRecord(sp: URLSearchParams): Record<string, string | string[] | undefined> {
  const record: Record<string, string | string[]> = {};
  for (const [key, value] of sp.entries()) {
    const existing = record[key];
    if (existing === undefined) record[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else record[key] = [existing, value];
  }
  return record;
}

/** Applies the on-page filters to an item-level row set, for the two export
 *  paths that read `loadDatasetLinkRows` directly rather than a pre-built
 *  `DataSharingReport` (`?section=<X>&grain=items` and the bare item-level
 *  export; the `?section=<X>` aggregate path applies filters via
 *  `loadDataSharingReport` itself, which already accepts a `filters` param).
 *  The NIH-funded grant join (`loadFundingSplit`) only runs when the filter
 *  actually asks for it, so a plain items export doesn't pay for an extra
 *  query it doesn't need (2026-08-16, GitHub #2470). `linkRows` (unfiltered)
 *  is the population `loadFundingSplit` computes `nihByPmid` from, same
 *  reasoning as `loadDataSharingReport`'s own sequencing in the report lib. */
async function filterExportRows(
  client: DataSharingReportClient,
  linkRows: DatasetLinkRow[],
  filters: DataSharingReportFilters,
): Promise<DatasetLinkRow[]> {
  const filtered = applyReportFilters(linkRows, filters);
  if (filters.nihFunded === undefined) return filtered;
  const { nihByPmid } = await loadFundingSplit(client, linkRows);
  return applyNihFilter(filtered, filters.nihFunded, nihByPmid);
}

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
  // The same year/tier/nihFunded filter the on-page tables read, parsed the
  // same way the page itself does (2026-08-16, GitHub #2470) so this route
  // can't drift from `parseDataSharingParams`'s own rules for what counts as
  // a valid filter value.
  const { filters } = parseDataSharingParams(searchParamsToRecord(searchParams));

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
    // Per-row drill-down (2026-08-16 ask: each table row gets its own items
    // link, not just one items link for the whole table) — every param is
    // optional and independent of `section`; `buildSectionItemsCsv` ignores
    // ones that don't apply (e.g. `cwid` on a `"departments"` request).
    const filter: SectionItemsFilter = {
      department: searchParams.get("department") ?? undefined,
      cwid: searchParams.get("cwid") ?? undefined,
      repository: searchParams.get("repository") ?? undefined,
      category: searchParams.get("category") ?? undefined,
      subtype: searchParams.get("subtype") ?? undefined,
    };
    const linkRows = await loadDatasetLinkRows(db.read);
    const rows = await filterExportRows(db.read, linkRows, filters);
    const csv = buildSectionItemsCsv(rows, section, filter);
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
    const report = await loadDataSharingReport(db.read, filters);
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
  const filteredRows = await filterExportRows(db.read, linkRows, filters);
  const { rows, total, truncated } = capDatasetLinkRows(filteredRows);

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
