/**
 * Report 6 — "NIH-funded pubs" (org-unit publications reports plan,
 * 2026-08-16). This unit's member publications that carry a `GrantPublication`
 * link to NIH RePORTER (`lib/edit/nih-funded-publications-report.ts` — see
 * that module's doc comment for the row grain and confidence trigger).
 * Center, department, division, or core — unit-agnostic from day one, same
 * `?center=<code>[&kind=department|division|core]` routing convention as
 * report 3 (the kind resolution is the dynamic page's, `unitKindsFor("6")`).
 * For `kind=core` the `<code>` is the core id, the gate is the core's own
 * owner/curator gate, and the publication set is the core's confirmed
 * `publication_core` usages rather than a member roster.
 *
 * Read-only, server-rendered — no client component, no interaction beyond
 * following a link, matching reports 1/2/4/5's tables.
 *
 * The body of what was `app/edit/reports/6/page.tsx`, moved verbatim into the
 * registry shape (`lib/edit/report-registry.ts`): the session / gate / shell /
 * header frame is the dynamic page's; this owns only the report. The kind-
 * aware subtitle `<p>` is returned as `subtitle` (the header's children).
 */
import { LowerConfidenceBadge } from "@/components/funding/expanded-grant";
import { loadNihFundedPublicationsReport } from "@/lib/edit/nih-funded-publications-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

/** Report 6's body: the unit's publications with a matched NIH RePORTER link. */
export async function renderNihFundedPubsReport({
  code,
  kind,
  ctx,
}: UnitReportProps): Promise<ReportRender> {
  const report = await loadNihFundedPublicationsReport(kind, code);

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        {kind === "core"
          ? `Every publication with a confirmed use of ${ctx.unit.name} and a matched NIH RePORTER funding link.`
          : `Every ${ctx.unit.name} member publication with a matched NIH RePORTER funding link.`}
      </p>
    ),
    main:
      report.totalPublications === 0 ? (
        // Kind-aware: a core has no members, so "for a confirmed member
        // author" would misstate why the report is empty.
        <p className="text-muted-foreground mt-6" data-testid="nih-pubs-report-empty">
          {kind === "core"
            ? "No NIH-funded publications were found among this core's confirmed usages."
            : "No NIH-funded publications were found for a confirmed member author."}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm" data-testid="nih-pubs-report-count-line">
            <strong>{report.totalPublications.toLocaleString()}</strong> publication
            {report.totalPublications === 1 ? "" : "s"} with an NIH RePORTER-linked grant.
          </p>
          <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="nih-pubs-report-table">
              <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
                <tr className="border-apollo-border border-b">
                  <th className={thClass}>Publication</th>
                  <th className={thClass}>Journal</th>
                  <th className={thClass}>Grant</th>
                  <th className={thClass}>Award number</th>
                  <th className={thClass}>Investigators</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr
                    key={`${r.pmid}-${r.grantId}`}
                    className="border-apollo-border border-b align-top"
                    data-testid={`nih-pubs-report-row-${r.pmid}-${r.grantId}`}
                  >
                    <td className={tdClass}>
                      <a
                        href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.pmid)}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {r.title}
                      </a>
                      {r.year === null ? null : (
                        <span className="text-muted-foreground ml-1">({r.year})</span>
                      )}
                      {r.isLowerConfidence ? <LowerConfidenceBadge /> : null}
                    </td>
                    <td className={tdClass}>{r.journal ?? "—"}</td>
                    <td className={tdClass}>{r.grantTitle}</td>
                    <td className={`${tdClass} whitespace-nowrap`}>{r.awardNumber ?? "—"}</td>
                    <td className={tdClass}>
                      {r.investigators.length === 0
                        ? "—"
                        : r.investigators.map((i) => `${i.name} (${i.cwid})`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ),
  };
}
