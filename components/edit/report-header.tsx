/**
 * The shared `<h1>` block of every `/edit/reports/[n]` page — the report's
 * numbered name from `report_meta` (`lib/edit/report-meta.ts`), the page's
 * "Who can run this report" popover (`access` — composed by the page, since
 * only it knows whether the report is unit- or row-gated and what rows to
 * hand over), the superuser-only pencil that edits the meta
 * (`ReportMetaEditor`, a client island), the page's own dynamic subtitle
 * (`children` — kind- or mode-dependent wording each page still owns), and,
 * when the report has a description, a closed-by-default "About this
 * report" disclosure. An async SERVER component: the meta read is
 * `cache()`d, so it shares the page's `generateMetadata` read; no client
 * state of its own — the `<details>` is native, nothing to hydrate.
 *
 * The description is stored write-sanitized (`sanitizeOverview`, the route)
 * and re-sanitized here on read (`sanitizeOverviewHtml`) before the raw
 * `dangerouslySetInnerHTML` — the overview precedent (`lib/api/manual-layer.ts`).
 */
import * as React from "react";

import { ReportMetaEditor } from "@/components/edit/report-meta-editor";
import type { EditSession } from "@/lib/auth/superuser";
import { reportLabel, reportMetaFor, type ReportKey } from "@/lib/edit/report-meta";
import { sanitizeOverviewHtml } from "@/lib/edit/validators";
import { OVERVIEW_HTML_CLASS } from "@/lib/utils";

export type ReportHeaderProps = {
  /** Which report — the `report_meta.report_key`. */
  n: ReportKey;
  /** The effective session; only `isSuperuser` is read (the pencil's gate). */
  session: Pick<EditSession, "isSuperuser">;
  /** The report's "Who can run this report" popover (`ReportAccessPopover`,
   *  `components/edit/report-access-popover.tsx`), rendered in the heading
   *  row right after the `<h1>`, before the pencil. The page composes it —
   *  `mode="unit"` for a unit-gated report, `mode="person"` with the grant
   *  rows for a row-gated one — and this header only places it. Omitted →
   *  nothing extra in the row. */
  access?: React.ReactNode;
  /** The page's dynamic subtitle `<p>`, rendered between the `<h1>` and the disclosure. */
  children?: React.ReactNode;
};

export async function ReportHeader({ n, session, access, children }: ReportHeaderProps) {
  const meta = await reportMetaFor(n);
  return (
    <div className="group/report-header">
      {/* `flex-wrap`: the collapsed pencil sits beside the h1; the open form is
          `basis-full`, so it wraps onto its own row beneath. */}
      <div className="flex flex-wrap items-start gap-2">
        <h1 className="mb-1 text-xl font-bold">{reportLabel(meta)}</h1>
        {/* `mt-1.5` centres the 16px glyph on the h1's 28px line box. */}
        {access !== undefined && access !== null && (
          <span className="mt-1.5 inline-flex" data-testid="report-header-access">
            {access}
          </span>
        )}
        {session.isSuperuser && (
          <ReportMetaEditor
            n={n}
            meta={{
              slug: meta.slug,
              name: meta.name,
              summary: meta.summary,
              descriptionHtml: meta.descriptionHtml,
            }}
          />
        )}
      </div>
      {/* Hidden while the pencil's form is open (`data-report-meta-open` on
          the form): the subtitle and the disclosure are what the form edits,
          and both at once read as the same text twice. */}
      <div
        className="group-has-[[data-report-meta-open]]/report-header:hidden"
        data-testid="report-header-rendered"
      >
        {children}
        {meta.descriptionHtml !== null && (
          <details className="text-muted-foreground mt-2 text-sm" data-testid="report-description">
            <summary className="cursor-pointer">About this report</summary>
            <div
              className={OVERVIEW_HTML_CLASS}
              dangerouslySetInnerHTML={{ __html: sanitizeOverviewHtml(meta.descriptionHtml) }}
            />
          </details>
        )}
      </div>
    </div>
  );
}
