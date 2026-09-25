/**
 * The report registry — what `app/edit/reports/[report]/page.tsx` (the ONE
 * dynamic report page) dispatches on. Before this (2026-09-20), the seven
 * numbered reports were seven pages (`app/edit/reports/{1..7}/page.tsx`,
 * 81–371 lines each) that repeated the same frame around a different body:
 * session → SSO redirect → the gate → the console tab counts → `ConsoleShell`
 * → "← All reports" → `ReportHeader` → the report. Only the last step was the
 * report. Now the frame lives once in the page, and each report is a registry
 * ENTRY (this file) plus a BODY (`components/edit/reports/<slug>-body.tsx`).
 *
 * An entry is `{ n, gate, render }` (+ `accessKey` for a person gate):
 *   - `n` — the `report_meta.report_key` ("1".."7", `ReportKey`); the stable
 *     identity a slug rename never touches.
 *   - `gate` — how the page authorizes BEFORE the body runs. `"unit"`: the
 *     unit Owner/Curator gate reports 1–6 share (`resolveNumberedReportCenterCode`
 *     + `loadReportsContext`, `lib/edit/cancer-center-reports.ts`); a denied
 *     actor gets the visible 403. `"person"`: a `report_access` row
 *     (`getReportScopes(session, accessKey)`, `lib/edit/report-access.ts`);
 *     an empty scope set reads as an unbuilt route (`notFound()`).
 *   - `render` — the body: an async function of the gate's props that returns
 *     `{ subtitle, main }`. The page renders `subtitle` as `ReportHeader`'s
 *     children (the h1 → subtitle → "About this report" order every page had)
 *     and `main` after the header — the split exists ONLY so the header can
 *     sit between the two halves the body owns. A body owns nothing but the
 *     report: no shell, no back link, no header, no gate.
 *
 * Which unit kinds a unit-gated report serves is NOT restated here:
 * `unitKindsFor` reads `REPORT_NUMBERS_BY_KIND` (`cancer-center-reports.ts`,
 * still the single source of truth the index's catalog and liveness key off),
 * so a report widened to a new kind there is widened here for free.
 *
 * To add report 8: one entry below (`"8": { n: "8", gate, render }`), one body
 * file exporting its `render…Report`, one `REPORT_KEYS` / `REPORT_META_DEFAULTS`
 * entry in `report-meta.ts` (name, summary, slug) and, for a unit report, its
 * number in `REPORT_NUMBERS_BY_KIND`. The page needs no change.
 *
 * Adding a report — checklist. [enforced: <test>] = a failing test catches a
 * miss (text-level; each test's header states its ceiling); [review] = not
 * mechanically checked. Tests: report-filter-guard =
 * `tests/unit/report-filter-guard.test.ts`, person-filter-parity =
 * `tests/unit/person-filter-parity.test.ts`.
 *   - Reserved params, same meaning everywhere: `type` (raw roleCategory,
 *     repeated), `unit` (`dept:` / `div:` / `center:` / `inst:` + CODE,
 *     repeated, OR'd; `div:` includes a manual division's hand-added members),
 *     `list` (a stored CWID list's id, `lib/edit/cwid-list.ts`, resolved by the
 *     caller and passed to the builders as `listCwids`), `from` / `to` (year
 *     window), `q` (name / CWID search).
 *     [enforced for `type` / `unit` reads: report-filter-guard; the rest review]
 *   - Who-filters: `parsePersonFilter` + `personFilterSql` (or
 *     `personFilterWhere`) from `lib/edit/person-filter.ts`, the rail from
 *     `loadDataQualityFacets` rendered with `RosterFacet`. Never re-read
 *     `type` / `unit` yourself, never hand-write an IN list on a who-column
 *     (`role_category`, `deptCode`, …). Units given but none decode match nothing
 *     (the builders do this). [enforced: report-filter-guard (reads + who-column
 *     allowlist; scans every module under `lib/edit` + `lib/api` at any depth,
 *     plus report bodies, report routes and `/edit` pages/routes — a report
 *     module elsewhere is not scanned), person-filter-parity (builders agree)]
 *   - The page body and the download route call ONE `parse…Params` and ONE
 *     query loader. [enforced for the parser: report-filter-guard; loader review]
 *   - The export carries a Criteria sheet / block stating every filter, "All"
 *     when unset; the who-filter rows come from `personFilterCriteria`.
 *     [enforced for exports built on parsePersonFilter: report-filter-guard;
 *     the non-who rows review]
 *   - Scholar / email lists: `SCHOLAR_EXPORT_CAP` (50, `lib/api/export-scholars.ts`).
 *     Above it, no download; never truncate to fit. [enforced for an export
 *     with an "email" header literal: report-filter-guard; truncation review]
 *   - A person's name in a table: wrap it in `ScholarHoverCard cwid={…}`
 *     (`components/edit/scholar-hover-card.tsx`) — headshot, email, titles,
 *     overview, fetched on hover. Don't hand-roll a per-report card. [review]
 *   - If it writes: register the action / entity in `lib/edit/audit.ts` AND
 *     all four ENUM sites in `scripts/sql/audit-log.sql`. [review]
 *   - No `@/lib/db`, `@/lib/edit/person-filter` or the Prisma client as a VALUE
 *     import in a `"use client"` file under `components/edit` (type-only is
 *     fine). [enforced, direct + one hop: report-filter-guard; deeper chains:
 *     the Next build]
 *
 * Server-only: this module imports the bodies, which import loaders that reach
 * `@/lib/db`. Never import it from a `"use client"` file (the
 * `manageable-units.ts` trap in CLAUDE.md).
 */
import type * as React from "react";

import { renderArticleCountReport } from "@/components/edit/reports/article-count-body";
import { renderClinicalTrialsReport } from "@/components/edit/reports/clinical-trials-body";
import { renderGrantsReport } from "@/components/edit/reports/grants-body";
import { renderHighImpactPublicationsReport } from "@/components/edit/reports/high-impact-publications-body";
import { renderMentoredPublicationsReport } from "@/components/edit/reports/mentored-publications-body";
import { renderNciTable2aReport } from "@/components/edit/reports/nci-table-2a-body";
import { renderNihFundedPubsReport } from "@/components/edit/reports/nih-funded-pubs-body";
import { renderOptimizeMembershipReport } from "@/components/edit/reports/optimize-membership-body";
import { renderPublicationsReport } from "@/components/edit/reports/publications-body";
import type { EditSession } from "@/lib/auth/superuser";
import {
  REPORT_NUMBERS_BY_KIND,
  type ReportableUnitKind,
  type ReportsContext,
} from "@/lib/edit/cancer-center-reports";
import { HIGH_IMPACT_PUBS_REPORT, MENTORED_PUBS_REPORT } from "@/lib/edit/report-access";
import type { ReportKey } from "@/lib/edit/report-meta";

/** The page's `searchParams`, awaited — Next's shape (a repeated key is an array). */
export type ReportSearchParams = Record<string, string | string[] | undefined>;

/** What a unit-gated body (reports 1–6) is handed once the gate has passed:
 *  the resolved unit (`code` + `kind`, from `resolveNumberedReportCenterCode`)
 *  and its context (`ctx`, from `loadReportsContext` — never null here). */
export type UnitReportProps = {
  n: ReportKey;
  code: string;
  kind: ReportableUnitKind;
  ctx: ReportsContext;
  session: EditSession;
  searchParams: ReportSearchParams;
  /** The canonical `/edit/reports/<slug>` — for the body's OWN links (a
   *  filter form's `action`, a tab href), never a literal path. */
  basePath: string;
};

/** What a person-gated body (report 7) is handed once the gate has passed:
 *  the non-empty scope set `getReportScopes` resolved for the session. */
export type PersonReportProps = {
  n: ReportKey;
  scopes: ReadonlySet<string>;
  session: EditSession;
  searchParams: ReportSearchParams;
  /** See `UnitReportProps.basePath`. */
  basePath: string;
};

/** What an administrator-gated body (report 8) is handed: the gate is
 *  `canViewArticleCountReport` (any unit administrator), nothing to scope. */
export type AdminReportProps = {
  n: ReportKey;
  session: EditSession;
  searchParams: ReportSearchParams;
  /** See `UnitReportProps.basePath`. */
  basePath: string;
};

/** What a body returns. `subtitle` becomes `ReportHeader`'s children (the
 *  page's dynamic `<p>` between the h1 and the "About this report"
 *  disclosure — reports 3–7 have one, 1–2 none); `main` renders after the
 *  header. */
export type ReportRender = {
  subtitle?: React.ReactNode;
  main: React.ReactNode;
};

/** One registry entry — see the module comment for the two gates. */
export type ReportDef =
  | {
      n: ReportKey;
      gate: "unit";
      render: (props: UnitReportProps) => Promise<ReportRender>;
    }
  | {
      n: ReportKey;
      gate: "person";
      /** The `report_access.report_key` the gate reads (`getReportScopes`). */
      accessKey: string;
      render: (props: PersonReportProps) => Promise<ReportRender>;
    }
  | {
      n: ReportKey;
      /** Any unit administrator (`canViewArticleCountReport`); a denied actor
       *  gets `notFound()`, like the person gate. */
      gate: "admin";
      render: (props: AdminReportProps) => Promise<ReportRender>;
    };

/** Every report, by `report_meta.report_key`. Reports 1–6 are unit-gated;
 *  reports 7 (Mentored publications) and 9 (Top clinical and high-impact journal publications) are
 *  person-gated on their `report_access` keys. */
export const REPORTS: Record<ReportKey, ReportDef> = {
  "1": { n: "1", gate: "unit", render: renderOptimizeMembershipReport },
  "2": { n: "2", gate: "unit", render: renderNciTable2aReport },
  "3": { n: "3", gate: "unit", render: renderPublicationsReport },
  "4": { n: "4", gate: "unit", render: renderGrantsReport },
  "5": { n: "5", gate: "unit", render: renderClinicalTrialsReport },
  "6": { n: "6", gate: "unit", render: renderNihFundedPubsReport },
  "7": {
    n: "7",
    gate: "person",
    accessKey: MENTORED_PUBS_REPORT,
    render: renderMentoredPublicationsReport,
  },
  "8": { n: "8", gate: "admin", render: renderArticleCountReport },
  "9": {
    n: "9",
    gate: "person",
    accessKey: HIGH_IMPACT_PUBS_REPORT,
    render: renderHighImpactPublicationsReport,
  },
};

/** The unit kinds a unit-gated report serves — the `allowedKinds` the page
 *  hands `resolveNumberedReportCenterCode` — derived from
 *  `REPORT_NUMBERS_BY_KIND` (the kinds whose list includes `Number(n)`), in
 *  that record's key order (`center` first, so reports 1/2/4/5 yield exactly
 *  `["center"]`, the resolver's own default). Empty for a report no kind
 *  lists (report 7, which is not unit-gated at all). */
export function unitKindsFor(n: ReportKey): readonly ReportableUnitKind[] {
  const number = Number(n);
  return (Object.keys(REPORT_NUMBERS_BY_KIND) as ReportableUnitKind[]).filter((kind) =>
    (REPORT_NUMBERS_BY_KIND[kind] as readonly number[]).includes(number),
  );
}
