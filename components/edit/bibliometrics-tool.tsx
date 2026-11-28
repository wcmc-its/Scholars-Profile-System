/**
 * `BibliometricsTool` — the client island for the "Bibliometrics" Tools panel
 * (`EDIT_BIBLIOMETRICS`). Fetches the section model from
 * `GET /api/edit/bibliometrics` and renders it; the Word download is the same
 * URL with `format=docx`, so the document carries the filters set on screen.
 * Read-only: nothing here writes.
 */
"use client";

import * as React from "react";
import { Download, FileText, Landmark, Lock } from "lucide-react";

import { EDIT_PANEL_HEADING_ID } from "@/components/edit/edit-panel";
import { AuthorPills } from "@/components/edit/reports/author-pills";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, pubTitleProps } from "@/components/publication/pub-html";
import { InventionRow, PolicyCitationGroups, TrialPatentGroup } from "@/components/publication/publication-modal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { citationIdentifier } from "@/lib/citation";
import { authorityBadgeLabel, plural } from "@/lib/citations/policy-rollup";
import {
  NO_SUMMARY_NOTE,
  OWN_PATENTS_NOTE,
  PATENTS_DOWNLOAD_LABEL,
  PATENTS_DOWNLOAD_PATH,
  POSITION_LABEL,
  STAGES_NOTE,
  bibliometricsQuery,
  papersNote,
  patentsLine,
  percentileText,
  unratedNote,
  type BibliometricsFilters,
  type BibliometricsPaper,
  type BibliometricsReport,
  type BibliometricsStages,
} from "@/lib/edit/bibliometrics";
import type { ScholarReach } from "@/lib/edit/downstream-reach-entry";
import {
  NO_STAGE_LABEL,
  STAGE_BUCKETS,
  TRANSLATIONAL_STAGE_LABELS,
  type StageBucket,
} from "@/lib/translational-stage";
import { sanitizePubTitle } from "@/lib/utils";

const PATH = "/api/edit/bibliometrics";
const FAILED = "We couldn't load the bibliometrics report just now. Please try again.";

/** One flat section of the single white panel (no card inside the card). */
const SECTION = "flex flex-col gap-3 px-5 pt-7 pb-2 sm:px-7";
const LIGHT_BOX = "bg-apollo-surface-2 rounded-[10px]";
const FILTERED_BADGE =
  "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate rounded-full border px-2 py-px text-xs font-medium";
const LINK = "text-apollo-slate hover:underline";
const BADGE = "inline-flex items-center gap-1 rounded-full border px-2.5 text-xs leading-[18px] font-medium";
// Health authority: the guideline tint with a slate outline and bolder text.
const BADGE_AUTHORITY = `${BADGE} border-apollo-slate bg-apollo-slate-tint py-px font-semibold text-[#274158]`;
const BADGE_TINT = `${BADGE} border-apollo-slate-tint-border bg-apollo-slate-tint py-px text-[#274158]`;
const TH = "px-2.5 py-2 text-left text-xs font-medium";
/** Author position in byline order, light to dark: one slate hue (an ordinal
 *  ramp, validated: monotone lightness, light end 2.48:1 on the white card;
 *  the table's numbers and each segment's hover text carry the values). */
const POSITION_FILL = { first: "#8fa7c2", co: "#5f7d9e", senior: "#34506e" } as const;
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
      <header className="bg-apollo-surface border-apollo-border z-20 rounded-t-[var(--apollo-radius-card)] border-b px-5 pt-5 pb-4 sm:px-7 md:sticky md:top-14">
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
          <Button asChild variant="apollo" className="min-h-10">
            <a href={`${PATH}?${query}&format=docx`} download data-testid="bibliometrics-download">
              <Download className="size-4" />
              Download Word document
            </a>
          </Button>
        </div>
        {report ? <FilterBar filters={filters} setFilters={setFilters} yearRange={report.yearRange} /> : null}
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
    <div className="bg-apollo-surface-2 border-apollo-border-strong mt-4 flex flex-wrap items-center gap-x-7 gap-y-3 rounded-[10px] border px-4 py-2.5 text-sm">
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
  const unrated = unratedNote(r);
  const patents = patentsLine(r.patents);
  const peak = Math.max(1, ...r.output.byYear.map((y) => y.count));
  return (
    <div className="flex flex-col pb-2" data-testid="bibliometrics-report">
      <section className={`${SECTION} pt-6`}>
        <SectionHead title="Summary" filtered />
        {r.summary.length > 0 ? (
          <p className="max-w-[900px] text-base leading-[1.6]" data-testid="bibliometrics-summary">
            <ScholarHoverCard cwid={r.scholar.cwid}>
              <span>{r.scholar.name}</span>
            </ScholarHoverCard>{" "}
            {r.summary.join(" ")}
          </p>
        ) : (
          <p className="text-apollo-ink-2 text-sm" data-testid="bibliometrics-no-summary">
            {NO_SUMMARY_NOTE}
          </p>
        )}
        <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3" data-testid="bibliometrics-tiles">
          {/* The h-index and h5-index never follow the filters; their labels say so. */}
          <Tile value={String(r.metrics.hIndex)} label="h-index, all publications" />
          <Tile value={String(r.metrics.h5Index)} label="h5-index, last 5 years" />
          <Tile
            value={r.metrics.topDecilePct === null ? "n/a" : r.metrics.topDecileArticles.toLocaleString()}
            share={r.metrics.topDecilePct === null ? undefined : `${r.metrics.topDecilePct}%`}
            label={
              r.metrics.topDecilePct === null
                ? "in NIH top 10%: no article rated yet"
                : `in NIH top 10%, of ${r.metrics.ratedArticles.toLocaleString()} rated (10% expected)`
            }
          />
          <Tile value={r.policy[1]!.papers.toLocaleString()} label="articles cited in clinical guidelines" />
          <Tile value={r.policy[0]!.papers.toLocaleString()} label="articles cited in health-authority reports" />
        </div>
        {unrated ? <p className="text-apollo-ink-2 text-[13px]">{unrated}</p> : null}
      </section>

      <section className={SECTION}>
        <SectionHead title="Output" filtered />
        <div className="flex flex-wrap gap-7">
          <table className="min-w-0 flex-[1_1_260px] text-sm">
            <caption className="pb-1.5 text-left font-semibold">By author position, all years in range</caption>
            <tbody>
              {OUTPUT_ROWS.map(([label, key]) => (
                <tr key={label} className="border-apollo-border border-b">
                  <th scope="row" className="py-2 text-left font-normal">
                    <span
                      aria-hidden
                      className="mr-2 inline-block size-2.5 rounded-[2px] align-[-1px]"
                      style={{ backgroundColor: POSITION_FILL[key] }}
                    />
                    {label}
                  </th>
                  <td className="py-2 text-right">
                    {(key === "co" ? r.output.coAuthor : r.output[key]).toLocaleString()}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="py-2 text-left font-semibold">
                  All research articles
                </th>
                <td className="py-2 text-right font-semibold">{r.output.total.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          <div className="flex min-w-0 flex-[2_1_360px] flex-col gap-1.5">
            <div className="text-sm font-semibold">
              {r.filters.yearFrom === null && r.filters.yearTo === null
                ? "By year, last 10 years"
                : r.output.byYear.length > 0
                  ? `By year, ${r.output.byYear[0]!.year} to ${r.output.byYear.at(-1)!.year}`
                  : "By year"}
            </div>
            <div
              role="img"
              aria-label={`Research articles per year, by author position: ${r.output.byYear.map((y) => `${yearTip(y)}`).join("; ")}`}
              className="border-apollo-border-strong flex h-[120px] items-end gap-2 border-b pt-[18px]"
            >
              {r.output.byYear.map((y) => (
                // Senior at the base, then co-author, then first author on top; a
                // 2px card-colored gap between segments, rounded only at the top.
                // ponytail: native `title` tooltips; a styled hover layer if asked.
                <div
                  key={y.year}
                  title={yearTip(y)}
                  data-testid={`bibliometrics-year-${y.year}`}
                  className="flex flex-1 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                  style={{ height: `${(y.count / peak) * 100}%` }}
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
            <div className="text-apollo-ink-2 flex justify-between text-xs">
              <span>{r.output.byYear[0]?.year}</span>
              <span>{r.output.byYear[r.output.byYear.length - 1]?.year}</span>
            </div>
          </div>
        </div>
      </section>

      <section className={SECTION}>
        <SectionHead title="Guideline and policy citations" filtered />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="bg-apollo-surface-2 text-apollo-ink-2">
                <th scope="col" className={TH}>
                  Cited in
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Papers cited
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Citing documents
                </th>
              </tr>
            </thead>
            <tbody>
              {r.policy.map((l) => (
                <tr key={l.level} className="border-apollo-border border-b last:border-b-0">
                  <th scope="row" className="p-2.5 text-left font-normal">
                    <span className={l.level === "authority" ? "font-semibold" : undefined}>
                      {l.label}
                    </span>
                    {l.bodies.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {l.bodies.map((b) => (
                          <span key={b.body} className={BADGE_AUTHORITY}>
                            {b.body} · {b.count}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </th>
                  <td className="p-2.5 text-right align-top">{l.papers.toLocaleString()}</td>
                  <td className="p-2.5 text-right align-top">{l.documents.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {patents ? (
        <section className={SECTION} data-testid="bibliometrics-patents">
          <SectionHead title="Patents citing this work" filtered />
          <p className="text-[15px] leading-[1.6]" data-testid="bibliometrics-patents-line">
            {patents}
            {r.patents.dataEnd ? `, in patent data through ${r.patents.dataEnd}.` : "."}
          </p>
          <p className="text-apollo-ink-2 text-[13px]">{OWN_PATENTS_NOTE}</p>
          {r.patents.list.length > 0 ? (
            <TrialPatentGroup
              icon={<FileText className="size-[15px]" strokeWidth={2} aria-hidden="true" />}
              heading="Citing inventions"
              count={plural(r.patents.inventions, "invention", "inventions")}
              blurb="Inventions citing the most papers come first. Related patents for one invention are grouped. The download lists every invention and the papers each one cites."
              items={r.patents.list}
              total={r.patents.inventions}
              nouns={["invention", "inventions"]}
              row={(inv) => <InventionRow invention={inv} note={`cites ${plural(inv.papers, "paper", "papers")}`} />}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-4">
            <Button asChild variant="outline" className="min-h-11">
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
                Open the Patent citations report for this person
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {reach ? (
        <section className={SECTION} data-testid="bibliometrics-reach">
          <SectionHead title="Downstream reach" />
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-apollo-surface-2 text-apollo-ink-2">
                <th scope="col" className={TH}>
                  Cited by
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Publications cited
                </th>
              </tr>
            </thead>
            <tbody>
              {reach.lines.map((l) => (
                <tr key={l.type} className="border-apollo-border border-b last:border-b-0">
                  <th scope="row" className="p-2.5 text-left font-normal">
                    {l.label}
                  </th>
                  <td className="p-2.5 text-right align-top">
                    <a
                      href={l.href}
                      className={LINK}
                      aria-label={`${plural(l.papers, "publication", "publications")} cited by ${l.label.toLowerCase()}, in the Downstream reach report`}
                      data-testid={`bibliometrics-reach-${l.type}`}
                    >
                      {l.papers.toLocaleString()}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-apollo-ink-2 text-[13px]">{reach.note}</p>
        </section>
      ) : null}

      {r.stages ? <StagesSection stages={r.stages} /> : null}

      <section className={SECTION}>
        <SectionHead title="Most impactful papers" filtered />
        {r.papers.rows.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="bg-apollo-surface-2 text-apollo-ink-2">
                    <th scope="col" className={TH}>
                      Paper
                    </th>
                    <th scope="col" className={TH}>
                      Position
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      NIH percentile
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Citation ratio
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Cited by
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.papers.rows.map((p) => (
                    <PaperRows key={p.pmid} paper={p} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-apollo-ink-2 text-[13px]">{papersNote(r)}</p>
          </>
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

function Tile({ value, share, label }: { value: string; share?: string; label: string }) {
  return (
    <div className={`${LIGHT_BOX} px-4 py-3.5`}>
      <div className="text-[30px] leading-[1.1] font-semibold tabular-nums">
        {value}
        {share ? <span className="text-apollo-ink-2 text-base font-medium"> · {share}</span> : null}
      </div>
      <div className="text-apollo-ink-2 mt-1 text-sm">{label}</div>
    </div>
  );
}

/** Research articles by translational stage; each count opens its papers. */
function StagesSection({ stages }: { stages: BibliometricsStages }) {
  const [open, setOpen] = React.useState<StageBucket | null>(null);
  const max = Math.max(1, ...STAGE_BUCKETS.map((k) => stages.counts[k]));
  const total = STAGE_BUCKETS.reduce((n, k) => n + stages.counts[k], 0);
  return (
    <section className={SECTION} data-testid="bibliometrics-stages">
      <SectionHead title="Translational stage" filtered />
      <p className="text-apollo-ink-2 text-[13px]">{STAGES_NOTE}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="bg-apollo-surface-2 text-apollo-ink-2">
              <th scope="col" className={TH}>
                Stage
              </th>
              <th scope="col" className={TH}>
                Papers
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {STAGE_BUCKETS.map((k) => {
              const n = stages.counts[k];
              const listId = `bibliometrics-stage-${k}`;
              return (
                <React.Fragment key={k}>
                  <tr className="border-apollo-border border-b">
                    <th scope="row" className="p-2.5 text-left font-normal">
                      {k === "none" ? (
                        <span className="text-apollo-ink-2">{NO_STAGE_LABEL}</span>
                      ) : (
                        <>
                          <span className="font-semibold">{k.replace("-", "\u2013")}</span>{" "}
                          <span className="text-apollo-ink-2">{TRANSLATIONAL_STAGE_LABELS[k]}</span>
                        </>
                      )}
                    </th>
                    <td className="w-1/2 p-2.5">
                      <span className="flex flex-col gap-1">
                        {n > 0 ? (
                          <button
                            type="button"
                            className={`${LINK} min-h-6 self-start text-left tabular-nums`}
                            aria-expanded={open === k}
                            aria-controls={listId}
                            onClick={() => setOpen(open === k ? null : k)}
                          >
                            {n.toLocaleString()}
                          </button>
                        ) : (
                          <span className="tabular-nums">0</span>
                        )}
                        <span className="bg-apollo-surface-2 block h-1.5 rounded-full" aria-hidden>
                          <span
                            className={`block h-1.5 rounded-full ${k === "none" ? "bg-apollo-border-strong" : "bg-apollo-slate"}`}
                            style={{ width: `${(n / max) * 100}%` }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className="p-2.5 text-right tabular-nums">{k === "none" ? "–" : `${stages.shares[k]}%`}</td>
                  </tr>
                  {open === k ? (
                    <tr className="border-apollo-border border-b">
                      <td colSpan={3} className="bg-apollo-surface-2 px-2.5 py-2">
                        <ul id={listId} className="flex flex-col gap-2" aria-label={`${n} papers`}>
                          {stages.papers[k].map((p) => (
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
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
            <tr>
              <th scope="row" className="p-2.5 text-left font-semibold">
                All research articles
              </th>
              <td className="p-2.5 font-semibold tabular-nums">{total.toLocaleString()}</td>
              <td className="p-2.5 text-right font-semibold tabular-nums">–</td>
            </tr>
          </tbody>
        </table>
      </div>
      {stages.portfolioHref ? (
        <a href={stages.portfolioHref} className={`${LINK} min-h-11 self-start text-sm font-medium`}>
          Full translational profile (first or senior author, every publication type)
        </a>
      ) : null}
    </section>
  );
}

/** "2019: 41 (first 6, senior 28, co-author 7)" */
const yearTip = (y: BibliometricsReport["output"]["byYear"][number]) =>
  `${y.year}: ${y.count}${y.count > 0 ? ` (first ${y.first}, senior ${y.senior}, co-author ${y.co})` : ""}`;

function PaperRows({ paper: p }: { paper: BibliometricsPaper }) {
  const [open, setOpen] = React.useState(false);
  const id = citationIdentifier(p.pmid);
  const title = pubTitleProps(sanitizePubTitle(p.title), id.href ? LINK : undefined);
  const hasCitations = p.authority.length + p.guidelines + p.consensus + p.reviews + p.patents > 0;
  const plain = [
    p.consensus > 0 ? plural(p.consensus, "consensus statement", "consensus statements") : null,
    p.reviews > 0 ? plural(p.reviews, "systematic review", "systematic reviews") : null,
    p.patents > 0 ? plural(p.patents, "patent", "patents") : null,
  ].filter(Boolean);
  const citingId = `bibliometrics-citing-${p.pmid}`;
  return (
    <>
      <tr className="border-apollo-border border-b" data-testid={`bibliometrics-paper-${p.pmid}`}>
        <td className="p-2.5">
          {id.href ? (
            <a href={id.href} target="_blank" rel="noopener noreferrer" {...title} />
          ) : (
            <span {...title} />
          )}
          <div className="text-apollo-ink-2 text-[13px] leading-normal">
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
            <br />
            {id.label} {id.value}
            {id.label === "PMID" ? <CopyPmid pmid={p.pmid} /> : null}
            {p.doi ? (
              <>
                {" · "}
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
          {p.wcmAuthors.length > 0 ? <AuthorPills authors={p.wcmAuthors} /> : null}
          {hasCitations ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {p.authority.map((a) => (
                <span key={a.body} className={BADGE_AUTHORITY}>
                  <Landmark className="size-3" strokeWidth={2} aria-hidden />
                  {authorityBadgeLabel(a.body, a.count)}
                </span>
              ))}
              {p.guidelines > 0 ? (
                <span className={BADGE_TINT}>
                  {plural(p.guidelines, "clinical guideline", "clinical guidelines")}
                </span>
              ) : null}
              {plain.length > 0 ? (
                <span className="text-apollo-ink-2 text-[13px]">{plain.join(" · ")}</span>
              ) : null}
              {p.citing.length > 0 || p.citingPatents ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={citingId}
                  onClick={() => setOpen((o) => !o)}
                  className="text-apollo-slate min-h-11 px-1.5 text-[13px] font-medium underline"
                >
                  {open ? "Less" : "More"}
                </button>
              ) : null}
            </div>
          ) : null}
        </td>
        <td className="p-2.5 align-top">{POSITION_LABEL[p.position]}</td>
        <td className="p-2.5 text-right align-top">{percentileText(p)}</td>
        <td className="p-2.5 text-right align-top">{p.relativeCitationRatio?.toFixed(1) ?? "n/a"}</td>
        <td className="p-2.5 text-right align-top">{p.citationCount.toLocaleString()}</td>
      </tr>
      {open ? (
        <tr id={citingId} className="border-apollo-border border-b">
          <td colSpan={5} className="px-2.5 pb-4">
            <div className="flex flex-col gap-3">
              <PolicyCitationGroups docs={p.citing} reviewTotal={p.reviewTotal} />
              {p.citingPatents ? (
                <TrialPatentGroup
                  icon={<FileText className="size-[15px]" strokeWidth={2} aria-hidden="true" />}
                  heading="Patents that cite this paper"
                  count={plural(p.citingPatents.total, "invention", "inventions")}
                  blurb="US patents whose text or references cite this paper. Citing a paper does not mean its authors hold the patent. Related patents for one invention are grouped."
                  items={p.citingPatents.items}
                  total={p.citingPatents.total}
                  nouns={["invention", "inventions"]}
                  row={(inv) => <InventionRow invention={inv} />}
                />
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
