/**
 * Report 18 — Publication citation report body. Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`); the download route
 * (`/api/edit/center/[code]/pub-citation`) takes the same query string behind
 * the same `canEditUnit` gate.
 *
 * EVAL's publication export: the period, the membership type and the
 * relevance answer are GET params on a plain form; the table and the `.xlsx`
 * show the same rows in the same seven columns. The answers come from report
 * 17 (`center_publication_relevance`).
 */
import { Download } from "lucide-react";

import { ReportCard, ReportStats } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import { nci2aUnitQuery } from "@/lib/edit/nci-2a-report";
import {
  parsePubCitationParams,
  PUB_CITATION_COLUMNS,
  pubCitationQueryString,
} from "@/lib/edit/pub-citation-report";
import { loadPubCitationReport } from "@/lib/edit/pub-citation-report.server";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

const CONTROL =
  "border-apollo-border-strong bg-apollo-surface h-[34px] rounded-md border px-2 text-sm";
const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export async function renderPubCitationReport({
  code,
  kind,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const params = parsePubCitationParams(sp);
  const rows = await loadPubCitationReport(code, params);
  const unitQuery = nci2aUnitQuery(code, kind);
  const yes = rows.filter((r) => r.relevant === true).length;

  return {
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        <ReportCard>
          <form
            action={basePath}
            className="flex flex-wrap items-end gap-3"
            data-testid="pub-citation-filters"
          >
            {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <label className="flex flex-col gap-1 text-[13px]">
              From
              <input type="date" name="start" defaultValue={params.start} className={CONTROL} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              To
              <input type="date" name="end" defaultValue={params.end} className={CONTROL} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Membership type
              <select name="membership" defaultValue={params.membership} className={CONTROL}>
                <option value="research">Research</option>
                <option value="clinical">Clinical</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Cancer relevant
              <select name="relevance" defaultValue={params.relevance} className={CONTROL}>
                <option value="yes">Yes only</option>
                <option value="all">All</option>
              </select>
            </label>
            <button
              type="submit"
              className="border-foreground/40 hover:bg-apollo-surface-2 h-[34px] rounded border px-3 text-sm"
            >
              Apply
            </button>
          </form>
          <div className="mt-6">
            <ReportStats
              stats={[
                { value: rows.length.toLocaleString(), label: "publications" },
                { value: yes.toLocaleString(), label: "cancer relevant" },
              ]}
              aside={
                <Button asChild variant="apollo">
                  <a
                    href={`/api/edit/center/${encodeURIComponent(code)}/pub-citation?${pubCitationQueryString(params)}`}
                    data-testid="pub-citation-download"
                  >
                    <Download className="size-4" aria-hidden />
                    Download .xlsx
                  </a>
                </Button>
              }
            />
          </div>
        </ReportCard>
        <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-5 py-8 text-sm">
              No publications match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full min-w-[1100px] border-collapse text-[13px] leading-snug"
                data-testid="pub-citation-table"
              >
                <thead>
                  <tr className="bg-apollo-surface-2 text-left">
                    {PUB_CITATION_COLUMNS.map((c, i) => (
                      <th key={c} className={i === 0 ? `${TH} pl-5` : TH}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.pmid} className="border-apollo-border border-b align-top">
                      <td className="py-3 pr-3 pl-5 font-semibold">{r.title}</td>
                      <td className="p-3">
                        {r.investigators.map((i) => (
                          <div key={i.cwid}>
                            <ScholarHoverCard cwid={i.cwid}>
                              <span>{i.line}</span>
                            </ScholarHoverCard>
                          </div>
                        ))}
                      </td>
                      <td className="p-3">{r.journal}</td>
                      <td className="p-3 whitespace-nowrap">{longDate(r.date)}</td>
                      <td className="p-3">
                        {r.relevant === null ? "" : r.relevant ? "Yes" : "No"}
                      </td>
                      <td className="p-3">
                        <a
                          href={`https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline-offset-2 hover:underline"
                        >
                          {r.pmid}
                        </a>
                      </td>
                      <td className="py-3 pr-5 pl-3">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <ReportCard>
          <ul
            className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]"
            data-testid="pub-citation-assumptions"
          >
            <li>
              Rows: publications added to PubMed in the period with at least one confirmed author
              who was a {params.membership === "all" ? "" : `${params.membership} `}member of this
              center on that date.
            </li>
            <li>
              Investigators: every confirmed WCM author, with their program when they were a member
              on the publication date.
            </li>
            <li>
              Cancer relevant and Notes: the answer and reason from the Publication cancer relevance
              report. Blank when it has not been scored.
            </li>
          </ul>
        </ReportCard>
      </div>
    ),
  };
}
