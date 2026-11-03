/**
 * Matcha Phase 4: the printable scouting report's body. A SERVER component (no "use client"):
 * it renders only what `loadMatchaReport` returns, and that loader never selects notes, researcher
 * emails, scores, researcher-type labels, InfoEd routing fields or award amounts.
 *
 * Print: the browser's own Print / Save as PDF. 18mm margins, one PI section never split across
 * pages, the summary table's header row repeats, and the footer rides every printed page as a
 * page-margin box (Chromium); on screen it is the last block of the page.
 */
import type { MatchaReport, ReportPi } from "@/lib/api/matcha-report";
import type { MatchaFitTier } from "@/lib/api/matcha-contract";
import {
  briefSourceLabel,
  briefSourceUrl,
  firstSentence,
  reporterUrl,
} from "@/lib/edit/matcha-brief-types";
import { MatchaPrintButton } from "@/components/edit/matcha-print-button";

export const NOT_EVIDENT = "Not evident from Scholars records.";
export const NO_BRIEF = "No brief drafted.";

const FIT_LABEL: Record<MatchaFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

export function reportDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export function reportFooterText(d: Date): string {
  return (
    `Drawn from Weill Cornell Scholars records on ${reportDate(d)}. Funding and technology ` +
    "details come from institutional records; summaries were drafted with AI assistance and " +
    "reviewed by CTL."
  );
}

/** A CSS string literal (for the `@page` margin box): quotes and backslashes escaped. */
function cssString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

function printCss(footer: string): string {
  return `
@page {
  margin: 18mm;
  @bottom-center {
    content: ${cssString(footer)};
    font-family: Inter, Helvetica, Arial, sans-serif;
    font-size: 7.5pt;
    color: #555;
    vertical-align: middle;
  }
}
@media print {
  html, body { background: #fff !important; }
  body > *:not([data-matcha-report]) { display: none !important; }
  [data-matcha-report] { padding: 0 !important; max-width: none !important; font-size: 9.5pt; }
  [data-report-screen-only] { display: none !important; }
  [data-report-cover] { break-after: page; min-height: 0 !important; }
  [data-report-pi] { break-inside: avoid; }
  [data-report-summary] thead { display: table-header-group; }
  [data-report-summary] tr { break-inside: avoid; }
  [data-matcha-report] a { color: inherit !important; text-decoration: underline; }
  [data-report-footer] { display: none !important; }
}`;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-wide uppercase">
      {children}
    </h4>
  );
}

function Empty() {
  return <p className="text-muted-foreground italic">{NOT_EVIDENT}</p>;
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  );
}

function ContactColumn({ pi }: { pi: ReportPi }) {
  return (
    <div className="flex flex-col gap-3">
      <Label>Contact and appointments</Label>
      <div className="-mt-2">
        <p className="font-semibold">{pi.name}</p>
        {pi.title ? <p>{pi.title}</p> : null}
        {pi.department ? <p className="text-muted-foreground">{pi.department}</p> : null}
      </div>
      {pi.secondaryAppointments.length > 0 ? (
        <div>
          <Label>Secondary appointments</Label>
          <ul className="flex flex-col gap-0.5">
            {pi.secondaryAppointments.map((a, i) => (
              <li key={i}>
                {a.title}, {a.organization}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pi.centers.length > 0 ? (
        <div>
          <Label>Centers</Label>
          <ul className="flex flex-col gap-0.5">
            {pi.centers.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <Label>Scholars profile</Label>
        <p className="break-all">
          <ExtLink href={pi.profileUrl}>{pi.profileUrl.replace(/^https?:\/\//, "")}</ExtLink>
        </p>
      </div>
    </div>
  );
}

function ResearchColumn({ pi }: { pi: ReportPi }) {
  return (
    <div className="flex flex-col gap-3">
      <Label>Research and translation</Label>
      {pi.brief ? (
        <>
          <div className="-mt-2">
            <Label>Why this PI</Label>
            {pi.brief.why.trim() ? <p>{pi.brief.why}</p> : <Empty />}
          </div>
          <div>
            <Label>Discussion topics</Label>
            {pi.brief.topics.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {pi.brief.topics.map((t, i) => (
                  <li key={i}>
                    {t.text}
                    {t.sources.length > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        (
                        {t.sources.map((s, j) => {
                          const url = briefSourceUrl(s);
                          const label = briefSourceLabel(s);
                          return (
                            <span key={j}>
                              {j > 0 ? "; " : ""}
                              {url ? <ExtLink href={url}>{label}</ExtLink> : label}
                            </span>
                          );
                        })}
                        )
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground -mt-2 italic" data-report-no-brief>
          {NO_BRIEF}
        </p>
      )}
      <div>
        <Label>Funding</Label>
        {pi.funding.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {pi.funding.map((g, i) => (
              <li key={i}>
                <span className="font-medium">{g.mechanism ?? g.funder}</span>
                {g.mechanism ? ` · ${g.funder}` : ""} · {g.title} (through {g.endYear})
                {g.applId != null ? (
                  <>
                    {" · "}
                    <ExtLink href={reporterUrl(g.applId)}>NIH RePORTER</ExtLink>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
      <div>
        <Label>Translation</Label>
        {pi.translation.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {pi.translation.map((t, i) => (
              <li key={i}>
                <ExtLink href={t.url}>{t.title}</ExtLink>
                {t.patentStatus ? (
                  <span className="text-muted-foreground"> · {t.patentStatus}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
    </div>
  );
}

function EvidenceColumn({ pi }: { pi: ReportPi }) {
  return (
    <div className="flex flex-col gap-3">
      <Label>Fit and evidence</Label>
      <p className="-mt-2 font-semibold">{FIT_LABEL[pi.fit]}</p>
      <div>
        <Label>Key papers</Label>
        {pi.keyPapers.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {pi.keyPapers.map((p) => (
              <li key={p.pmid}>
                {p.year != null ? `${p.year} · ` : ""}
                {p.title}{" "}
                <span className="text-muted-foreground whitespace-nowrap">
                  <ExtLink href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`}>
                    PMID {p.pmid}
                  </ExtLink>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {pi.brief ? `Brief drafted ${reportDate(pi.brief.draftedAt)}` : NO_BRIEF}
      </p>
    </div>
  );
}

function PiSection({ pi }: { pi: ReportPi }) {
  return (
    <section
      data-report-pi={pi.cwid}
      aria-label={`${pi.rank}. ${pi.name}`}
      className="border-border border-t pt-5 pb-6"
    >
      <h3 className="mb-4 font-serif text-lg font-bold">
        <span className="text-muted-foreground mr-2">{pi.rank}.</span>
        {pi.name}
      </h3>
      <div className="grid grid-cols-1 gap-6 text-[13px] leading-snug md:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)] print:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)] print:gap-5">
        <ContactColumn pi={pi} />
        <ResearchColumn pi={pi} />
        <EvidenceColumn pi={pi} />
      </div>
    </section>
  );
}

export function MatchaReportView({ report }: { report: MatchaReport }) {
  const footer = reportFooterText(report.generatedAt);
  return (
    <main
      data-matcha-report
      className="mx-auto max-w-[1000px] bg-white px-4 py-6 text-[14px] text-neutral-900 sm:px-8"
    >
      <style dangerouslySetInnerHTML={{ __html: printCss(footer) }} />
      <div
        data-report-screen-only
        className="border-border bg-muted/60 sticky top-0 z-10 -mx-4 mb-6 flex items-center justify-between gap-3 border-b px-4 py-2 sm:-mx-8 sm:px-8"
      >
        <span className="text-muted-foreground text-sm">
          {report.pis.length} researcher{report.pis.length === 1 ? "" : "s"} · use your
          browser&rsquo;s print dialog to save a PDF
        </span>
        <MatchaPrintButton />
      </div>

      <section data-report-cover className="flex min-h-[70vh] flex-col justify-center gap-6 py-10">
        <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
          Scouting report
        </p>
        <h1 className="font-serif text-4xl leading-tight font-bold">{report.title}</h1>
        <p className="text-muted-foreground">Generated {reportDate(report.generatedAt)}</p>
        <div className="mt-8">
          <p>Prepared by Weill Cornell Center for Technology Licensing</p>
          <p className="font-semibold">{report.officer.name}</p>
          {report.officer.email ? (
            <p>
              <a href={`mailto:${report.officer.email}`} className="underline underline-offset-2">
                {report.officer.email}
              </a>
            </p>
          ) : null}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 font-serif text-xl font-bold">The ask</h2>
        <blockquote className="border-border border-l-2 pl-4 whitespace-pre-wrap">
          {report.ask}
        </blockquote>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 font-serif text-xl font-bold">Summary</h2>
        {report.pis.length > 0 ? (
          <table data-report-summary className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-border border-b-2">
                <th className="py-1.5 pr-3 font-semibold">Rank</th>
                <th className="py-1.5 pr-3 font-semibold">PI</th>
                <th className="py-1.5 pr-3 font-semibold">Title</th>
                <th className="py-1.5 pr-3 font-semibold">Department</th>
                <th className="py-1.5 font-semibold">Why this PI</th>
              </tr>
            </thead>
            <tbody>
              {report.pis.map((pi) => (
                <tr key={pi.cwid} className="border-border border-b align-top">
                  <td className="py-1.5 pr-3">{pi.rank}</td>
                  <td className="py-1.5 pr-3 font-medium">{pi.name}</td>
                  <td className="py-1.5 pr-3">{pi.title ?? ""}</td>
                  <td className="py-1.5 pr-3">{pi.department ?? ""}</td>
                  <td className="py-1.5">
                    {pi.brief ? (
                      firstSentence(pi.brief.why)
                    ) : (
                      <span className="text-muted-foreground italic">{NO_BRIEF}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">No researchers selected.</p>
        )}
      </section>

      {report.pis.map((pi) => (
        <PiSection key={pi.cwid} pi={pi} />
      ))}

      <footer
        data-report-footer
        className="text-muted-foreground border-border mt-6 border-t pt-3 text-xs"
      >
        {footer}
      </footer>
    </main>
  );
}
