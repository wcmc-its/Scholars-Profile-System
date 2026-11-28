/**
 * `BibliometricsTool` — the client island for the "Bibliometrics" Tools panel
 * (`EDIT_BIBLIOMETRICS`). Fetches the section model from
 * `GET /api/edit/bibliometrics` and renders it. The Download menu's Word and
 * spreadsheet files are the same URL with `format=docx` / `format=xlsx`, so
 * they carry the filters set on screen; its PDF is the page printed.
 * Read-only: nothing here writes.
 */
"use client";

import * as React from "react";
import { ChevronDown, Download, Info, Lock } from "lucide-react";

import { EDIT_PANEL_HEADING_ID } from "@/components/edit/edit-panel";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, pubTitleProps } from "@/components/publication/pub-html";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { citationIdentifier } from "@/lib/citation";
import { authorityBadgeLabel, plural } from "@/lib/citations/policy-rollup";
import {
  NO_SUMMARY_NOTE,
  METRIC_HELP,
  PATENTS_DOWNLOAD_LABEL,
  PATENTS_DOWNLOAD_PATH,
  STAGE_FOLD_BELOW_PCT,
  UNSTAGED_LABEL,
  UNSTAGED_REASONS,
  bibliometricsQuery,
  filtersNote,
  isEarlyPercentile,
  papersFor,
  percentileText,
  unratedNote,
  type BibliometricsCitingDoc,
  type BibliometricsFilters,
  type BibliometricsPaper,
  type BibliometricsPolicyLevel,
  type ImpactKey,
  type BibliometricsReport,
  type BibliometricsStages,
  type CitingLevel,
  type CountKey,
  type UnstagedReason,
} from "@/lib/edit/bibliometrics";
import type { ScholarReach } from "@/lib/edit/downstream-reach-entry";
import { TRANSLATIONAL_STAGES, TRANSLATIONAL_STAGE_LABELS, type StageBucket } from "@/lib/translational-stage";
import { htmlToPlainText, sanitizePubTitle } from "@/lib/utils";

const PATH = "/api/edit/bibliometrics";
const FAILED = "We couldn't load the bibliometrics report just now. Please try again.";

/** One flat section of the single white panel (no card inside the card). */
const SECTION = "flex flex-col gap-3 px-5 pt-7 pb-2 sm:px-7";
const LIGHT_BOX = "bg-apollo-surface-2 rounded-[10px]";
const FILTERED_BADGE =
  "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate rounded-full border px-2 py-px text-xs font-medium";
const LINK = "text-apollo-slate hover:underline";
/** Author position: first author amber, co-author and senior two blues
 *  (Paul's pick 11-28 from the mockup's set). Validated with the dataviz
 *  validator on #ffffff: every check passes (lightness band, chroma, CVD
 *  ΔE 20.3, normal-vision ΔE 20.4); co-author is 2.89:1, so the position
 *  table beside the chart and each segment's hover text carry the values. */
const POSITION_FILL = { first: "#a67012", co: "#6f9ad6", senior: "#2d5c9e" } as const;
const OUTPUT_ROWS = [
  ["First author", "first"],
  ["Senior author", "senior"],
  ["Co-author", "co"],
] as const;
const SELECT = "border-apollo-border-strong bg-apollo-surface min-h-9 rounded-md border px-2 text-sm";

export function BibliometricsTool({ entityId }: { entityId: string }) {
  const [filters, setFilters] = React.useState<BibliometricsFilters>({
    authorship: "all",
    yearFrom: null,
    yearTo: null,
  });
  const [report, setReport] = React.useState<BibliometricsReport | null>(null);
  // Kept with the scholar it was loaded for, so one scholar's block is never
  // drawn on another's tab.
  const [loadedReach, setLoadedReach] = React.useState<{ cwid: string; reach: ScholarReach | null } | null>(null);
  const reach = loadedReach?.cwid === entityId ? loadedReach.reach : null;
  const [failed, setFailed] = React.useState(false);
  const query = bibliometricsQuery(entityId, filters);

  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${PATH}?${query}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { report: BibliometricsReport }) => {
        setReport(d.report);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) {
          console.error("[bibliometrics] load failed", err);
          setFailed(true);
        }
      });
    return () => ctrl.abort();
  }, [query]);

  // The Downstream reach block depends on the scholar alone: its own request,
  // so the report does not wait for it and a filter change does not repeat it.
  // Any failure leaves the tab without the block.
  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${PATH}?${new URLSearchParams({ cwid: entityId, part: "reach" })}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { reach?: ScholarReach | null }) => setLoadedReach({ cwid: entityId, reach: d.reach ?? null }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [entityId]);

  // The PDF is the page printed: every folded part prints open, and folds
  // back after.
  React.useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = [...document.querySelectorAll<HTMLDetailsElement>('[data-slot="bibliometrics-tool"] details:not([open])')];
      for (const d of opened) d.open = true;
    };
    const after = () => {
      for (const d of opened) d.open = false;
      opened = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  const updated = report
    ? new Date(`${report.asOf}T00:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <section
      data-slot="bibliometrics-tool"
      className="bg-apollo-surface border-apollo-border rounded-[var(--apollo-radius-card)] border print:border-0"
    >
      {/* The sticky bar: heading, Download and the filters. Phones scroll it
          away (sticky from md up) so it does not eat a small screen. */}
      <header className="bg-apollo-surface border-apollo-border z-20 rounded-t-[var(--apollo-radius-card)] border-b px-5 pt-5 pb-4 sm:px-7 md:sticky md:top-14 print:static">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id={EDIT_PANEL_HEADING_ID} className="text-2xl font-semibold tracking-[-0.01em]">
              Bibliometrics
            </h2>
            <p className="text-apollo-ink-2 mt-0.5 inline-flex items-center gap-1.5 text-[13px]">
              <Lock className="size-3" aria-hidden />
              Locked: calculated from the publications in Scholars.{updated ? ` Updated ${updated}.` : ""}
            </p>
          </div>
          <DownloadMenu query={query} />
        </div>
        {report ? <FilterBar filters={filters} setFilters={setFilters} yearRange={report.yearRange} /> : null}
        {report ? (
          <p className="mt-2 hidden text-[13px] print:block">Filters: {filtersNote(report.filters) ?? "none"}.</p>
        ) : null}
      </header>
      {failed ? (
        <Alert variant="destructive" data-testid="bibliometrics-error" className="mx-5 mt-5 w-auto sm:mx-7">
          <AlertDescription>{FAILED}</AlertDescription>
        </Alert>
      ) : null}
      {report ? (
        <Report report={report} reach={reach} />
      ) : failed ? null : (
        <p className="text-muted-foreground px-5 py-6 text-sm sm:px-7">Loading…</p>
      )}
    </section>
  );
}

const DOWNLOADS = [
  ["docx", "Word report", ".docx", "Summary and tables, ready to edit for a dossier or annual review"],
  ["xlsx", "Spreadsheet", ".xlsx", "One tab per section, one row per paper with PMID, DOI and impact counts, plus the citing documents"],
  ["pdf", "PDF", ".pdf", "The page as shown, charts included. Opens the print dialog; choose Save as PDF."],
] as const;
const MENU_ITEM = "hover:bg-apollo-surface-2 focus-visible:bg-apollo-surface-2 block w-full rounded-lg px-3 py-2.5 text-left outline-none";

/** "Download ▾": the Word and spreadsheet files carry the on-screen filters;
 *  the PDF is the page through the print dialog. */
function DownloadMenu({ query }: { query: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="apollo" className="min-h-10 print:hidden" data-testid="bibliometrics-download">
          <Download className="size-4" aria-hidden />
          Download
          <ChevronDown className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5">
        <ul className="m-0 list-none p-0">
          {DOWNLOADS.map(([format, label, ext, blurb]) => {
            const body = (
              <>
                <span className="flex justify-between gap-3">
                  <span className="font-medium">{label}</span>
                  <span className="text-apollo-ink-2">{ext}</span>
                </span>
                <span className="text-apollo-ink-2 mt-0.5 block text-[13px]">{blurb}</span>
              </>
            );
            return (
              <li key={format}>
                {format === "pdf" ? (
                  <button
                    type="button"
                    className={MENU_ITEM}
                    data-testid="bibliometrics-download-pdf"
                    onClick={() => {
                      setOpen(false);
                      // After the menu has closed, so it is not in the PDF.
                      setTimeout(() => window.print(), 0);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <a
                    href={`${PATH}?${query}&format=${format}`}
                    download
                    className={MENU_ITEM}
                    data-testid={`bibliometrics-download-${format}`}
                    onClick={() => setOpen(false)}
                  >
                    {body}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <p className="border-apollo-border text-apollo-ink-2 mx-1.5 mt-1.5 border-t px-1.5 pt-2.5 pb-1.5 text-[13px]">
          Every file uses the current filters and notes the date.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function FilterBar({
  filters,
  setFilters,
  yearRange,
}: {
  /** The controls follow the local choice; the report catches up when its fetch lands. */
  filters: BibliometricsFilters;
  setFilters: React.Dispatch<React.SetStateAction<BibliometricsFilters>>;
  yearRange: BibliometricsReport["yearRange"];
}) {
  const years = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, i) => yearRange.min + i)
    : [];
  return (
    <div className="bg-apollo-surface-2 border-apollo-border-strong mt-4 flex flex-wrap items-center gap-x-7 gap-y-3 rounded-[10px] border px-4 py-2.5 text-sm print:hidden">
      <fieldset className="flex flex-wrap items-center gap-x-3.5">
        <legend className="float-left mr-3.5 font-medium">Authorship</legend>
        {(
          [
            ["all", "All papers"],
            ["lead", "First or senior author only"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="inline-flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="bibliometrics-authorship"
              checked={filters.authorship === value}
              onChange={() => setFilters((f) => ({ ...f, authorship: value }))}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        {(
          [
            ["yearFrom", "Published", "Published from", yearRange?.min],
            ["yearTo", "to", "Published to", yearRange?.max],
          ] as const
        ).map(([key, label, aria, fallback]) => (
          <React.Fragment key={key}>
            <label htmlFor={`bibliometrics-${key}`} className={key === "yearFrom" ? "font-medium" : undefined}>
              {label}
            </label>
            <select
              id={`bibliometrics-${key}`}
              aria-label={aria}
              className={SELECT}
              value={filters[key] ?? fallback ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, [key]: Number(e.target.value) }))}
            >
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </React.Fragment>
        ))}
      </div>
      <p className="text-apollo-ink-2 ml-auto text-[13px]">
        Applies to sections marked <span className={FILTERED_BADGE}>Filtered</span> and to downloads.
      </p>
    </div>
  );
}

/** A section heading, with the Filtered badge when the section follows the filters. */
function SectionHead({ title, filtered = false }: { title: string; filtered?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <h3 className="text-lg font-semibold">{title}</h3>
      {filtered ? <span className={FILTERED_BADGE}>Filtered</span> : null}
    </div>
  );
}

function Report({
  report: r,
  reach,
}: {
  report: BibliometricsReport;
  /** The "Downstream reach" block; null when the viewer gets none. */
  reach: ScholarReach | null;
}) {
  const peak = Math.max(1, ...r.output.byYear.map((y) => y.count));
  // An even top, so the middle gridline is a whole number.
  const axisMax = Math.ceil(peak / 2) * 2;
  const thisYear = Number(r.asOf.slice(0, 4));
  return (
    <div className="flex flex-col pb-2" data-testid="bibliometrics-report">
      <SummarySection report={r} />

      <section className={SECTION}>
        <SectionHead title="Output" filtered />
        <div className="flex flex-wrap gap-7">
          <PositionTable report={r} />
          <div className="flex min-w-0 flex-[2_1_360px] flex-col gap-1.5">
            <div className="text-sm font-semibold">
              {r.filters.yearFrom === null && r.filters.yearTo === null
                ? "By year, last 10 years"
                : r.output.byYear.length > 0
                  ? `By year, ${r.output.byYear[0]!.year} to ${r.output.byYear.at(-1)!.year}`
                  : "By year"}
            </div>
            <div className="flex gap-2">
              {/* The y-axis: the top, middle and zero gridlines' values. */}
              <div
                aria-hidden
                className="text-apollo-ink-2 flex h-[150px] flex-col justify-between text-right text-xs leading-none tabular-nums"
              >
                <span className="-mt-1.5">{axisMax}</span>
                <span>{axisMax / 2}</span>
                <span className="-mb-1">0</span>
              </div>
              <div className="min-w-0 flex-1">
                <div
                  role="img"
                  aria-label={`Research articles per year, by author position: ${r.output.byYear.map((y) => `${yearTip(y)}`).join("; ")}`}
                  className="border-apollo-border-strong relative flex h-[150px] items-end gap-2 border-b"
                >
                  <div aria-hidden className="border-apollo-border absolute inset-x-0 top-0 border-t" />
                  <div aria-hidden className="border-apollo-border absolute inset-x-0 top-1/2 border-t" />
                  {r.output.byYear.map((y) => (
                    // Senior at the base, then co-author, then first author on top; a
                    // 2px card-colored gap between segments, rounded only at the top.
                    // ponytail: native `title` tooltips; a styled hover layer if asked.
                    <div
                      key={y.year}
                      title={yearTip(y)}
                      data-testid={`bibliometrics-year-${y.year}`}
                      className="relative flex flex-1 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                      style={{ height: `${(y.count / axisMax) * 100}%` }}
                    >
                      {(["senior", "co", "first"] as const).map((k) =>
                        y[k] > 0 ? (
                          <div
                            key={k}
                            title={`${y.year}, ${OUTPUT_ROWS.find((row) => row[1] === k)![0].toLowerCase()}: ${y[k]}`}
                            style={{ flexGrow: y[k], flexBasis: 0, backgroundColor: POSITION_FILL[k] }}
                          />
                        ) : null,
                      )}
                    </div>
                  ))}
                </div>
                <div className="text-apollo-ink-2 mt-1 flex gap-2 text-xs tabular-nums" data-testid="bibliometrics-year-labels">
                  {r.output.byYear.map((y, i) => (
                    // Every year on a wide screen; every other one on a phone, so they never collide.
                    <span key={y.year} className={`flex-1 text-center whitespace-nowrap ${i % 2 ? "max-sm:invisible" : ""}`}>
                      {y.year}
                      {y.year === thisYear ? "*" : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {r.output.byYear.at(-1)?.year === thisYear ? (
              <p className="text-apollo-ink-2 text-xs">{thisYear}* is year to date.</p>
            ) : null}
          </div>
        </div>
      </section>

      <DownstreamImpact report={r} reach={reach} />

      {r.stages ? <StagesSection stages={r.stages} /> : null}

      <section className={SECTION}>
        <SectionHead title="Most impactful papers" filtered />
        <p className="text-apollo-ink-2">Ranked by NIH percentile, then author position, citation ratio and citation count.</p>
        {r.papers.rows.length > 0 ? (
          <PapersList report={r} />
        ) : (
          <p className="text-apollo-ink-2 text-sm">No research articles match.</p>
        )}
      </section>

      <section className="px-5 pt-5 pb-5 sm:px-7">
        <details className={`${LIGHT_BOX} group px-4 py-3.5 text-[13px] leading-[1.55]`}>
          <summary className="min-h-6 cursor-pointer list-none text-sm font-semibold [&::-webkit-details-marker]:hidden">
            Definitions and sources{" "}
            <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
              ▸
            </span>
          </summary>
          <div className="mt-2.5 grid max-w-[900px] gap-2">
            {r.definitions.map((d) => (
              <div key={d.text}>
                {d.term ? <span className="font-semibold">{d.term}: </span> : null}
                {d.text}
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}

/** What each list a summary count, tile or author position opens is headed. */
const LIST_TITLE: Partial<Record<CountKey, string>> = {
  all: "Research articles in scope, newest first",
  lead: "Articles as first or senior author, newest first",
  first: "Articles as first author, newest first",
  senior: "Articles as senior author, newest first",
  co: "Articles as co-author, newest first",
  rated: "Articles with an NIH percentile, newest first",
  topDecile: "Articles in the NIH top 10%, newest first",
  hCore: "The publications forming the h-index, most cited first (NIH iCite)",
  h5Core: "The publications forming the h5-index, most cited first (NIH iCite)",
  guideline: "Articles cited in clinical practice guidelines, newest first",
  authority: "Articles cited in health-authority documents, newest first",
  patent: "Articles cited in patents, newest first",
};

/** A count that opens its list; zero stays plain text. */
function CountButton({
  n,
  open,
  onToggle,
  controls,
  testId,
  className = "font-medium",
}: {
  n: number;
  open: boolean;
  onToggle: () => void;
  controls: string;
  testId?: string;
  className?: string;
}) {
  if (n === 0) return <>0</>;
  return (
    <button
      type="button"
      className={`${LINK} tabular-nums ${className}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-testid={testId}
    >
      {n.toLocaleString("en-US")}
    </button>
  );
}

/** The papers behind one count, under its title. */
function CountList({ id, report: r, list }: { id: string; report: BibliometricsReport; list: CountKey }) {
  return (
    <div className={`${LIGHT_BOX} px-3.5 py-2.5`} data-testid={`bibliometrics-list-${list}`}>
      {LIST_TITLE[list] ? <p className="mb-2 text-[13px] font-semibold">{LIST_TITLE[list]}</p> : null}
      <CitedArticles id={id} papers={papersFor(r, list)} citations={list === "hCore" || list === "h5Core"} />
    </div>
  );
}

/** The summary sentence and the five tiles; each count opens its list, one
 *  at a time, under the sentence or under the tiles. */
function SummarySection({ report: r }: { report: BibliometricsReport }) {
  const [open, setOpen] = React.useState<{ key: CountKey; from: "summary" | "tiles" } | null>(null);
  const unrated = unratedNote(r);
  const toggle = (key: CountKey, from: "summary" | "tiles") =>
    setOpen(open?.key === key && open.from === from ? null : { key, from });
  const countOf = (key: CountKey, n: number, from: "summary" | "tiles", className?: string) => (
    <CountButton
      n={n}
      open={open?.key === key && open.from === from}
      onToggle={() => toggle(key, from)}
      controls={`bibliometrics-${from}-list`}
      testId={`bibliometrics-${from}-count-${key}`}
      className={className}
    />
  );
  const list = (from: "summary" | "tiles") =>
    open?.from === from ? <CountList id={`bibliometrics-${from}-list`} report={r} list={open.key} /> : null;
  const tile = (key: CountKey, n: number) => countOf(key, n, "tiles", "font-semibold");
  return (
    <section className={`${SECTION} pt-6`}>
      <SectionHead title="Summary" filtered />
      {r.summary.length > 0 ? (
        <p className="max-w-[900px] text-base leading-[1.6]" data-testid="bibliometrics-summary">
          <ScholarHoverCard cwid={r.scholar.cwid}>
            <span>{r.scholar.name}</span>
          </ScholarHoverCard>
          {r.summary.map((parts, i) => (
            <React.Fragment key={i}>
              {" "}
              {parts.map((part, j) =>
                typeof part === "string" ? (
                  <React.Fragment key={j}>{part}</React.Fragment>
                ) : (
                  <React.Fragment key={j}>{countOf(part.list, part.n, "summary")}</React.Fragment>
                ),
              )}
            </React.Fragment>
          ))}
        </p>
      ) : (
        <p className="text-apollo-ink-2 text-sm" data-testid="bibliometrics-no-summary">
          {NO_SUMMARY_NOTE}
        </p>
      )}
      {list("summary")}
      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3" data-testid="bibliometrics-tiles">
        {/* The h-index and h5-index never follow the filters; their labels say so. */}
        <Tile value={tile("hCore", r.metrics.hIndex)} label="h-index, all publications" help={METRIC_HELP.hIndex} />
        <Tile value={tile("h5Core", r.metrics.h5Index)} label="h5-index, last 5 years" help={METRIC_HELP.h5Index} />
        <Tile
          value={r.metrics.topDecilePct === null ? "n/a" : tile("topDecile", r.metrics.topDecileArticles)}
          share={r.metrics.topDecilePct === null ? undefined : `${r.metrics.topDecilePct}%`}
          label={
            r.metrics.topDecilePct === null
              ? "in NIH top 10%: no article rated yet"
              : `in NIH top 10%, of ${r.metrics.ratedArticles.toLocaleString()} rated (10% expected)`
          }
          help={METRIC_HELP.topDecile}
        />
        <Tile value={tile("guideline", r.policy[1]!.papers)} label="articles cited in clinical guidelines" />
        <Tile value={tile("authority", r.policy[0]!.papers)} label="articles cited in health-authority reports" />
      </div>
      {list("tiles")}
      {unrated ? <p className="text-apollo-ink-2 text-[13px]">{unrated}</p> : null}
    </section>
  );
}

/** Output by author position: each count lists its articles under its row. */
function PositionTable({ report: r }: { report: BibliometricsReport }) {
  const [open, setOpen] = React.useState<CountKey | null>(null);
  const row = (key: CountKey, label: React.ReactNode, n: number, strong = false) => (
    <React.Fragment key={key}>
      <tr className={strong ? undefined : "border-apollo-border border-b"}>
        <th scope="row" className={`py-2 text-left ${strong ? "font-semibold" : "font-normal"}`}>
          {label}
        </th>
        <td className={`py-2 text-right ${strong ? "font-semibold" : ""}`}>
          <CountButton
            n={n}
            open={open === key}
            onToggle={() => setOpen(open === key ? null : key)}
            controls={`bibliometrics-output-${key}`}
            testId={`bibliometrics-output-count-${key}`}
            className={strong ? "font-semibold" : "font-medium"}
          />
        </td>
      </tr>
      {open === key ? (
        <tr className="border-apollo-border border-b">
          <td colSpan={2} className="py-2">
            <CountList id={`bibliometrics-output-${key}`} report={r} list={key} />
          </td>
        </tr>
      ) : null}
    </React.Fragment>
  );
  return (
    <table className="min-w-0 flex-[1_1_260px] text-sm">
      <caption className="pb-1.5 text-left font-semibold">By author position, all years in range</caption>
      <tbody>
        {OUTPUT_ROWS.map(([label, key]) =>
          row(
            key,
            <>
              <span
                aria-hidden
                className="mr-2 inline-block size-2.5 rounded-[2px] align-[-1px]"
                style={{ backgroundColor: POSITION_FILL[key] }}
              />
              {label}
            </>,
            key === "co" ? r.output.coAuthor : r.output[key],
          ),
        )}
        {row("all", "All research articles", r.output.total, true)}
      </tbody>
    </table>
  );
}

/** An ⓘ that opens its text on click, tap or keyboard (a hover tooltip never
 *  opens on a phone). */
function InfoMark({ label, text }: { label: string; text: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="text-apollo-ink-2 hover:text-apollo-slate inline-flex size-6 items-center justify-center rounded align-middle print:hidden"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-[13px] leading-normal font-normal">{text}</PopoverContent>
    </Popover>
  );
}

function Tile({ value, share, label, help }: { value: React.ReactNode; share?: string; label: string; help?: string }) {
  return (
    <div className={`${LIGHT_BOX} px-4 py-3.5`}>
      <div className="text-[30px] leading-[1.1] font-semibold tabular-nums">
        {value}
        {share ? <span className="text-apollo-ink-2 text-base font-medium"> · {share}</span> : null}
      </div>
      <div className="text-apollo-ink-2 mt-1 text-sm">
        {label}
        {help ? <InfoMark label={label} text={help} /> : null}
      </div>
    </div>
  );
}

type StageKey = StageBucket | UnstagedReason;

/** Research articles by translational stage: coverage first, then the four
 *  stages with bars as long as their shares. Every count opens its papers. */
function StagesSection({ stages }: { stages: BibliometricsStages }) {
  const [open, setOpen] = React.useState<StageKey | null>(null);
  const staged = TRANSLATIONAL_STAGES.reduce((n, k) => n + stages.counts[k], 0);
  const unstaged = stages.counts.none;
  const total = staged + unstaged;
  const coverage = total > 0 ? Math.round((staged / total) * 100) : 0;
  const listOf = (k: StageKey) =>
    (UNSTAGED_REASONS as readonly string[]).includes(k)
      ? stages.papers.none.filter((p) => p.reason === k)
      : stages.papers[k as StageBucket];
  const count = (k: StageKey, n: number) => (
    <button
      type="button"
      className={`${LINK} font-medium tabular-nums`}
      aria-expanded={open === k}
      aria-controls={`bibliometrics-stage-${k}`}
      onClick={() => setOpen(open === k ? null : k)}
      data-testid={`bibliometrics-stage-count-${k}`}
    >
      {n.toLocaleString()}
    </button>
  );
  const list = (k: StageKey) =>
    open === k ? <StagePapers id={`bibliometrics-stage-${k}`} papers={listOf(k)} /> : null;
  const reasons = UNSTAGED_REASONS.filter((k) => stages.unstaged[k] > 0);
  const rows = (
    <div className="overflow-x-auto">
      <div className="min-w-[440px] tabular-nums">
        {TRANSLATIONAL_STAGES.map((k) => {
          const n = stages.counts[k];
          return (
            <React.Fragment key={k}>
              <div className="border-apollo-border grid grid-cols-[minmax(180px,1.2fr)_48px_minmax(120px,2fr)_48px] items-center gap-3.5 border-b py-2.5 text-sm">
                <div>
                  <span className="font-semibold">{k.replace("-", "\u2013")}</span>{" "}
                  {TRANSLATIONAL_STAGE_LABELS[k]}
                </div>
                <div className="text-right">{n > 0 ? count(k, n) : <span className="text-apollo-ink-2">0</span>}</div>
                <div className="bg-apollo-surface-2 h-2 rounded" aria-hidden>
                  <div className="bg-apollo-slate h-2 rounded" style={{ width: `${stages.shares[k]}%` }} />
                </div>
                <div className="text-right font-medium">{stages.shares[k]}%</div>
              </div>
              {list(k)}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
  return (
    <section className={SECTION} data-testid="bibliometrics-stages">
      <SectionHead title="Translational stage" filtered />
      <div
        className="border-apollo-slate-tint-border bg-apollo-slate-tint rounded-lg border px-3.5 py-2.5 text-sm"
        data-testid="bibliometrics-stage-coverage"
      >
        <span className="font-semibold">
          Stage assigned for {staged.toLocaleString()} of {total.toLocaleString()}{" "}
          {total === 1 ? "article" : "articles"} ({coverage}%).
        </span>
        {unstaged > 0 ? (
          <span className="text-[#3d4a57]">
            {" "}
            The other {count("none", unstaged)} {unstaged === 1 ? "is" : "are"} unstaged:{" "}
            {reasons.map((k, i) => (
              <React.Fragment key={k}>
                {i > 0 ? "; " : ""}
                {count(k, stages.unstaged[k])} {UNSTAGED_LABEL[k]}
              </React.Fragment>
            ))}
            .{staged > 0 ? ` Shares below are of the ${staged.toLocaleString()}.` : ""}
          </span>
        ) : null}
      </div>
      {list("none")}
      {reasons.map((k) => (
        <React.Fragment key={k}>{list(k)}</React.Fragment>
      ))}
      {staged === 0 ? null : coverage < STAGE_FOLD_BELOW_PCT ? (
        // Low coverage: the shares would claim more than they should, so the
        // breakdown starts folded under the coverage line.
        <details className="group" data-testid="bibliometrics-stage-fold">
          <summary className="text-apollo-slate min-h-11 cursor-pointer list-none py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Show the breakdown of the {staged.toLocaleString()} staged{" "}
            {staged === 1 ? "article" : "articles"}{" "}
            <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
              ▸
            </span>
          </summary>
          {rows}
        </details>
      ) : (
        rows
      )}
      {stages.portfolioHref ? (
        <a href={stages.portfolioHref} className={`${LINK} min-h-11 self-start text-sm font-medium`}>
          Full translational profile (first or senior author, every publication type)
        </a>
      ) : null}
    </section>
  );
}

/** The papers behind one stage count, newest first. */
function StagePapers({ id, papers }: { id: string; papers: BibliometricsStages["papers"]["none"] }) {
  return (
    <ul id={id} className={`${LIGHT_BOX} my-1.5 flex flex-col gap-2 px-3.5 py-2.5`} aria-label={`${papers.length} papers`}>
      {papers.map((p) => (
        <li key={p.pmid} className="text-[13px] leading-normal">
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
            target="_blank"
            rel="noopener noreferrer"
            {...pubTitleProps(sanitizePubTitle(p.title), LINK)}
          />
          <div className="text-apollo-ink-2">
            {p.journal ? <PubJournal value={p.journal} /> : null}
            {p.journal && p.year ? ", " : ""}
            {p.year ?? ""}
            {" · PMID "}
            {p.pmid}
            <CopyPmid pmid={p.pmid} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "2019: 41 (first 6, senior 28, co-author 7)" */
const yearTip = (y: BibliometricsReport["output"]["byYear"][number]) =>
  `${y.year}: ${y.count}${y.count > 0 ? ` (first ${y.first}, senior ${y.senior}, co-author ${y.co})` : ""}`;

/** Papers shown before "Show all". */
const PAPERS_SHOWN = 5;
/** Citing documents an open count lists before "See all". */
const DOCS_SHOWN = 3;
/** Position column: short, so "Co-author" never wraps. */
const POSITION_SHORT: Record<BibliometricsPaper["position"], string> = { first: "First", senior: "Senior", co: "Co" };
/** Health authorities in the impact line's fixed order. */
const AUTHORITY_ORDER = ["AHRQ", "CDC", "National Academies", "NICE", "WHO"];
const AUTHORITY_SHORT: Readonly<Record<string, string>> = { "National Academies": "Nat\u2019l Academies" };
/** Cell padding: 20px top and bottom, 16px at the row's ends, 16px between columns. */
const CELL = "px-2 py-5 align-top first:pl-4 last:pr-4";
const HEAD = "px-2 py-2.5 text-left text-[13px] font-medium first:pl-4 last:pr-4";

/** One count in a paper's impact line, and what it lists when opened. */
type Signal = {
  key: string;
  label: string;
  n: number;
  /** Policy sources are bold; research sources are not. */
  policy: boolean;
  noun: readonly [string, string];
  docs: Array<{ id: string; title: string; url: string | null; meta: string }>;
};

const policyDoc = (d: BibliometricsPaper["citing"][number], kind: string) => ({
  id: `d${d.id}`,
  title: d.title,
  url: d.url,
  meta: [d.issuingBody ?? (d.journal ? htmlToPlainText(d.journal, Number.POSITIVE_INFINITY) : d.publisher), d.year, kind]
    .filter(Boolean)
    .join(" \u00b7 "),
});

/** Guidelines, the health authorities, consensus, systematic reviews, patents:
 *  always that order; a zero leaves its count out. */
function signalsOf(p: BibliometricsPaper): Signal[] {
  const docs = (level: string, body?: string) =>
    p.citing.filter((d) => d.level === level && (body === undefined || d.issuingBody === body));
  const authority = [...p.authority].sort(
    (a, b) => AUTHORITY_ORDER.indexOf(a.body) - AUTHORITY_ORDER.indexOf(b.body) || a.body.localeCompare(b.body),
  );
  const all: Signal[] = [
    {
      key: "guideline",
      label: "Guidelines",
      n: p.guidelines,
      policy: true,
      noun: ["clinical practice guideline", "clinical practice guidelines"],
      docs: docs("guideline").map((d) => policyDoc(d, "guideline")),
    },
    ...authority.map((a) => {
      // "AHRQ report", "WHO guideline": the badge wording, made plural.
      const one = authorityBadgeLabel(a.body, 1);
      return {
        key: `authority:${a.body}`,
        label: AUTHORITY_SHORT[a.body] ?? a.body,
        n: a.count,
        policy: true,
        noun: [one, `${one}s`] as const,
        docs: docs("authority", a.body).map((d) => policyDoc(d, one.slice(a.body.length + 1))),
      };
    }),
    {
      key: "consensus",
      label: "Consensus",
      n: p.consensus,
      policy: false,
      noun: ["consensus statement", "consensus statements"],
      docs: docs("consensus").map((d) => policyDoc(d, "consensus statement")),
    },
    {
      key: "review",
      label: "Syst. reviews",
      n: p.reviews,
      policy: false,
      noun: ["systematic review or meta-analysis", "systematic reviews and meta-analyses"],
      docs: docs("review").map((d) => policyDoc(d, "systematic review")),
    },
    {
      key: "patent",
      label: "Patents",
      n: p.patents,
      policy: false,
      noun: ["patented invention", "patented inventions"],
      docs: (p.citingPatents?.items ?? []).map((inv) => ({
        id: `p${inv.id}`,
        title: inv.title,
        url: inv.url,
        meta: [inv.holder, inv.year ? `${inv.granted ? "granted" : "published"} ${inv.year}` : null, inv.number]
          .filter(Boolean)
          .join(" \u00b7 "),
      })),
    },
  ];
  return all.filter((x) => x.n > 0);
}

/** Most impactful papers: five, then all ten; one count's list open at a time. */
function PapersList({ report: r }: { report: BibliometricsReport }) {
  const [showAll, setShowAll] = React.useState(false);
  const [open, setOpen] = React.useState<{ pmid: string; key: string } | null>(null);
  const rows = showAll ? r.papers.rows : r.papers.rows.slice(0, PAPERS_SHOWN);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm tabular-nums">
          <thead>
            <tr className="bg-apollo-surface-2 text-apollo-ink-2">
              <th scope="col" className={HEAD}>
                Paper
              </th>
              <th scope="col" className={`${HEAD} w-[88px]`}>
                Position
              </th>
              <th scope="col" className={`${HEAD} w-[96px] text-right`}>
                NIH pctl
                <InfoMark label="NIH percentile" text={METRIC_HELP.percentile} />
              </th>
              <th scope="col" className={`${HEAD} w-[96px] text-right`}>
                Citation ratio
                <InfoMark label="citation ratio" text={METRIC_HELP.citationRatio} />
              </th>
              <th scope="col" className={`${HEAD} w-[112px] text-right`}>
                Cited by (Scopus)
                <InfoMark label="Cited by" text={METRIC_HELP.citedBy} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <PaperRow
                key={p.pmid}
                paper={p}
                scholarCwid={r.scholar.cwid}
                early={isEarlyPercentile(p, r.asOf)}
                openKey={open?.pmid === p.pmid ? open.key : null}
                setOpenKey={(key) => setOpen(key ? { pmid: p.pmid, key } : null)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-apollo-ink-2 text-[13px]">
          Showing {rows.length} of the top {r.papers.rows.length} · {r.papers.matching.toLocaleString()}{" "}
          {r.papers.matching === 1 ? "article" : "articles"} in scope
        </span>
        {r.papers.rows.length > PAPERS_SHOWN ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="border-apollo-border-strong bg-apollo-surface min-h-10 rounded-lg border px-3.5 text-sm font-medium"
          >
            {showAll ? `Show top ${PAPERS_SHOWN}` : `Show all ${r.papers.rows.length}`}
          </button>
        ) : null}
      </div>
    </>
  );
}

function PaperRow({
  paper: p,
  scholarCwid,
  early,
  openKey,
  setOpenKey,
}: {
  paper: BibliometricsPaper;
  scholarCwid: string;
  /** The percentile is an early figure (this year or last). */
  early: boolean;
  /** The count whose list is open under this paper, if any. */
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
}) {
  const id = citationIdentifier(p.pmid);
  const title = pubTitleProps(sanitizePubTitle(p.title), id.href ? LINK : undefined);
  const signals = signalsOf(p);
  const opened = signals.find((s) => s.key === openKey) ?? null;
  const panelId = `bibliometrics-citing-${p.pmid}`;
  // The scholar's own name would repeat on every row and say nothing.
  const coauthors = p.wcmAuthors.filter((a) => a.cwid !== scholarCwid);
  return (
    <tr className="border-apollo-border border-b" data-testid={`bibliometrics-paper-${p.pmid}`}>
      <td className={CELL}>
        {id.href ? (
          <a href={id.href} target="_blank" rel="noopener noreferrer" {...title} className={`${LINK} font-medium`} />
        ) : (
          <span {...title} className="font-medium" />
        )}
        <div className="text-apollo-ink-2 mt-1 text-[13px] leading-normal">
          {p.authors.map((a, i) => (
            <React.Fragment key={i}>
              {i > 0 ? ", " : ""}
              {a.bold ? <strong className="text-apollo-ink font-semibold">{a.name}</strong> : a.name}
            </React.Fragment>
          ))}
          {p.etAl ? ", et al. " : p.authors.length > 0 ? ". " : ""}
          {p.journal ? <PubJournal value={p.journal} /> : null}
          {p.journal ? ". " : ""}
          {p.dated ? `${p.dated}.` : ""}
        </div>
        <div className="text-apollo-ink-2 mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px]">
          <span>
            {id.label} {id.value}
          </span>
          {id.label === "PMID" ? <CopyPmid pmid={p.pmid} label /> : null}
          {p.doi ? (
            <>
              <span aria-hidden>·</span>
              <a
                href={`https://doi.org/${p.doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-apollo-slate underline decoration-dotted underline-offset-2"
              >
                DOI {p.doi}
              </a>
            </>
          ) : null}
        </div>
        <div className="mt-2 text-[13px] leading-[1.9]" data-testid={`bibliometrics-signals-${p.pmid}`}>
          {signals.length > 0 ? (
            signals.map((s, i) => (
              <span key={s.key} className="whitespace-nowrap">
                {i > 0 ? (
                  <span aria-hidden className="text-apollo-ink-2 px-1">
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-expanded={opened?.key === s.key}
                  aria-controls={panelId}
                  onClick={() => setOpenKey(opened?.key === s.key ? null : s.key)}
                  className={`text-apollo-slate min-h-7 rounded px-1 ${s.policy ? "font-semibold" : "font-normal"} ${
                    opened?.key === s.key ? "bg-apollo-slate-tint" : ""
                  }`}
                >
                  {s.label} {s.n.toLocaleString()}
                </button>
              </span>
            ))
          ) : (
            <span className="text-apollo-ink-2">No guideline, policy or review citations yet</span>
          )}
        </div>
        {opened ? <CitingPanel key={opened.key} id={panelId} signal={opened} onClose={() => setOpenKey(null)} /> : null}
        {coauthors.length > 0 ? <CoAuthors authors={coauthors} /> : null}
      </td>
      <td className={CELL}>{POSITION_SHORT[p.position]}</td>
      <td className={`${CELL} text-right font-medium`}>
        {percentileText(p)}
        {early ? <div className="text-apollo-ink-2 text-xs font-normal">early</div> : null}
      </td>
      <td className={`${CELL} text-right`}>{p.relativeCitationRatio?.toFixed(1) ?? "n/a"}</td>
      <td className={`${CELL} text-right`}>{p.citationCount.toLocaleString()}</td>
    </tr>
  );
}

/** The documents behind one count: the first three, then all of them. */
function CitingPanel({
  id,
  signal: s,
  onClose,
  subject = "this paper",
}: {
  id: string;
  signal: Pick<Signal, "n" | "noun" | "docs">;
  onClose: () => void;
  /** What the documents cite: "this paper", or "these articles" for a Downstream impact count. */
  subject?: string;
}) {
  const [all, setAll] = React.useState(false);
  const docs = all ? s.docs : s.docs.slice(0, DOCS_SHOWN);
  return (
    <div id={id} className={`${LIGHT_BOX} mt-2 px-3.5 py-2.5 text-[13px]`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">
          {plural(s.n, s.noun[0], s.noun[1])} citing {subject}
        </span>
        <button
          type="button"
          aria-label="Close list"
          onClick={onClose}
          className="text-apollo-ink-2 min-h-8 min-w-8 text-lg leading-none"
        >
          ×
        </button>
      </div>
      <ul>
        {docs.map((d) => (
          <li key={d.id} className="border-apollo-border border-b py-1.5 last:border-b-0">
            {d.url ? (
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                {...pubTitleProps(sanitizePubTitle(d.title), LINK)}
              />
            ) : (
              <span {...pubTitleProps(sanitizePubTitle(d.title))} />
            )}
            <div className="text-apollo-ink-2">{d.meta}</div>
          </li>
        ))}
      </ul>
      {!all && s.n > DOCS_SHOWN ? (
        <button type="button" onClick={() => setAll(true)} className={`${LINK} mt-1.5 min-h-7`}>
          See all {s.n.toLocaleString()}
        </button>
      ) : null}
      {all && s.docs.length < s.n ? (
        <p className="text-apollo-ink-2 mt-1.5">
          Listing the {s.docs.length.toLocaleString()} most recent of {s.n.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}

/** "WCM co-authors: A, B, C +4 more"; the "+4 more" lists the rest. */
function CoAuthors({ authors }: { authors: BibliometricsPaper["wcmAuthors"] }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? authors : authors.slice(0, 3);
  return (
    <div className="text-apollo-ink-2 mt-1 text-[13px]">
      WCM co-authors:{" "}
      <span className="text-apollo-ink">
        {shown.map((a, i) => (
          <React.Fragment key={a.cwid}>
            {i > 0 ? ", " : ""}
            <ScholarHoverCard cwid={a.cwid}>
              <span>{a.name}</span>
            </ScholarHoverCard>
          </React.Fragment>
        ))}
      </span>
      {!all && authors.length > 3 ? (
        <>
          {" "}
          <button type="button" onClick={() => setAll(true)} className={`${LINK} min-h-7`}>
            +{authors.length - 3} more
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Where the work is cited outside ordinary journal citations: one table,
 *  one scope (the research articles in the filters). */
function DownstreamImpact({ report: r, reach }: { report: BibliometricsReport; reach: ScholarReach | null }) {
  // One list open at a time: an Articles cited key, or "docs:<level>[:<body>]".
  const [open, setOpen] = React.useState<string | null>(null);
  const [inventionsOpen, setInventionsOpen] = React.useState(false);
  const level = (k: BibliometricsPolicyLevel["level"]) => r.policy.find((l) => l.level === k)!;
  const authority = level("authority");
  const query = bibliometricsQuery(r.scholar.cwid, r.filters);
  const docsKey = (lv: CitingLevel, body?: string) => (body ? `docs:${lv}:${body}` : `docs:${lv}`);
  /** A Citing documents count, opening its documents (fetched on click). */
  const docs = (lv: CitingLevel, n: number, body?: string, className?: string) => (
    <CountButton
      n={n}
      open={open === docsKey(lv, body)}
      onToggle={() => setOpen(open === docsKey(lv, body) ? null : docsKey(lv, body))}
      controls={`bibliometrics-docs-${lv}`}
      testId={`bibliometrics-docs-count-${body ? `${lv}-${body}` : lv}`}
      className={className}
    />
  );
  const row = (
    key: ImpactKey,
    label: React.ReactNode,
    papers: number,
    documents: React.ReactNode,
    extra?: React.ReactNode,
  ) => (
    <React.Fragment key={key}>
      <tr className="border-apollo-border border-b">
        <th scope="row" className="px-3 py-2.5 text-left font-normal">
          {label}
          {extra}
        </th>
        <td className="px-3 py-2.5 text-right align-top">
          {papers > 0 ? (
            <button
              type="button"
              className={`${LINK} min-h-6 font-medium`}
              aria-expanded={open === key}
              aria-controls={`bibliometrics-cited-${key}`}
              onClick={() => setOpen(open === key ? null : key)}
              data-testid={`bibliometrics-cited-${key}`}
            >
              {papers.toLocaleString()}
            </button>
          ) : (
            "0"
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-top">{documents}</td>
      </tr>
      {open === key ? (
        <tr className="border-apollo-border border-b">
          <td colSpan={3} className="px-3 py-2">
            <CitedArticles id={`bibliometrics-cited-${key}`} papers={r.cited[key]} />
          </td>
        </tr>
      ) : null}
      {open?.startsWith(`docs:${key}`) && key !== "patent" ? (
        <tr className="border-apollo-border border-b">
          <td colSpan={3} className="px-3 py-2">
            <CitingDocs
              key={open}
              id={`bibliometrics-docs-${key}`}
              query={query}
              level={key}
              body={open.split(":")[2]}
              onClose={() => setOpen(null)}
            />
          </td>
        </tr>
      ) : null}
    </React.Fragment>
  );
  const group = (title: string) => (
    <tr>
      <th
        colSpan={3}
        scope="colgroup"
        className="border-apollo-border-strong border-b-2 px-3 pt-5 pb-1.5 text-left text-[13px] font-semibold tracking-[0.06em] text-[#1f1d1b] uppercase"
      >
        {title}
      </th>
    </tr>
  );
  const own = <span className="text-apollo-ink-2"> (excluding the article&rsquo;s own authors)</span>;
  const inventions = r.patents.inventions;
  return (
    <section className={SECTION} data-testid="bibliometrics-impact">
      <SectionHead title="Downstream impact" filtered />
      <p className="text-apollo-ink-2">
        Where the research articles in scope are cited outside ordinary journal citations. Each Articles cited count lists
        its articles; each Citing documents count lists its documents.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead>
            <tr className="bg-apollo-surface-2 text-apollo-ink-2 text-[13px]">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Cited in
              </th>
              <th scope="col" className="w-[130px] px-3 py-2 text-right font-medium">
                Articles cited
              </th>
              <th scope="col" className="w-[150px] px-3 py-2 text-right font-medium">
                Citing documents
              </th>
            </tr>
          </thead>
          <tbody>
            {group("Policy and practice")}
            {row(
              "authority",
              authority.label,
              authority.papers,
              docs("authority", authority.documents),
              authority.bodies.length > 0 ? (
                <div className="text-apollo-ink-2 mt-0.5 text-[13px]">
                  {authority.bodies.map((b, i) => (
                    <React.Fragment key={b.body}>
                      {i > 0 ? " \u00b7 " : ""}
                      {b.body} {docs("authority", b.count, b.body, "font-normal")}
                    </React.Fragment>
                  ))}
                </div>
              ) : null,
            )}
            {row("guideline", level("guideline").label, level("guideline").papers, docs("guideline", level("guideline").documents))}
            {row("consensus", level("consensus").label, level("consensus").papers, docs("consensus", level("consensus").documents))}
            {group("Research by others")}
            {row("review", level("review").label, level("review").papers, docs("review", level("review").documents))}
            {row("clinical", <>Clinical studies{own}</>, r.research.clinical.papers, docs("clinical", r.research.clinical.documents))}
            {row("trial", <>Registered trials{own}</>, r.research.trial.papers, docs("trial", r.research.trial.documents))}
            {group("Invention")}
            {row(
              "patent",
              <>
                Patents
                {r.patents.dataEnd ? <span className="text-apollo-ink-2"> (patent data through {r.patents.dataEnd})</span> : null}
              </>,
              r.patents.papers,
              inventions > 0 ? (
                <button
                  type="button"
                  className={`${LINK} min-h-6`}
                  aria-expanded={inventionsOpen}
                  aria-controls="bibliometrics-inventions"
                  onClick={() => setInventionsOpen((v) => !v)}
                >
                  <span className="font-medium">{inventions.toLocaleString()}</span> {inventions === 1 ? "invention" : "inventions"}
                </button>
              ) : (
                "0 inventions"
              ),
              inventions > 0 ? (
                <div>
                  <button
                    type="button"
                    className={`${LINK} min-h-8 text-[13px]`}
                    aria-expanded={inventionsOpen}
                    aria-controls="bibliometrics-inventions"
                    onClick={() => setInventionsOpen((v) => !v)}
                    data-testid="bibliometrics-inventions-toggle"
                  >
                    {inventionsOpen ? "Hide inventions" : `Show the ${plural(inventions, "citing invention", "citing inventions")}`}
                  </button>
                </div>
              ) : null,
            )}
          </tbody>
        </table>
      </div>
      {inventionsOpen ? <Inventions report={r} /> : null}
      {reach?.connections ? (
        <p className="text-sm" data-testid="bibliometrics-reach-connections">
          Colleagues citing this work who have never co-authored with this scholar:{" "}
          <a
            href={reach.connections.href}
            className={LINK}
            aria-label={`${plural(reach.connections.colleagues, "colleague", "colleagues")} citing this work who have never co-authored with this scholar, in the Downstream reach report`}
          >
            {reach.connections.colleagues.toLocaleString()}
          </a>
        </p>
      ) : null}
    </section>
  );
}

/** What one Citing documents list counts: [one, many]. */
const DOC_NOUN: Record<CitingLevel, readonly [string, string]> = {
  authority: ["health-authority document", "health-authority documents"],
  guideline: ["clinical practice guideline", "clinical practice guidelines"],
  consensus: ["consensus statement", "consensus statements"],
  review: ["systematic review or meta-analysis", "systematic reviews and meta-analyses"],
  clinical: ["clinical study", "clinical studies"],
  trial: ["registered trial", "registered trials"],
};

/** The citing documents behind one Citing documents count, asked for when
 *  the count is opened (`part=citing`), inside the same filters. */
function CitingDocs({
  id,
  query,
  level,
  body,
  onClose,
}: {
  id: string;
  query: string;
  level: CitingLevel;
  /** One health authority's documents, for its per-body count. */
  body?: string;
  onClose: () => void;
}) {
  const [state, setState] = React.useState<{ docs: BibliometricsCitingDoc[]; total: number } | "failed" | null>(null);
  React.useEffect(() => {
    const ctrl = new AbortController();
    const part = new URLSearchParams({ part: "citing", level, ...(body ? { body } : {}) });
    fetch(`${PATH}?${query}&${part}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { docs: BibliometricsCitingDoc[]; total: number }) => setState({ docs: d.docs, total: d.total }))
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) {
          console.error("[bibliometrics] citing documents load failed", err);
          setState("failed");
        }
      });
    return () => ctrl.abort();
  }, [query, level, body]);
  if (state === null) return <p id={id} className="text-apollo-ink-2 text-[13px]">Loading…</p>;
  if (state === "failed") {
    return (
      <p id={id} className="text-apollo-ink-2 text-[13px]" data-testid="bibliometrics-docs-failed">
        We couldn&rsquo;t load these documents just now. Please try again.
      </p>
    );
  }
  const noun = body ? ([`${body} document`, `${body} documents`] as const) : DOC_NOUN[level];
  return (
    <CitingPanel
      id={id}
      subject="these articles"
      onClose={onClose}
      signal={{
        n: state.total,
        noun,
        docs: state.docs.map((d) => ({
          id: `c${d.id}`,
          title: d.title,
          url: d.url,
          meta: [d.source, d.year].filter(Boolean).join(" \u00b7 "),
        })),
      }}
    />
  );
}

/** Inventions shown before "Show all". */
const INVENTIONS_SHOWN = 3;

/** The citing inventions, newest first: each with the paper it cites. */
function Inventions({ report: r }: { report: BibliometricsReport }) {
  const [all, setAll] = React.useState(false);
  const titles = new Map(r.cited.patent.map((p) => [p.pmid, p.title]));
  const list = all ? r.patents.list : r.patents.list.slice(0, INVENTIONS_SHOWN);
  return (
    <div id="bibliometrics-inventions" className={`${LIGHT_BOX} px-4 py-3.5`} data-testid="bibliometrics-inventions">
      <p className="text-apollo-ink-2 mb-2 text-[13px]">Newest first. Related patents for one invention are grouped.</p>
      <ul>
        {list.map((inv) => {
          const first = inv.pmids.map((pmid) => titles.get(pmid)).find(Boolean);
          const more = inv.papers - 1;
          return (
            <li key={inv.id} className="py-1.5">
              {inv.url ? (
                <a href={inv.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                  {inv.title}
                </a>
              ) : (
                <span>{inv.title}</span>
              )}
              <div className="text-apollo-ink-2 text-[13px]">
                {[inv.holder, inv.year ? `${inv.granted ? "granted" : "published"} ${inv.year}` : null, inv.number]
                  .filter(Boolean)
                  .join(" \u00b7 ")}
                {first ? (
                  <>
                    {" \u00b7 cites "}
                    <i {...pubTitleProps(sanitizePubTitle(first))} />
                    {more > 0 ? ` and ${plural(more, "more paper", "more papers")}` : ""}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {!all && r.patents.list.length > INVENTIONS_SHOWN ? (
        <button type="button" onClick={() => setAll(true)} className={`${LINK} min-h-8 text-sm`}>
          Show all {r.patents.list.length.toLocaleString()}
        </button>
      ) : null}
      {all && r.patents.inventions > r.patents.list.length ? (
        <p className="text-apollo-ink-2 text-[13px]">
          Showing the newest {r.patents.list.length.toLocaleString()}; the download lists all{" "}
          {r.patents.inventions.toLocaleString()}.
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-4">
        <Button asChild variant="outline" size="sm" className="min-h-10">
          <a
            href={`${PATENTS_DOWNLOAD_PATH}?cwid=${encodeURIComponent(r.scholar.cwid)}`}
            download
            data-testid="bibliometrics-patents-download"
          >
            <Download className="size-4" />
            {PATENTS_DOWNLOAD_LABEL}
          </a>
        </Button>
        {r.patents.reportHref ? (
          <a href={r.patents.reportHref} className={`${LINK} text-sm`} data-testid="bibliometrics-patents-report">
            Open the Patent citations report
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The research articles behind one "Articles cited" count, newest first. */
function CitedArticles({
  id,
  papers,
  citations = false,
}: {
  id: string;
  papers: Array<BibliometricsReport["cited"][ImpactKey][number] & { nihCitations?: number | null }>;
  /** Show each paper's NIH iCite citations (the h-index lists). */
  citations?: boolean;
}) {
  return (
    <ul id={id} className="flex flex-col gap-2" aria-label={`${papers.length} articles`}>
      {papers.map((p) => (
        <li key={p.pmid} className="text-[13px] leading-normal">
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
            target="_blank"
            rel="noopener noreferrer"
            {...pubTitleProps(sanitizePubTitle(p.title), LINK)}
          />
          <div className="text-apollo-ink-2">
            {p.journal ? <PubJournal value={p.journal} /> : null}
            {p.journal && p.year ? ", " : ""}
            {p.year ?? ""}
            {" · PMID "}
            {p.pmid}
            <CopyPmid pmid={p.pmid} />
            {citations && p.nihCitations != null ? ` · ${plural(p.nihCitations, "citation", "citations")}` : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
