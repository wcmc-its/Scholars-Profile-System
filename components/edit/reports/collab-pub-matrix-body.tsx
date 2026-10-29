/**
 * Report 19 — Collaborative publication matrix body. Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`). EVAL's report of the same name: the period,
 * membership type, excluded programs and confirmed-only switch are URL
 * params, shared with the xlsx download; the counting is
 * `computeCollabPubMatrix` (`lib/edit/collab-pub-matrix.ts`), over report 17's
 * relevance decisions.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { DownloadAside, YearWindow } from "@/components/edit/reports/core-report-ui";
import { ReportCard } from "@/components/edit/reports/report-ui";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import {
  collabPubMatrixQuery,
  MATRIX_COLUMNS,
  matrixPct,
  matrixPeriodLabel,
  parseCollabPubMatrixParams,
  UNIQUE_ROW_LABEL,
  type MatrixCounts,
} from "@/lib/edit/collab-pub-matrix";
import { loadCollabPubMatrix } from "@/lib/edit/collab-pub-matrix.server";
import { nci2aUnitQuery } from "@/lib/edit/nci-2a-report";
import { pubRelevanceYears } from "@/lib/edit/pub-relevance-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";
const TD = "px-3 py-2.5 text-right tabular-nums";

function MatrixRow({ label, c, strong }: { label: string; c: MatrixCounts; strong?: boolean }) {
  return (
    <tr className={cn("border-apollo-border border-b", strong && "font-semibold")}>
      <td className="py-2.5 pr-3 pl-5">{label}</td>
      <td className={TD}>{c.publications.toLocaleString()}</td>
      {MATRIX_COLUMNS.map((col) => (
        <td key={col.key} className={TD}>
          {c[col.key].toLocaleString()}{" "}
          <span className="text-muted-foreground font-normal">
            ({matrixPct(c[col.key], c.publications)})
          </span>
        </td>
      ))}
    </tr>
  );
}

export async function renderCollabPubMatrixReport({
  code,
  kind,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const params = parseCollabPubMatrixParams(sp);
  const m = await loadCollabPubMatrix(code, params);
  const unitQuery = nci2aUnitQuery(code, kind);
  const excluded = new Set(params.excluded);

  return {
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
          <div className="border-apollo-border flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
            <AutoSubmitForm
              action={basePath}
              className="group flex flex-wrap items-center gap-x-5 gap-y-3"
              data-testid="collab-pub-matrix-filters"
            >
              {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <YearWindow from={params.from} to={params.to} years={pubRelevanceYears()} />
              <select
                name="membership"
                defaultValue={params.membershipType}
                aria-label="Membership type"
                className="border-apollo-border-strong bg-apollo-surface h-[34px] rounded-md border px-2 text-sm"
              >
                <option value="research">Research members</option>
                <option value="clinical">Clinical members</option>
                <option value="any">All members</option>
              </select>
              <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <legend className="text-muted-foreground float-left mr-2 text-[13px]">
                  Exclude
                </legend>
                {m.allPrograms.map((p) => (
                  <label key={p.code} className="flex items-center gap-1" title={p.label}>
                    <input
                      type="checkbox"
                      name="exclude"
                      value={p.code}
                      defaultChecked={excluded.has(p.code)}
                    />
                    {p.code}
                  </label>
                ))}
              </fieldset>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name="confirmed"
                  value="1"
                  defaultChecked={params.confirmedOnly}
                />
                Confirmed relevance only
              </label>
              <button
                type="submit"
                className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm group-data-[hydrated=true]:hidden"
              >
                Apply
              </button>
            </AutoSubmitForm>
            <DownloadAside
              href={`/api/edit/center/${encodeURIComponent(code)}/collab-pub-matrix/xlsx?${collabPubMatrixQuery(params)}`}
              note="Publication Data and Report Details sheets, as in EVAL."
              testId="collab-pub-matrix"
            />
          </div>
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[960px] border-collapse text-sm"
              data-testid="collab-pub-matrix-table"
            >
              <thead>
                <tr className="bg-apollo-surface-2 text-left">
                  <th className={cn(TH, "pl-5")}>Program</th>
                  <th className={cn(TH, "text-right")}>Publications</th>
                  {MATRIX_COLUMNS.map((c) => (
                    <th key={c.key} className={cn(TH, "text-right")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <MatrixRow label={UNIQUE_ROW_LABEL} c={m.unique} strong />
                {m.programs.map((r) => (
                  <MatrixRow key={r.code} label={`${r.code} · ${r.label}`} c={r.counts} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <ReportCard>
          <ul
            className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]"
            data-testid="collab-pub-matrix-assumptions"
          >
            <li>
              Rows: publications from {matrixPeriodLabel(params)} marked cancer relevant on the
              publication cancer relevance report, with at least one confirmed author who was a
              member of this type on the publication&apos;s PubMed entry date. A member counts
              toward their current program.
            </li>
            <li>
              Inter-programmatic: members from two or more programs. Intra-programmatic: two or more
              members in the row&apos;s program (on the unique row, in any one program).
            </li>
            <li>
              Inter-institutional: an author whose PubMed affiliations are all outside Weill
              Cornell, Cornell and NewYork-Presbyterian.
              {m.unknownAffiliation > 0 &&
                ` ${m.unknownAffiliation.toLocaleString()} counted publications have no affiliations yet and are not counted as inter-institutional.`}
            </li>
            <li>High impact: journal impact factor of {HIGH_IMPACT_THRESHOLD} or more.</li>
            {m.notScored > 0 && (
              <li>
                {m.notScored.toLocaleString()} publications in the period have no relevance decision
                yet and are left out.
              </li>
            )}
          </ul>
        </ReportCard>
      </div>
    ),
  };
}
