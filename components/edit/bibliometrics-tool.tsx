/**
 * `BibliometricsTool` — the client island for the "Bibliometrics" Tools panel
 * (`EDIT_BIBLIOMETRICS`). Fetches the section model from
 * `GET /api/edit/bibliometrics` and renders it; the Word download is the same
 * URL with `format=docx`, so the document carries the filters set on screen.
 * Read-only: nothing here writes.
 */
"use client";

import * as React from "react";
import { Download, Landmark, Lock } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, pubTitleProps } from "@/components/publication/pub-html";
import { PolicyCitationGroups } from "@/components/publication/publication-modal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { citationIdentifier } from "@/lib/citation";
import { authorityBadgeLabel, plural } from "@/lib/citations/policy-rollup";
import {
  NO_SUMMARY_NOTE,
  POSITION_LABEL,
  TOP_DECILE_LABEL,
  bibliometricsQuery,
  papersNote,
  percentileText,
  unratedNote,
  type BibliometricsFilters,
  type BibliometricsPaper,
  type BibliometricsReport,
} from "@/lib/edit/bibliometrics";
import { sanitizePubTitle } from "@/lib/utils";

const PATH = "/api/edit/bibliometrics";
const FAILED = "We couldn't load the bibliometrics report just now. Please try again.";

const CARD = "bg-apollo-surface border-apollo-border flex flex-col gap-3 rounded-xl border px-5 py-[18px]";
const EYEBROW = "text-apollo-ink-2 text-xs font-medium tracking-[0.06em] uppercase";
const LINK = "text-apollo-slate hover:underline";
const BADGE = "inline-flex items-center gap-1 rounded-full border px-2.5 text-xs leading-[18px] font-medium";
const BADGE_FILLED = `${BADGE} border-apollo-slate bg-apollo-slate py-0.5 text-white`;
const BADGE_TINT = `${BADGE} border-apollo-slate-tint-border bg-apollo-slate-tint py-px text-[#274158]`;
const TH = "px-2.5 py-2 text-left text-xs font-medium";
const SELECT =
  "border-apollo-border-strong bg-apollo-surface min-h-11 rounded-lg border px-2.5 text-sm";

export function BibliometricsTool({ entityId }: { entityId: string }) {
  const [filters, setFilters] = React.useState<BibliometricsFilters>({
    authorship: "all",
    yearFrom: null,
    yearTo: null,
  });
  const [report, setReport] = React.useState<BibliometricsReport | null>(null);
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

  const updated = report
    ? new Date(`${report.asOf}T00:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <EditPanel
      slot="bibliometrics-tool"
      heading="Bibliometrics"
      description={
        <span className="inline-flex items-center gap-1.5">
          <Lock className="size-3" aria-hidden />
          Locked — calculated from the publications in Scholars.{updated ? ` Updated ${updated}.` : ""}
        </span>
      }
      headerAction={
        <Button asChild variant="apollo" className="min-h-11">
          <a href={`${PATH}?${query}&format=docx`} download data-testid="bibliometrics-download">
            <Download className="size-4" />
            Download Word document
          </a>
        </Button>
      }
    >
      {failed ? (
        <Alert variant="destructive" data-testid="bibliometrics-error">
          <AlertDescription>{FAILED}</AlertDescription>
        </Alert>
      ) : null}
      {report ? (
        <Report report={report} filters={filters} setFilters={setFilters} />
      ) : failed ? null : (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
    </EditPanel>
  );
}

function Report({
  report: r,
  filters,
  setFilters,
}: {
  report: BibliometricsReport;
  /** The controls follow the local choice; `r` catches up when its fetch lands. */
  filters: BibliometricsFilters;
  setFilters: React.Dispatch<React.SetStateAction<BibliometricsFilters>>;
}) {
  const unrated = unratedNote(r);
  const peak = Math.max(1, ...r.output.byYear.map((y) => y.count));
  const years = r.yearRange
    ? Array.from({ length: r.yearRange.max - r.yearRange.min + 1 }, (_, i) => r.yearRange!.min + i)
    : [];
  return (
    <div className="flex flex-col gap-5" data-testid="bibliometrics-report">
      <section className={CARD}>
        <h3 className={EYEBROW}>Summary</h3>
        {r.summary.length > 0 ? (
          <p className="text-[15px] leading-[1.6]" data-testid="bibliometrics-summary">
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
      </section>

      <section className={CARD}>
        <h3 className={EYEBROW}>Citation metrics</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          <Tile value={String(r.metrics.hIndex)} label="h-index" />
          <Tile value={String(r.metrics.h5Index)} label="h5-index (last 5 years)" />
          <Tile
            value={r.metrics.topDecilePct === null ? "n/a" : `${r.metrics.topDecilePct}%`}
            label={TOP_DECILE_LABEL}
          />
        </div>
        {unrated ? <p className="text-apollo-ink-2 text-[13px]">{unrated}</p> : null}
      </section>

      <section className={CARD}>
        <h3 className={EYEBROW}>Output</h3>
        <div className="flex flex-wrap gap-7">
          <table className="min-w-0 flex-[1_1_260px] text-sm">
            <caption className="pb-1.5 text-left font-semibold">By author position</caption>
            <tbody>
              {(
                [
                  ["First author", r.output.first],
                  ["Senior author", r.output.senior],
                  ["Co-author", r.output.coAuthor],
                ] as const
              ).map(([label, n]) => (
                <tr key={label} className="border-apollo-border border-b">
                  <th scope="row" className="py-2 text-left font-normal">
                    {label}
                  </th>
                  <td className="py-2 text-right">{n.toLocaleString()}</td>
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
            <div className="text-sm font-semibold">By year, last 10 years</div>
            <div
              role="img"
              aria-label={`Research articles per year: ${r.output.byYear.map((y) => `${y.year}, ${y.count}`).join("; ")}`}
              className="border-apollo-border-strong flex h-[120px] items-end gap-2 border-b pt-[18px]"
            >
              {r.output.byYear.map((y) => (
                <div
                  key={y.year}
                  title={`${y.year}: ${y.count}`}
                  className="bg-apollo-slate flex-1 rounded-t-[3px]"
                  style={{ height: `${(y.count / peak) * 100}%` }}
                />
              ))}
            </div>
            <div className="text-apollo-ink-2 flex justify-between text-xs">
              <span>{r.output.byYear[0]?.year}</span>
              <span>{r.output.byYear[r.output.byYear.length - 1]?.year}</span>
            </div>
          </div>
        </div>
      </section>

      <section className={CARD}>
        <h3 className={EYEBROW}>Most impactful papers</h3>
        <div className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap items-end gap-5 rounded-[10px] border px-3.5 py-3">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-apollo-ink-2 text-xs font-medium">Authorship</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(
                [
                  ["all", "All papers"],
                  ["lead", "First or senior author only"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="inline-flex min-h-11 items-center gap-1.5">
                  <input
                    type="radio"
                    name="bibliometrics-authorship"
                    checked={filters.authorship === value}
                    onChange={() => setFilters((f) => ({ ...f, authorship: value }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {(
            [
              ["yearFrom", "Published from", r.yearRange?.min],
              ["yearTo", "Published to", r.yearRange?.max],
            ] as const
          ).map(([key, label, fallback]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <label htmlFor={`bibliometrics-${key}`} className="text-apollo-ink-2 text-xs font-medium">
                {label}
              </label>
              <select
                id={`bibliometrics-${key}`}
                className={SELECT}
                value={filters[key] ?? fallback ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, [key]: Number(e.target.value) }))}
              >
                {years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </div>
          ))}
          <div className="text-apollo-ink-2 pb-3 text-[13px]">
            The Word document uses the filters set here.
          </div>
        </div>
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

      <section className={CARD}>
        <h3 className={EYEBROW}>Guideline and policy citations</h3>
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
                          <span key={b.body} className={BADGE_FILLED}>
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

      <section className="bg-apollo-lock-bg border-apollo-border-strong flex flex-col gap-1.5 rounded-xl border px-5 py-4 text-[13px] leading-[1.55]">
        <h3 className={EYEBROW}>Definitions and sources</h3>
        {r.definitions.map((d) => (
          <div key={d.text}>
            {d.term ? <span className="font-semibold">{d.term}: </span> : null}
            {d.text}
          </div>
        ))}
      </section>
    </div>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-apollo-surface-2 border-apollo-border-strong rounded-[10px] border px-4 py-3.5">
      <div className="text-[28px] leading-[1.2] font-semibold">{value}</div>
      <div className="text-apollo-ink-2 text-[13px]">{label}</div>
    </div>
  );
}

function PaperRows({ paper: p }: { paper: BibliometricsPaper }) {
  const [open, setOpen] = React.useState(false);
  const id = citationIdentifier(p.pmid);
  const title = pubTitleProps(sanitizePubTitle(p.title), id.href ? LINK : undefined);
  const hasCitations = p.authority.length + p.guidelines + p.consensus + p.reviews > 0;
  const plain = [
    p.consensus > 0 ? plural(p.consensus, "consensus statement", "consensus statements") : null,
    p.reviews > 0 ? plural(p.reviews, "systematic review", "systematic reviews") : null,
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
          {hasCitations ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {p.authority.map((a) => (
                <span key={a.body} className={BADGE_FILLED}>
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
              {p.citing.length > 0 ? (
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
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
