/**
 * Report 26 for one scholar: the page body of
 * `/edit/scholar/[cwid]/translational-portfolio`. Mockup: the Design canvas
 * "Translational portfolio" (Person artboard; sample data only). Built: the
 * header, Summary, Publications by year, By research area, Publications and
 * stages, Funding and Clinical trials (each grant and trial with its stage),
 * How to read this, the rail and the Download. Not yet: From discovery to
 * trial and Flag stage (plan PR 7), and Clinical uptake (report 27's
 * per-scholar block counts every stage and year, not this page's T0 and T1 in
 * scope).
 *
 * Counts only, never a percentage, a rank or another person. Every count opens
 * the list it counts: a stage's count filters the paper list (`stage`), an
 * area's narrows the page to that area, a year's to that year.
 *
 * Server-rendered: every selection is a link or the rail's GET form, so it
 * lives in the URL. Printing (the Download's PDF) hides the rail and the
 * controls and keeps the stage colours. Loaders and params:
 * `lib/edit/translational-portfolio-scholar.ts`.
 */
import Link from "next/link";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { SELECT } from "@/components/edit/reports/citation-report-parts";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
} from "@/components/edit/reports/report-ui";
import {
  STAGE_FILL,
  StageTag,
  StageTerm,
} from "@/components/edit/reports/translational-portfolio-body";
import {
  PortfolioDownloadMenu,
  ScrollToHash,
} from "@/components/edit/reports/translational-portfolio-client";
import { AreaTerm } from "@/components/edit/reports/translational-portfolio-scholar-client";
import { PubTitle } from "@/components/publication/pub-html";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Button } from "@/components/ui/button";
import { TOPIC_ACTIVITY_SCORE_FLOOR } from "@/lib/api/topic-activity";
import { NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import { COUNTING_RULE, defaultYears } from "@/lib/edit/translational-portfolio-report";
import {
  ACTIVITY_AREA_RULE,
  GRANT_RULE,
  TRIAL_RULE,
  type PortfolioGrant,
  type PortfolioTrial,
} from "@/lib/edit/translational-portfolio-activities";
import {
  AUTHORSHIP_RULE_ALL,
  AUTHORSHIP_RULE_DEFAULT,
  filterByStage,
  loadScholarPortfolio,
  MIN_SCHOLAR_AREA_PAPERS,
  papersByYear,
  parseScholarPortfolioParams,
  rolesOf,
  SCHOLAR_PAGE_SIZE,
  scholarPortfolioPath,
  scholarPortfolioQueryString,
  stageCountsOf,
  stageSpan,
  yearChartKind,
  type AuthorRole,
  type ListStage,
  type PortfolioScholarHead,
  type ScholarPaper,
  type ScholarPortfolioParams,
  WAFFLE_MAX_PER_YEAR,
} from "@/lib/edit/translational-portfolio-scholar";
import { methodologyHref } from "@/lib/methodology-anchors";
import { profilePath } from "@/lib/profile-url";
import {
  countsTotal,
  GRANT_STAGE_RULE,
  STAGE_BUCKETS,
  TRIAL_STAGE_RULE,
  TRANSLATIONAL_STAGE_LABELS,
  type StageBucket,
  type StageCounts,
  type TranslationalStage,
} from "@/lib/translational-stage";
import { cn } from "@/lib/utils";

const H2 = "text-xl font-semibold";
const EYEBROW = "text-muted-foreground text-xs font-medium tracking-[0.05em] uppercase";
const LINK = "text-apollo-slate hover:underline";
/** A paper with no stage: an outlined, neutral square or tag. */
const NO_STAGE_EDGE = "#b8afa6";
const SQUARE = 14;
const GAP = 3;
/** Rows of squares per year column before it adds a column. */
const SQUARE_ROWS = 12;
const BAR_HEIGHT = 160;

const code = (k: StageBucket) => (k === "none" ? NO_STAGE_LABEL : k.replace("-", "–"));
const ROLE_LABEL: Record<AuthorRole, string> = {
  First: "First author",
  Senior: "Senior author",
  Middle: "Middle author",
};

/** `searchParams` as Next hands them → URLSearchParams. */
export function toSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

export const scholarPortfolioXlsxHref = (cwid: string, p: ScholarPortfolioParams) =>
  `/api/edit/reports/translational-portfolio-scholar?${new URLSearchParams([
    ["cwid", cwid],
    // The link back (`r`) is no part of the download.
    ...[...new URLSearchParams(scholarPortfolioQueryString({ ...p, page: 1 }))].filter(([k]) => k !== "r"),
  ])}`;

/** The page's header: back link, headshot, the name as the h1, title ·
 *  department, CWID, Open profile, and the Download menu. */
export function ScholarPortfolioHeader({
  scholar,
  params,
  back,
}: {
  scholar: PortfolioScholarHead;
  params: ScholarPortfolioParams;
  back: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-4">
      <Link
        href={back.href}
        className={cn(LINK, "self-start text-sm print:hidden")}
        data-testid="portfolio-back"
      >
        &larr; Back to {back.label}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-4">
          <HeadshotAvatar cwid={scholar.cwid} preferredName={scholar.preferredName} size="lg" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={EYEBROW}>Translational portfolio</span>
            <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-0.025em]">
              {scholar.name}
            </h1>
            {(scholar.title || scholar.department) && (
              <span className="text-muted-foreground text-sm">
                {[scholar.title, scholar.department].filter(Boolean).join(" · ")}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span className="font-mono" data-testid="portfolio-cwid">
                {scholar.cwid}
              </span>
              {scholar.slug && (
                <a
                  href={profilePath(scholar.slug)}
                  className={cn(LINK, "font-medium print:hidden")}
                >
                  Open profile
                </a>
              )}
            </span>
          </div>
        </div>
        <div className="print:hidden">
          <PortfolioDownloadMenu
            xlsxHref={scholarPortfolioXlsxHref(scholar.cwid, params)}
            xlsxNote="This scholar's publications in the current filters, one row each, with the criteria"
          />
        </div>
      </div>
    </div>
  );
}

/** One square per paper, coloured by stage (No stage outlined). */
function Square({ k }: { k: StageBucket }) {
  const bg = k === "none" ? "#ffffff" : STAGE_FILL[k].bg;
  const edge = k === "none" ? NO_STAGE_EDGE : bg;
  return (
    <span
      className="block shrink-0 rounded-[3px]"
      style={{
        width: SQUARE,
        height: SQUARE,
        background: bg,
        boxShadow: `inset 0 0 0 1px ${edge}`,
      }}
    />
  );
}

/** A stage's squares in stage order, T0 first. */
const cellsOf = (c: StageCounts) =>
  STAGE_BUCKETS.flatMap((k) => Array.from({ length: c[k] }, () => k));

const ariaCounts = (c: StageCounts) => STAGE_BUCKETS.map((k) => `${code(k)} ${c[k]}`).join(", ");

export async function ScholarPortfolioBody({
  scholar,
  searchParams,
}: {
  scholar: PortfolioScholarHead;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const p = parseScholarPortfolioParams(toSearchParams(searchParams));
  const data = await loadScholarPortfolio(scholar.cwid, p);
  const base = scholarPortfolioPath(scholar.cwid);
  const href = (q: Partial<ScholarPortfolioParams>, hash = "") =>
    `${base}?${scholarPortfolioQueryString({ ...p, page: 1, ...q })}${hash}`;

  const counts = stageCountsOf(data.papers);
  const total = countsTotal(counts);
  const yearsLabel = p.from === p.to ? String(p.from) : `${p.from} to ${p.to}`;
  const authorship = p.middle ? "Any author position" : "First or senior author";
  const byYear = papersByYear(data.papers, p.from, p.to);
  const chart = yearChartKind(byYear);
  const maxYear = Math.max(1, ...byYear.map((r) => countsTotal(r.counts)));
  const cols = Math.max(1, Math.ceil(maxYear / SQUARE_ROWS));

  const listed = filterByStage(data.papers, p.stage);
  const pages = Math.max(1, Math.ceil(listed.length / SCHOLAR_PAGE_SIZE));
  const page = Math.min(p.page, pages);
  const shown = listed.slice((page - 1) * SCHOLAR_PAGE_SIZE, page * SCHOLAR_PAGE_SIZE);
  const fromN = listed.length === 0 ? 0 : (page - 1) * SCHOLAR_PAGE_SIZE + 1;
  const toN = Math.min(listed.length, page * SCHOLAR_PAGE_SIZE);
  const stageHref = (k: ListStage | null) => href({ stage: k }, "#p-pubs");

  // The rail.
  const defaults = defaultYears();
  const isDefault =
    p.from === defaults.from &&
    p.to === defaults.to &&
    p.areas.length === 0 &&
    !p.middle &&
    p.stage === null;
  const areaLabel = new Map(data.areaChoices.map((a) => [a.id, a.label]));
  const years = Array.from({ length: 40 }, (_, i) => new Date().getUTCFullYear() - i);
  const rail = (
    <ReportRail
      resetHref={
        isDefault
          ? null
          : href({ from: defaults.from, to: defaults.to, areas: [], middle: false, stage: null })
      }
      resetLabel="Clear all"
      help="Filters apply automatically."
      className="print:hidden"
      testId="scholar-portfolio-rail"
    >
      <AutoSubmitForm action={base} className="group" data-testid="scholar-portfolio-filters">
        {/* The report's state, for the link back; and the list's stage. */}
        <input type="hidden" name="r" value={p.back} />
        {p.stage && <input type="hidden" name="stage" value={p.stage} />}
        <RailSection
          label="Publication year"
          summary={`${yearsLabel} · Calendar`}
          defaultOpen
          testId="scholar-portfolio-rail-years"
        >
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <select name="from" defaultValue={p.from} aria-label="From year" className={SELECT}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground text-[13px]">to</span>
            <select name="to" defaultValue={p.to} aria-label="To year" className={SELECT}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </RailSection>
        <RailSection
          label="Research area"
          summary={
            p.areas.length === 0
              ? "All of their areas"
              : p.areas.length <= 2
                ? p.areas.map((a) => areaLabel.get(a) ?? a).join(", ")
                : `${p.areas.length} selected`
          }
          defaultOpen
          testId="scholar-portfolio-rail-area"
        >
          {data.areaChoices.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No research area has {MIN_SCHOLAR_AREA_PAPERS} or more of these papers.
            </p>
          ) : (
            <RailChecklist
              name="area"
              roomy
              options={data.areaChoices.map((a) => ({ value: a.id, label: a.label, count: a.n }))}
              selected={p.areas}
              searchPlaceholder="Search research areas…"
              collapseAfter={6}
            />
          )}
          <p className="text-muted-foreground text-xs">
            Areas with at least {MIN_SCHOLAR_AREA_PAPERS} papers. None checked = all. A paper can
            sit in more than one.
          </p>
        </RailSection>
        <RailSection
          label="Authorship"
          summary={authorship}
          defaultOpen
          testId="scholar-portfolio-rail-authorship"
        >
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
            Include middle-author papers
            <input
              type="checkbox"
              name="authorship"
              value="all"
              defaultChecked={p.middle}
              className="accent-apollo-maroon size-4"
              data-testid="scholar-portfolio-middle"
            />
          </label>
        </RailSection>
        {/* No-JS fallback; hidden once hydrated. */}
        <div className="px-[18px] pb-4 group-data-[hydrated=true]:hidden">
          <button
            type="submit"
            className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm"
          >
            Apply
          </button>
        </div>
      </AutoSubmitForm>
      <nav
        aria-label="On this page"
        className="border-apollo-rail-border flex flex-col gap-0.5 border-t px-3 pt-[18px] pb-6"
      >
        <span className={cn(EYEBROW, "mx-2 mb-2 tracking-[0.08em]")}>On this page</span>
        {[
          ["#p-summary", "Summary"],
          ["#p-time", "Publications by year"],
          ["#p-areas", "By research area"],
          ["#funding", "Funding"],
          ["#trials", "Clinical trials"],
          ["#p-pubs", "Publications and stages"],
          ["#p-howto", "How to read this"],
        ].map(([to, label]) => (
          <a
            key={to}
            href={to}
            className="hover:bg-apollo-rail-hover text-apollo-ink-2 block rounded-md px-3 py-2 text-sm"
          >
            {label}
          </a>
        ))}
      </nav>
    </ReportRail>
  );

  const activeFilters =
    (p.from !== defaults.from || p.to !== defaults.to ? 1 : 0) +
    p.areas.length +
    (p.middle ? 1 : 0);

  return (
    <div data-testid="scholar-portfolio">
      <ScrollToHash />
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="lg:hidden print:hidden">
            <FiltersSheet activeCount={activeFilters} testId="scholar-portfolio-filters-sheet">
              {rail}
            </FiltersSheet>
          </div>

          <div
            role="note"
            className="bg-apollo-surface-2 border-apollo-border-strong flex flex-col gap-0.5 rounded-[10px] border px-4 py-3"
          >
            <span className="text-[13px] font-medium">Stages assigned by ReCiterAI</span>
            <span className="text-apollo-ink-2 text-[13px]">
              Each stage comes from the publication&rsquo;s abstract and nobody reviews them by
              hand. Corrections are made in ReCiter, not here. A later stage is not a better one.
            </span>
          </div>

          {/* Summary: a count per stage, each opening the list it counts. */}
          <section
            id="p-summary"
            aria-labelledby="p-summary-h"
            className="flex scroll-mt-24 flex-col gap-3"
          >
            <div className="flex flex-col gap-1">
              <h2 id="p-summary-h" className={H2}>
                Summary
              </h2>
              <span className="text-muted-foreground text-[13px]">
                {authorship}, {yearsLabel}
                {p.areas.length > 0
                  ? `, ${p.areas.map((a) => areaLabel.get(a) ?? a).join(", ")}`
                  : ""}
                .
              </span>
            </div>
            <div
              className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
              data-testid="scholar-portfolio-summary"
            >
              <SummaryTile
                label="Publications"
                value={total}
                href={stageHref(null)}
                aria={`${total} publications. Show them all.`}
              />
              {STAGE_BUCKETS.map((k) => (
                <SummaryTile
                  key={k}
                  stage={k}
                  label={
                    <StageTerm k={k}>
                      {k === "none"
                        ? NO_STAGE_LABEL
                        : `${code(k)} ${TRANSLATIONAL_STAGE_LABELS[k]}`}
                    </StageTerm>
                  }
                  value={counts[k]}
                  href={stageHref(k)}
                  aria={`${counts[k]} ${k === "none" ? "publications without a stage" : `${code(k)} publications`}. Show them.`}
                />
              ))}
            </div>
          </section>

          {/* Publications by year. */}
          <section
            id="p-time"
            aria-labelledby="p-time-h"
            className="bg-apollo-surface border-apollo-border flex min-w-0 scroll-mt-24 flex-col gap-4 rounded-xl border px-6 py-5 print:break-inside-avoid"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 id="p-time-h" className={H2}>
                  Publications by year
                </h2>
                <span className="text-muted-foreground text-[13px]">
                  {chart === "squares"
                    ? "One square per publication, so small numbers stay honest."
                    : `Stacked bars: a year has more than ${WAFFLE_MAX_PER_YEAR} publications, too many to draw one square each.`}{" "}
                  Select a year to narrow the page to it.
                </span>
              </div>
              <span aria-hidden className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[13px]">
                {STAGE_BUCKETS.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1.5">
                    <Square k={k} />
                    <span className="font-medium">{code(k)}</span>
                  </span>
                ))}
              </span>
            </div>
            <div
              className="overflow-x-auto"
              data-testid="scholar-portfolio-years"
              data-chart={chart}
            >
              <div className="flex w-max items-end gap-3.5 pb-1">
                {byYear.map((r) => {
                  const n = countsTotal(r.counts);
                  return (
                    <Link
                      key={r.year}
                      href={href({ from: r.year, to: r.year, stage: null })}
                      aria-label={`${r.year}: ${n} publications (${ariaCounts(r.counts)}). Show only ${r.year}.`}
                      className="hover:bg-apollo-surface-2 flex flex-col items-center gap-2 rounded-md p-1"
                      data-testid="year-column"
                    >
                      {chart === "squares" ? (
                        <span
                          aria-hidden
                          className="flex flex-wrap-reverse content-start"
                          style={{ width: cols * (SQUARE + GAP) - GAP, gap: GAP }}
                          data-testid="year-squares"
                        >
                          {cellsOf(r.counts).map((k, i) => (
                            <Square key={i} k={k} />
                          ))}
                        </span>
                      ) : (
                        <span
                          aria-hidden
                          className="flex w-7 flex-col-reverse overflow-hidden rounded-[3px]"
                          style={{ height: Math.round((n / maxYear) * BAR_HEIGHT) }}
                          data-testid="year-bar"
                        >
                          {STAGE_BUCKETS.filter((k) => r.counts[k] > 0).map((k) => (
                            <span
                              key={k}
                              style={{
                                flexGrow: r.counts[k],
                                background: k === "none" ? "#ffffff" : STAGE_FILL[k].bg,
                                boxShadow:
                                  k === "none" ? `inset 0 0 0 1px ${NO_STAGE_EDGE}` : undefined,
                              }}
                            />
                          ))}
                        </span>
                      )}
                      <span className="flex flex-col items-center text-xs tabular-nums">
                        <span className="text-muted-foreground">{r.year}</span>
                        <span className="font-medium">{n}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
            {/* The chart's numbers, for screen readers and as links. */}
            <table className="sr-only" data-testid="scholar-portfolio-years-table">
              <caption>Publications by year and stage, {authorship.toLowerCase()}</caption>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  {STAGE_BUCKETS.map((k) => (
                    <th key={k} scope="col">
                      {code(k)}
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {byYear.map((r) => (
                  <tr key={r.year}>
                    <th scope="row">{r.year}</th>
                    {STAGE_BUCKETS.map((k) => (
                      <td key={k}>{r.counts[k]}</td>
                    ))}
                    <td>{countsTotal(r.counts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* By research area. */}
          <section
            id="p-areas"
            aria-labelledby="p-areas-h"
            className="bg-apollo-surface border-apollo-border flex min-w-0 scroll-mt-24 flex-col gap-1 rounded-xl border px-6 py-5"
            data-testid="scholar-portfolio-areas"
          >
            <div className="mb-2 flex flex-col gap-1">
              <h2 id="p-areas-h" className={H2}>
                By research area
              </h2>
              <span className="text-muted-foreground text-[13px]">
                Which lines of work sit where, for areas with {MIN_SCHOLAR_AREA_PAPERS} or more of
                these papers. Each square is a paper, coloured by stage as above; a paper can count
                in more than one area.
              </span>
            </div>
            {data.areas.length === 0 ? (
              <p className="text-muted-foreground border-apollo-border border-t py-3 text-sm">
                No research area has {MIN_SCHOLAR_AREA_PAPERS} or more of these papers.
              </p>
            ) : (
              data.areas.map((a) => (
                <div
                  key={a.id}
                  className="border-apollo-border grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t py-3 md:grid-cols-[minmax(180px,260px)_48px_minmax(0,1fr)_minmax(120px,180px)]"
                  data-testid="scholar-portfolio-area"
                >
                  <span className="min-w-0">
                    <AreaTerm
                      label={a.label}
                      description={a.description}
                      count={a.n}
                      countNote={`of these papers score ${TOPIC_ACTIVITY_SCORE_FLOOR} or higher in this area.`}
                      href={`/topics/${encodeURIComponent(a.id)}`}
                    />
                  </span>
                  <Link
                    href={href({ areas: [a.id], stage: null }, "#p-pubs")}
                    aria-label={`${a.n} papers in ${a.label}. Show only this area.`}
                    className={cn(LINK, "text-right text-sm font-medium tabular-nums")}
                  >
                    {a.n}
                  </Link>
                  <span
                    role="img"
                    aria-label={ariaCounts(a.counts)}
                    className="col-span-2 flex min-w-0 flex-wrap gap-[3px] md:col-span-1"
                  >
                    {a.n <= WAFFLE_MAX_PER_YEAR ? (
                      cellsOf(a.counts).map((k, i) => <Square key={i} k={k} />)
                    ) : (
                      <span className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-[3px]">
                        {STAGE_BUCKETS.filter((k) => a.counts[k] > 0).map((k) => (
                          <span
                            key={k}
                            style={{
                              flexGrow: a.counts[k],
                              background: k === "none" ? "#ffffff" : STAGE_FILL[k].bg,
                              boxShadow:
                                k === "none" ? `inset 0 0 0 1px ${NO_STAGE_EDGE}` : undefined,
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="text-apollo-ink-2 col-span-2 text-[13px] md:col-span-1">
                    {stageSpan(a.counts)}
                  </span>
                </div>
              ))
            )}
          </section>

          <ActivitySection
            id="funding"
            title="Funding"
            note={`Awards active ${yearsLabel} where they are PI, Co-PI or subaward PI, from WCM sponsored research and NIH RePORTER records. Each award counts once, renewal years included, staged from the abstract.${p.areas.length > 0 ? " Under an area filter, only grants with a research area are listed." : ""}`}
            count={data.grants.length}
            noun={["award", "awards"]}
            empty="No awards in these years."
            testId="scholar-portfolio-grants"
          >
            {data.grants.map((g) => (
              <GrantRow key={g.key} g={g} roles={rolesOf(g, scholar.cwid)} />
            ))}
          </ActivitySection>

          <ActivitySection
            id="trials"
            title="Clinical trials"
            note={`Trials active ${yearsLabel} with them as principal investigator, staged by trial phase.${p.areas.length > 0 ? " Under an area filter, only trials with a research area are listed." : ""}`}
            count={data.trials.length}
            noun={["trial", "trials"]}
            empty="No clinical trials in these years."
            testId="scholar-portfolio-trials"
          >
            {data.trials.map((x) => (
              <TrialRow key={x.key} t={x} />
            ))}
            {/* ponytail: the stage counts stay in the rows; a per-stage summary if a scholar's trial list grows long. */}
          </ActivitySection>

          {/* Publications and stages. */}
          <ReportCard className="flex scroll-mt-24 flex-col gap-1 px-6 py-5 sm:px-6 sm:py-5">
            <div
              id="p-pubs"
              className="mb-2 flex scroll-mt-24 flex-wrap items-baseline justify-between gap-2"
            >
              <div className="flex flex-col gap-1">
                <h2 className={H2}>Publications and stages</h2>
                <span
                  className="text-muted-foreground text-[13px]"
                  data-testid="scholar-portfolio-range"
                >
                  Newest first.{" "}
                  {listed.length === 0
                    ? "No publications match."
                    : `${fromN.toLocaleString()} to ${toN.toLocaleString()} of ${listed.length.toLocaleString()}.`}
                </span>
              </div>
              {p.stage !== "none" && counts.none > 0 && (
                <Link
                  href={stageHref("none")}
                  className={cn(LINK, "text-[13px] print:hidden")}
                  data-testid="scholar-portfolio-unstaged"
                >
                  Show only papers without a stage ({counts.none.toLocaleString()})
                </Link>
              )}
            </div>
            <nav
              aria-label="Filter by stage"
              className="bg-apollo-surface-2 mb-2 flex flex-wrap items-center gap-1.5 rounded-lg px-3.5 py-3 print:hidden"
              data-testid="scholar-portfolio-stage-filter"
            >
              {([null, ...STAGE_BUCKETS] as (ListStage | null)[]).map((k) => {
                const on = p.stage === k;
                return (
                  <Link
                    key={k ?? "all"}
                    href={stageHref(k)}
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px]",
                      on
                        ? "bg-apollo-slate-tint border-apollo-slate"
                        : "bg-apollo-surface border-apollo-border-strong hover:bg-apollo-page",
                    )}
                  >
                    {k !== null && <Square k={k} />}
                    {k === null ? "Every stage" : code(k)}
                  </Link>
                );
              })}
            </nav>
            {shown.length === 0 ? (
              <p className="text-muted-foreground border-apollo-border border-t py-4 text-sm">
                No publications for this combination.
              </p>
            ) : (
              <ul className="m-0 list-none p-0" data-testid="scholar-portfolio-papers">
                {shown.map((w) => (
                  <PaperRow key={w.pmid} w={w} />
                ))}
              </ul>
            )}
            {pages > 1 && (
              <>
                <p className="text-muted-foreground hidden pt-2 text-xs print:block">
                  This printout holds page {page.toLocaleString()} of {pages.toLocaleString()} of
                  the list.
                </p>
                <nav
                  aria-label="Pages"
                  className="border-apollo-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3.5 print:hidden"
                >
                  <span className="text-muted-foreground grow text-[13px]">
                    Page {page.toLocaleString()} of {pages.toLocaleString()}
                  </span>
                  {page > 1 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ page: page - 1 }, "#p-pubs")}>Previous</Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>
                      Previous
                    </Button>
                  )}
                  {page < pages ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ page: page + 1 }, "#p-pubs")}>Next</Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>
                      Next
                    </Button>
                  )}
                </nav>
              </>
            )}
          </ReportCard>

          <section
            id="p-howto"
            aria-labelledby="p-howto-h"
            className="bg-apollo-slate-tint border-apollo-slate-tint-border flex scroll-mt-24 flex-col gap-2 rounded-xl border px-6 py-[18px]"
          >
            <h2 id="p-howto-h" className="text-base font-semibold">
              How to read this
            </h2>
            <p className="text-sm leading-[1.625]">
              This page describes where one person&rsquo;s work sits between basic research and
              population health. It is not a measure of quality or productivity, and it is not meant
              for comparing people: there are no rankings or percentiles here on purpose. With a few
              dozen papers, one misassigned stage changes the picture, so counts are shown rather
              than percentages. ReCiterAI assigns each stage from the publication&rsquo;s abstract
              or summary, and nobody reviews the stages by hand; corrections are made in ReCiter,
              not here. A later stage is not a better one.
            </p>
            <p className="text-muted-foreground text-xs">
              {p.middle ? AUTHORSHIP_RULE_ALL : AUTHORSHIP_RULE_DEFAULT} {COUNTING_RULE}
            </p>
            <p className="text-muted-foreground text-xs">
              {GRANT_RULE} {GRANT_STAGE_RULE} {TRIAL_RULE} {TRIAL_STAGE_RULE} {ACTIVITY_AREA_RULE}
            </p>
            <a
              href={methodologyHref("translationalStage")}
              className={cn(LINK, "self-start text-[13px] font-medium print:hidden")}
            >
              How stages are defined
            </a>
          </section>
        </div>
      </ReportLayout>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  href,
  aria,
  stage,
}: {
  label: React.ReactNode;
  value: number;
  href: string;
  aria: string;
  stage?: StageBucket;
}) {
  return (
    <div
      className="bg-apollo-surface border-apollo-border flex flex-col gap-1.5 rounded-xl border p-4"
      data-testid="summary-tile"
    >
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs leading-[1.35] font-medium">
        {stage && <Square k={stage} />}
        {label}
      </span>
      <span className="text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] tabular-nums">
        {value > 0 ? (
          <Link href={href} aria-label={aria} className="hover:underline">
            {value.toLocaleString()}
          </Link>
        ) : (
          "0"
        )}
      </span>
    </div>
  );
}

function PaperRow({ w }: { w: ScholarPaper }) {
  const pubmed = `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/`;
  return (
    <li
      className="border-apollo-border flex flex-col gap-1.5 border-t py-3.5 print:break-inside-avoid"
      data-testid="scholar-portfolio-paper"
    >
      <a
        href={pubmed}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground text-sm leading-[1.45] hover:underline"
      >
        <PubTitle value={w.title.trim().replace(/\.+$/, "")} />
      </a>
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {w.journal && (
          <>
            <span className="italic">{w.journal}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="tabular-nums">{w.year}</span>
        <span aria-hidden>·</span>
        <span>{ROLE_LABEL[w.role]}</span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-0.5 tabular-nums">
          PMID{" "}
          <a href={pubmed} target="_blank" rel="noopener noreferrer" className={cn(LINK, "ml-0.5")}>
            {w.pmid}
          </a>
          <span className="print:hidden">
            <CopyPmid pmid={w.pmid} />
          </span>
        </span>
      </span>
      <span>
        {w.stage ? (
          <StageTag stage={w.stage} />
        ) : (
          <span
            className="text-apollo-ink-2 inline-flex rounded-full border bg-white px-2 py-px text-xs leading-normal"
            style={{ borderColor: NO_STAGE_EDGE }}
          >
            {NO_STAGE_LABEL}
          </span>
        )}
      </span>
    </li>
  );
}

/** Funding or Clinical trials: a heading with the list's own count, then the list. */
function ActivitySection({
  id,
  title,
  note,
  count,
  noun,
  empty,
  testId,
  children,
}: {
  id: string;
  title: string;
  note: string;
  count: number;
  noun: [string, string];
  empty: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="bg-apollo-surface border-apollo-border flex min-w-0 scroll-mt-24 flex-col gap-1 rounded-xl border px-6 py-5"
      data-testid={testId}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-h`} className={H2}>
            {title}
          </h2>
          <span className="text-muted-foreground text-[13px]">{note}</span>
        </div>
        <span className="text-muted-foreground text-[13px] tabular-nums">
          {count.toLocaleString()} {count === 1 ? noun[0] : noun[1]}
        </span>
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground border-apollo-border border-t py-3 text-sm">{empty}</p>
      ) : (
        <ul className="m-0 list-none p-0">{children}</ul>
      )}
    </section>
  );
}

/** A grant's or trial's stage tag, or the No stage pill. */
function ActivityStage({ stage }: { stage: TranslationalStage | null }) {
  return (
    <span>
      {stage ? (
        <StageTag stage={stage} />
      ) : (
        <span className="text-apollo-ink-2 inline-flex rounded-full border bg-white px-2 py-px text-xs leading-normal" style={{ borderColor: NO_STAGE_EDGE }}>
          {NO_STAGE_LABEL}
        </span>
      )}
    </span>
  );
}

function GrantRow({ g, roles }: { g: PortfolioGrant; roles: string[] }) {
  return (
    <li className="border-apollo-border flex flex-col gap-1.5 border-t py-3.5 print:break-inside-avoid" data-testid="scholar-portfolio-grant">
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
        <span>{roles.join(", ")}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {g.start.slice(0, 4)}–{g.end.slice(0, 4)}
        </span>
      </span>
      <span className="text-sm leading-[1.45]">{g.title}</span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
        <span>{g.funder}</span>
        {g.awardNumber && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">Award {g.awardNumber}</span>
          </>
        )}
      </span>
      <ActivityStage stage={g.stage} />
    </li>
  );
}

function TrialRow({ t }: { t: PortfolioTrial }) {
  return (
    <li className="border-apollo-border flex flex-col gap-1.5 border-t py-3.5 print:break-inside-avoid" data-testid="scholar-portfolio-trial">
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
        {t.trialPhase && (
          <>
            <span>{t.trialPhase}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>Principal investigator</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {t.startYear}–{t.endYear ?? ""}
        </span>
        {t.status && (
          <>
            <span aria-hidden>·</span>
            <span>{t.status.charAt(0) + t.status.slice(1).toLowerCase()}</span>
          </>
        )}
      </span>
      <span className="text-sm leading-[1.45]">{t.title}</span>
      <span className="text-muted-foreground text-xs">
        {t.nct ? (
          <a href={`https://clinicaltrials.gov/study/${t.nct}`} target="_blank" rel="noopener noreferrer" className={LINK}>
            {t.nct}
          </a>
        ) : (
          <>Protocol {t.protocolNumber}</>
        )}
      </span>
      <ActivityStage stage={t.stage} />
    </li>
  );
}
