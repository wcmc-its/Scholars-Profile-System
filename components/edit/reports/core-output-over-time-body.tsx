/**
 * Report 12 — "Output over time" body (core-only; mockup `Core Reports.dc.html`).
 * A rail (year basis + window, evidence) in a GET `AutoSubmitForm`; the
 * headline with the `.xlsx` button; By year (one bar per year, the current
 * year tagged YTD, a bar opens to its papers — native `<details>`) and
 * Publications tabs.
 *
 * Parser, loader, precedence and workbook: `lib/edit/core-output-report.ts`;
 * the download (`/api/edit/reports/core-output-over-time`) takes the same
 * query string. No fiscal-year basis: `publication` has no publication month
 * (see that module's header).
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  ApplyFallback,
  BarList,
  CoreScopeInputs,
  CoreTabs,
  DownloadAside,
  RadioGroup,
  YearWindow,
} from "@/components/edit/reports/core-report-ui";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import {
  coreQueryString,
  loadCoreConfirmedPmids,
  toSearchParams,
  yearOptions,
} from "@/lib/edit/core-report-common";
import {
  buildCoreOutput,
  coreOutputQuery,
  EVIDENCE_LABEL,
  EVIDENCE_ORDER,
  isCoreOutputDefault,
  loadCoreOutputPubs,
  OUTPUT_BASIS_LABEL,
  parseCoreOutputParams,
  type CoreOutputParams,
  type CoreOutputResult,
  type OutputBasis,
} from "@/lib/edit/core-output-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Exported for the render test. */
export function CoreOutputView({
  coreId,
  basePath,
  params,
  result,
  now,
}: {
  coreId: string;
  basePath: string;
  params: CoreOutputParams;
  result: CoreOutputResult;
  now: Date;
}) {
  const href = (view: CoreOutputParams["view"]) =>
    `${basePath}?${coreQueryString(coreId, coreOutputQuery(params, view))}`;
  const thisYear = now.getUTCFullYear();
  const max = Math.max(1, ...result.years.map((y) => y.total));
  const basisText = params.basis === "added" ? "by year added to PubMed" : "calendar year";
  return (
    <div data-testid="core-output">
      <ReportStats
        stats={[
          {
            value: result.total.toLocaleString(),
            label: `confirmed publications, ${params.from}–${params.to} (${basisText})`,
          },
        ]}
        aside={
          <DownloadAside
            href={`/api/edit/reports/core-output-over-time?${coreQueryString(coreId, coreOutputQuery(params))}`}
            note="Includes the Criteria, By year and Publications sheets."
            testId="core-output"
          />
        }
      />
      <CoreTabs
        testId="core-output-view"
        tabs={[
          { key: "year", label: "By year", href: href("year"), current: params.view === "year" },
          {
            key: "publications",
            label: `Publications (${result.total.toLocaleString()})`,
            href: href("publications"),
            current: params.view === "publications",
          },
        ]}
      />
      {result.total === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm" data-testid="core-output-empty">
          No confirmed publications match these filters.
        </p>
      ) : params.view === "publications" ? (
        <>
          {/* Below lg the table would clip Evidence/Year off-screen, so phones
            get the same rows stacked (the /edit/core index pattern). */}
          <ul className="mt-4 lg:hidden" data-testid="core-output-cards">
            {result.publications.map((p) => (
              <li key={p.pmid} className="border-apollo-border border-b py-2.5 text-sm">
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold hover:underline"
                >
                  <PubTitle value={p.title} />
                </a>
                <div className="text-muted-foreground text-xs">
                  {p.journal && (
                    <>
                      <PubJournal as="span" value={p.journal} />
                      {" · "}
                    </>
                  )}
                  {p.basisYear} · {EVIDENCE_LABEL[p.evidence]}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 hidden overflow-x-auto lg:block">
            <table
              className="w-full min-w-[560px] border-collapse text-sm"
              data-testid="core-output-table"
            >
              <thead>
                <tr className="border-apollo-border text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
                  <th className="py-2 pr-3">Publication</th>
                  <th className="py-2 pr-3">Evidence</th>
                  <th className="py-2 text-right">Year</th>
                </tr>
              </thead>
              <tbody>
                {result.publications.map((p) => (
                  <tr key={p.pmid} className="border-apollo-border border-b align-top">
                    <td className="py-2 pr-3">
                      <a
                        href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold hover:underline"
                      >
                        <PubTitle value={p.title} />
                      </a>
                      {p.journal && (
                        <PubJournal
                          as="span"
                          value={p.journal}
                          className="text-muted-foreground block text-xs"
                        />
                      )}
                    </td>
                    <td className="py-2 pr-3">{EVIDENCE_LABEL[p.evidence]}</td>
                    <td className="py-2 text-right tabular-nums">{p.basisYear}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <BarList
          head="Year"
          valueHead="Publications"
          testId="core-output-years"
          bars={result.years.map((y) => ({
            key: String(y.year),
            label: String(y.year),
            value: y.total.toLocaleString(),
            fraction: y.total / max,
            tag: y.year === thisYear ? "YTD" : undefined,
            muted: y.year === thisYear,
            items:
              y.pubs.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
                  {y.pubs.map((p) => (
                    <li key={p.pmid}>
                      <PubTitle value={p.title} className="font-medium" />
                      <span className="text-muted-foreground block text-xs">
                        {p.journal && (
                          <>
                            <PubJournal as="span" value={p.journal} />
                            {" · "}
                          </>
                        )}
                        {EVIDENCE_LABEL[p.evidence]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : undefined,
          }))}
        />
      )}
      <div
        className="text-muted-foreground mt-6 flex max-w-[680px] flex-col gap-1.5 text-[13px]"
        role="note"
      >
        {params.from <= thisYear && thisYear <= params.to && (
          <p>
            {thisYear} counts publications confirmed through {LONG_DATE.format(now)}. The year is
            still filling in.
          </p>
        )}
        {result.undated > 0 && (
          <p>
            {result.undated.toLocaleString()} confirmed publication
            {result.undated === 1 ? " has" : "s have"} no{" "}
            {params.basis === "added" ? "PubMed add date" : "year"} and{" "}
            {result.undated === 1 ? "isn't" : "aren't"} counted.
          </p>
        )}
        <p>
          Select a year to see its publications. Each publication counts once, in one evidence
          group: Manually added, then Acknowledgment, then Core-staff co-author, then Other signals.
          Counts change as the queue is reviewed.
        </p>
      </div>
    </div>
  );
}

export async function renderCoreOutputReport({
  code,
  ctx,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const now = new Date();
  const params = parseCoreOutputParams(toSearchParams(searchParams), now);
  const pmids = await loadCoreConfirmedPmids(code);
  const result = buildCoreOutput(await loadCoreOutputPubs(code, pmids), params);
  const resetHref = isCoreOutputDefault(params, now)
    ? null
    : `${basePath}?${coreQueryString(code, coreOutputQuery({ ...parseCoreOutputParams(new URLSearchParams(), now), view: params.view }))}`;
  const allEvid = params.evid.length === EVIDENCE_ORDER.length;
  const rail = (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to options count publications."
      testId="core-output-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="core-output-filters">
        <CoreScopeInputs coreId={code} view={params.view === "year" ? undefined : params.view} />
        <RailSection
          label="Years"
          summary={`${params.from}–${params.to} · ${params.basis === "added" ? "Added to PubMed" : "Calendar"}`}
          defaultOpen
        >
          <RadioGroup<OutputBasis>
            name="basis"
            value={params.basis}
            options={(Object.keys(OUTPUT_BASIS_LABEL) as OutputBasis[]).map((b) => ({
              value: b,
              label: OUTPUT_BASIS_LABEL[b],
            }))}
          />
          <YearWindow from={params.from} to={params.to} years={yearOptions(now)} />
        </RailSection>
        <RailSection
          label="Evidence"
          summary={allEvid ? "All" : params.evid.map((e) => EVIDENCE_LABEL[e]).join(", ")}
        >
          <RailChecklist
            name="evid"
            roomy
            options={EVIDENCE_ORDER.map((e) => ({
              value: e,
              label: EVIDENCE_LABEL[e],
              count: result.evidenceCounts[e],
            }))}
            selected={allEvid ? [] : params.evid}
            countLabel="Publications"
          />
          <span className="text-muted-foreground text-xs">None checked = all.</span>
        </RailSection>
        <ApplyFallback />
      </AutoSubmitForm>
    </ReportRail>
  );
  const active = (allEvid ? 0 : params.evid.length) + (params.basis !== "cy" ? 1 : 0);

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Confirmed publications of {ctx.unit.name} per year. Each publication counts once, however
        many core users authored it.
      </p>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="lg:hidden">
            <FiltersSheet activeCount={active} testId="core-output-filters-sheet-trigger">
              {rail}
            </FiltersSheet>
          </div>
          <ReportCard>
            <CoreOutputView
              coreId={code}
              basePath={basePath}
              params={params}
              result={result}
              now={now}
            />
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
