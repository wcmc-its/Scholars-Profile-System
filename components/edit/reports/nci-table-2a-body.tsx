/**
 * Report 2 — "NCI Table 2a" (formerly the `?attr=nci-2a` tab inside
 * `/edit/center/[code]`; `2026-08-08-cancer-center-nci-table-2a-feature-
 * plan.md`). Hosts `Nci2aCard`, which no longer wraps its content in
 * `EditPanel` — that wrapper's `<h2 id="panel-heading">` duplicated the
 * page's own `<h1>` right below it, and its `aria-labelledby="panel-heading"`
 * contract is dead here (`ConsoleShell`'s `<main id="console-main">` doesn't
 * reference it), so it was purely a second title (same precedent as
 * `cancer-center-collab-report-card.tsx`, see its own top comment). The body
 * of what was `app/edit/reports/2/page.tsx`, moved verbatim into the registry
 * shape (`lib/edit/report-registry.ts`): the session / gate / shell / header
 * frame is the dynamic page's; this owns only the report. Unit-gated,
 * center-only (`REPORT_NUMBERS_BY_KIND`). No subtitle.
 */
import { Nci2aCard } from "@/components/edit/cancer-center-nci-2a-card";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

/** Report 2's body: the NCI Table 2a funding-review card for `code`. */
export async function renderNciTable2aReport({ code }: UnitReportProps): Promise<ReportRender> {
  return { main: <Nci2aCard centerCode={code} /> };
}
