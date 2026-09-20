/**
 * The shared `<h1>` block of every `/edit/reports/[n]` page — the report's
 * numbered name from `report_meta` (`lib/edit/report-meta.ts`), the
 * superuser-only pencil that edits it (`ReportMetaEditor`, a client island),
 * the page's own dynamic subtitle (`children` — kind- or mode-dependent
 * wording each page still owns), and, when the report has a description, a
 * closed-by-default "About this report" disclosure. An async SERVER
 * component: the meta read is `cache()`d, so it shares the page's
 * `generateMetadata` read; no client state of its own — the `<details>` is
 * native, nothing to hydrate.
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
  /** The page's dynamic subtitle `<p>`, rendered between the `<h1>` and the disclosure. */
  children?: React.ReactNode;
};

export async function ReportHeader({ n, session, children }: ReportHeaderProps) {
  const meta = await reportMetaFor(n);
  return (
    <>
      {/* `flex-wrap`: the collapsed pencil sits beside the h1; the open form is
          `basis-full`, so it wraps onto its own row beneath. */}
      <div className="flex flex-wrap items-start gap-2">
        <h1 className="mb-1 text-xl font-bold">{reportLabel(meta)}</h1>
        {session.isSuperuser && (
          <ReportMetaEditor
            n={n}
            meta={{ name: meta.name, summary: meta.summary, descriptionHtml: meta.descriptionHtml }}
          />
        )}
      </div>
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
    </>
  );
}
