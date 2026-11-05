/**
 * Matcha report v2: the printable scouting report's body (coverage-table layout). A SERVER
 * component (no "use client"): it renders only what `loadMatchaReport` returns, and that loader
 * never selects notes, researcher emails, scores, researcher-type labels, InfoEd routing fields,
 * award amounts or the raw paste.
 *
 * Order: dark header bar → hero (eyebrow, title, count subtitle, Prepared by / Contact / Source)
 * → four stat cards → coverage of the ask + gaps (only when themes exist) → shortlist → one
 * profile card per PI → footer with the full search terms.
 *
 * Print: the browser's own Print / Save as PDF. 18mm margins, a profile card, the coverage table
 * and the gaps callout never split across pages, colours printed exactly, and the footer rides
 * every printed page as a page-margin box (Chromium); on screen it is the last block.
 */
import type { MatchaReport, ReportPi } from "@/lib/api/matcha-report";
import type { MatchaFitTier } from "@/lib/api/matcha-contract";
import { briefSourceLabel, briefSourceUrl, reporterUrl } from "@/lib/edit/matcha-brief-types";
import {
  capitalize,
  joinWords,
  numberWord,
  type CoverageMark,
} from "@/lib/edit/matcha-report-coverage";
import { MatchaPrintButton } from "@/components/edit/matcha-print-button";
import { PubTitle } from "@/components/publication/pub-html";

export const NOT_EVIDENT = "Not evident from Scholars records.";
export const NO_BRIEF = "No brief drafted.";
export const NO_FUNDING = "None on record in Scholars.";

const FIT_LABEL: Record<MatchaFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

const MARK_LABEL: Record<CoverageMark, string> = {
  primary: "Primary focus",
  related: "Related work",
  none: "None",
};

export function reportDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export function reportFooterText(d: Date): string {
  return (
    `Drawn from Weill Cornell Scholars records on ${reportDate(d)}. Funding and technology ` +
    "details come from institutional records; summaries were drafted with AI assistance."
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Eleven Weill Cornell investigators whose … match your areas of interest. …" */
export function reportSubtitle(n: number): string {
  const lead = capitalize(numberWord(n));
  return (
    `${lead} Weill Cornell ${plural(n, "investigator", "investigators")} whose published work, ` +
    "funding and technologies match your areas of interest. Ranked by " +
    "fit, with suggested discussion topics for each."
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
  [data-matcha-report] {
    background: #fff !important;
    font-size: 9.5pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  [data-report-bar], [data-report-amber], [data-report-mark], [data-report-avatar] {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  [data-report-body] { padding: 16px 0 0 !important; max-width: none !important; gap: 24px !important; }
  [data-report-bar] > div { padding-left: 0 !important; padding-right: 0 !important; }
  [data-report-screen-only] { display: none !important; }
  [data-report-pi], [data-report-coverage-table], [data-report-gaps], [data-report-stats] {
    break-inside: avoid;
  }
  [data-report-shortlist-item] { break-inside: avoid; }
  [data-report-coverage-scroll] { overflow: visible !important; }
  [data-report-coverage-table] { min-width: 0 !important; }
  [data-report-footer] { border-top: 0 !important; padding-top: 0 !important; }
  [data-report-footer-text] { display: none !important; }
}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[12px] font-semibold tracking-[0.06em] text-[var(--evidence-faint)] uppercase">
      {children}
    </h4>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="m-0 font-serif text-[28px] font-normal">{children}</h2>;
}

function ExtLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "text-apollo-slate hover:text-apollo-maroon hover:underline"}
    >
      {children}
    </a>
  );
}

function FitChip({ fit, size = "sm" }: { fit: MatchaFitTier; size?: "sm" | "md" }) {
  const pad = size === "md" ? "px-2.5 py-[3px]" : "px-2 py-0.5";
  const tone =
    fit === "strong"
      ? "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate"
      : "bg-apollo-surface-2 border-apollo-border-strong text-[var(--evidence-body)]";
  return (
    <span
      className={`rounded-full border text-[12px] font-semibold whitespace-nowrap ${pad} ${tone}`}
    >
      {FIT_LABEL[fit]}
    </span>
  );
}

function Mark({ mark }: { mark: CoverageMark }) {
  if (mark === "primary") {
    return (
      <span
        data-report-mark="primary"
        role="img"
        aria-label={MARK_LABEL.primary}
        title={MARK_LABEL.primary}
        className="bg-apollo-slate block size-3 rounded-full"
      />
    );
  }
  if (mark === "related") {
    return (
      <span
        data-report-mark="related"
        role="img"
        aria-label={MARK_LABEL.related}
        title={MARK_LABEL.related}
        className="border-apollo-slate box-border block size-3 rounded-full border-2"
      />
    );
  }
  return (
    <span
      data-report-mark="none"
      role="img"
      aria-label={MARK_LABEL.none}
      className="bg-apollo-border-strong block h-px w-3"
    />
  );
}

/** First and last initials ("Jane A. Doe" → "JD"), letters only. */
export function avatarInitials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return "";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function Avatar({ pi }: { pi: ReportPi }) {
  return (
    <div
      data-report-avatar
      className="bg-apollo-surface-2 border-apollo-border relative flex size-14 flex-none items-center justify-center overflow-hidden rounded-full border font-serif text-[20px] text-[var(--evidence-body)] sm:size-[72px] sm:text-[24px]"
    >
      <span aria-hidden="true">{avatarInitials(pi.shortName)}</span>
      {pi.photoUrl ? (
        // A background image, not <img>: a directory 404 then simply leaves the initials showing.
        <div
          role="img"
          aria-label={pi.shortName}
          className="absolute inset-0 bg-cover bg-top"
          style={{ backgroundImage: `url(${JSON.stringify(pi.photoUrl)})` }}
        />
      ) : null}
    </div>
  );
}

function StatCard({
  value,
  children,
  amber = false,
}: {
  value: number;
  children: React.ReactNode;
  amber?: boolean;
}) {
  return (
    <div
      {...(amber ? { "data-report-amber": "", "data-report-gaps-card": "" } : {})}
      className={`flex flex-col gap-1.5 rounded-[var(--apollo-radius-card)] border p-5 ${
        amber
          ? "bg-apollo-amber-tint border-apollo-amber-tint-border"
          : "bg-apollo-surface border-apollo-border"
      }`}
    >
      <div className={`font-serif text-[36px] leading-none ${amber ? "text-apollo-amber" : ""}`}>
        {value}
      </div>
      <div className={`text-[14px] ${amber ? "text-[#5a3c05]" : "text-[var(--evidence-body)]"}`}>
        {children}
      </div>
    </div>
  );
}

function Stats({ report }: { report: MatchaReport }) {
  const n = report.pis.length;
  const tiers = (["strong", "good", "weak"] as const)
    .map((t) => ({ t, k: report.pis.filter((pi) => pi.fit === t).length }))
    .filter((x) => x.k > 0)
    .map((x) => `${x.k} ${x.t} fit`);
  const awards = report.pis.reduce((s, pi) => s + pi.funding.length, 0);
  const funded = report.pis.filter((pi) => pi.funding.length > 0).length;
  const techs = report.pis.flatMap((pi) => pi.translation.map((t) => t.title));
  const uniqueTechs = [...new Set(techs)];
  const gaps = report.coverage?.gaps ?? [];
  return (
    <section
      data-report-stats
      aria-label="At a glance"
      className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 print:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]"
    >
      <StatCard value={n}>
        {plural(n, "investigator", "investigators")} matched
        {tiers.length ? `, ${joinWords(tiers)}` : ""}
      </StatCard>
      <StatCard value={awards}>
        {awards > 0
          ? `active sponsored ${plural(awards, "award", "awards")} across ${funded} ${plural(funded, "investigator", "investigators")}`
          : "active sponsored awards on record"}
      </StatCard>
      <StatCard value={uniqueTechs.length}>
        {uniqueTechs.length === 1
          ? `licensable technology on record (${uniqueTechs[0]})`
          : "licensable technologies on record"}
      </StatCard>
      {gaps.length > 0 ? (
        <StatCard value={gaps.length} amber>
          {plural(gaps.length, "area", "areas")} with no strong match yet:{" "}
          {joinWords(gaps.map((g) => g.label))}
        </StatCard>
      ) : null}
    </section>
  );
}

/** "No investigator in this set works directly on A or B. X's work is the closest match on A. …" */
export function gapsProse(report: MatchaReport): string | null {
  const gaps = report.coverage?.gaps ?? [];
  if (gaps.length === 0) return null;
  const nameOf = new Map(report.pis.map((pi) => [pi.cwid, pi.shortName]));
  const parts = [
    `No investigator in this set works directly on ${joinWords(
      gaps.map((g) => g.label),
      "or",
    )}.`,
  ];
  for (const g of gaps) {
    const who = g.closestCwid ? nameOf.get(g.closestCwid) : undefined;
    if (who) parts.push(`${who}'s work is the closest match on ${g.label}.`);
  }
  parts.push(
    `CTL can run a targeted search on ${plural(gaps.length, "this theme", "these themes")} on request.`,
  );
  return parts.join(" ");
}

function Coverage({ report }: { report: MatchaReport }) {
  const themes = report.themes;
  const coverage = report.coverage;
  if (!themes || !coverage) return null;
  const prose = gapsProse(report);
  const nTerms = report.searchTerms.length;
  return (
    <section data-report-coverage aria-label="Coverage of your ask" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <H2>Coverage of your ask</H2>
        <p className="m-0 max-w-[720px] text-[15px] text-pretty text-[var(--evidence-body)]">
          Your {nTerms} search {plural(nTerms, "term", "terms")}, grouped into{" "}
          {numberWord(themes.length)} {plural(themes.length, "theme", "themes")}. Each mark shows
          where an investigator&rsquo;s record supports the theme.
        </p>
      </div>
      <div
        data-report-coverage-scroll
        className="bg-apollo-surface border-apollo-border overflow-x-auto rounded-[var(--apollo-radius-card)] border"
      >
        <table
          data-report-coverage-table
          className="w-full min-w-[820px] table-fixed border-collapse text-left"
        >
          <colgroup>
            <col className="w-[260px] print:w-[30%]" />
            {themes.map((t) => (
              <col key={t.label} />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-apollo-surface-2 border-apollo-border-strong border-b text-[12px] font-semibold text-[var(--evidence-body)]">
              <th scope="col" className="px-4 py-3 font-semibold">
                Investigator
              </th>
              {themes.map((t) => (
                <th
                  key={t.label}
                  scope="col"
                  className="px-2 py-3 text-center leading-[1.3] font-semibold"
                >
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.pis.map((pi, i) => (
              <tr key={pi.cwid} className="border-apollo-border border-b text-[14px]">
                <th scope="row" className="px-4 py-2.5 font-normal">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="w-4 flex-none text-[12px] text-[var(--evidence-faint)]">
                      {pi.rank}
                    </span>
                    <ExtLink
                      href={pi.profileUrl}
                      className="text-apollo-slate hover:text-apollo-maroon font-semibold hover:underline"
                    >
                      {pi.name}
                    </ExtLink>
                  </span>
                </th>
                {coverage.rows[i].marks.map((m, j) => (
                  <td key={j} className="py-2.5">
                    <span className="flex justify-center">
                      <Mark mark={m} />
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr
              data-report-totals
              className="bg-apollo-surface-2 text-[12px] text-[var(--evidence-faint)]"
            >
              <th scope="row" className="px-4 py-2.5 font-semibold">
                Investigators
              </th>
              {coverage.totals.map((t, j) => (
                <td key={j} className="px-2 py-2.5 text-center">
                  {t}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-[var(--evidence-body)]">
        <div className="flex items-center gap-2">
          <Mark mark="primary" />
          Primary focus
        </div>
        <div className="flex items-center gap-2">
          <Mark mark="related" />
          Related work
        </div>
      </div>
      {prose ? (
        <div
          data-report-gaps
          data-report-amber
          className="bg-apollo-amber-tint border-apollo-amber-tint-border flex flex-col gap-1 rounded-[10px] border px-5 py-4 text-[14px] leading-[1.55] text-[#5a3c05]"
        >
          <div className="font-semibold">Gaps in this report</div>
          <div className="text-pretty">{prose}</div>
        </div>
      ) : null}
    </section>
  );
}

function Shortlist({ report }: { report: MatchaReport }) {
  return (
    <section aria-label="Shortlist" className="flex flex-col gap-4">
      <H2>Shortlist</H2>
      {report.pis.length > 0 ? (
        <div className="flex flex-col gap-2">
          {report.pis.map((pi) => (
            <a
              key={pi.cwid}
              href={`#pi-${pi.rank}`}
              data-report-shortlist-item
              className="bg-apollo-surface border-apollo-border hover:border-apollo-border-strong grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[10px] border px-5 py-4 text-[#1a1a1a] no-underline hover:shadow-[var(--apollo-shadow-card)]"
            >
              <div className="font-serif text-[22px] leading-[1.2] text-[var(--evidence-faint)]">
                {pi.rank}
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[16px] font-semibold">{pi.name}</span>
                  <span className="text-[13px] text-[var(--evidence-faint)]">
                    {[pi.title, pi.department].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {pi.oneLine ? (
                  <div className="text-[14px] leading-normal text-pretty text-[var(--evidence-body)]">
                    {pi.oneLine}
                  </div>
                ) : (
                  <div className="text-[14px] text-[var(--evidence-faint)] italic">{NO_BRIEF}</div>
                )}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <FitChip fit={pi.fit} />
                  {pi.signals.map((s) => (
                    <span
                      key={s}
                      data-report-signal
                      className="bg-apollo-surface-2 border-apollo-border rounded-full border px-2 py-0.5 text-[12px] text-[var(--evidence-body)]"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <p className="text-[var(--evidence-faint)]">No researchers selected.</p>
      )}
    </section>
  );
}

function Empty() {
  return <p className="m-0 text-[14px] text-[var(--evidence-faint)] italic">{NOT_EVIDENT}</p>;
}

function ProfileCard({ pi }: { pi: ReportPi }) {
  const titleLine = [pi.title, pi.department].filter(Boolean).join(" · ");
  return (
    <article
      id={`pi-${pi.rank}`}
      data-report-pi={pi.cwid}
      aria-label={`${pi.rank}. ${pi.name}`}
      className="bg-apollo-surface border-apollo-border overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]"
    >
      <div className="border-apollo-border flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-5 pt-6 pb-5 sm:px-7">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="font-serif text-[28px] leading-none text-[var(--evidence-faint)] sm:text-[32px]">
            {pi.rank}
          </div>
          <Avatar pi={pi} />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="m-0 font-serif text-[22px] leading-[1.2] font-normal sm:text-[24px]">
              {pi.name}
            </h3>
            {titleLine ? (
              <div className="text-[14px] text-[var(--evidence-body)]">{titleLine}</div>
            ) : null}
            {pi.centers.length > 0 ? (
              <div className="text-[13px] text-[var(--evidence-faint)]">
                {pi.centers.join(" · ")}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-row items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
          <FitChip fit={pi.fit} size="md" />
          <ExtLink
            href={pi.profileUrl}
            className="text-apollo-slate hover:text-apollo-maroon text-[13px] font-semibold hover:underline"
          >
            Scholars profile ↗
          </ExtLink>
        </div>
      </div>

      <div className="flex flex-col md:flex-row print:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-[22px] px-5 py-6 sm:px-7">
          {pi.brief ? (
            <>
              <div className="flex flex-col gap-2">
                <SectionLabel>Why this investigator</SectionLabel>
                {pi.brief.why.trim() ? (
                  <p className="m-0 text-[15px] leading-[1.6] text-pretty">{pi.brief.why}</p>
                ) : (
                  <Empty />
                )}
              </div>
              <div className="flex flex-col gap-2.5">
                <SectionLabel>Suggested discussion topics</SectionLabel>
                {pi.brief.topics.length > 0 ? (
                  <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
                    {pi.brief.topics.map((t, i) => (
                      <li
                        key={i}
                        className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[15px] leading-normal"
                      >
                        <span className="text-apollo-slate font-semibold">{i + 1}</span>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-pretty">{t.text}</span>
                          {t.sources.length > 0 ? (
                            <span className="text-[13px] text-[var(--evidence-faint)]">
                              {t.sources.map((s, j) => {
                                const url = briefSourceUrl(s);
                                const label = briefSourceLabel(s);
                                return (
                                  <span key={j}>
                                    {j > 0 ? "; " : ""}
                                    {url ? (
                                      <ExtLink
                                        href={url}
                                        className="hover:text-apollo-maroon text-inherit hover:underline"
                                      >
                                        {label}
                                      </ExtLink>
                                    ) : (
                                      label
                                    )}
                                  </span>
                                );
                              })}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty />
                )}
              </div>
            </>
          ) : (
            <p className="m-0 text-[15px] text-[var(--evidence-faint)] italic" data-report-no-brief>
              {NO_BRIEF}
            </p>
          )}

          {pi.translation.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel>Available technology</SectionLabel>
              {pi.translation.map((t, i) => (
                <div
                  key={i}
                  className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate rounded-lg border px-3.5 py-3 text-[15px] font-semibold"
                >
                  <ExtLink href={t.url} className="text-apollo-slate hover:underline">
                    {t.title}
                  </ExtLink>
                  {t.patentStatus ? (
                    <span className="font-normal text-[var(--evidence-body)]">
                      {" "}
                      · {t.patentStatus}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <SectionLabel>Active funding · {pi.funding.length}</SectionLabel>
            {pi.funding.length === 0 ? (
              <div className="text-[14px] text-[var(--evidence-faint)]">{NO_FUNDING}</div>
            ) : (
              <div className="border-apollo-border flex flex-col border-t">
                {/* No mechanism on any award (e.g. all foundation grants) → drop the column. */}
                {pi.funding.map((g, i, all) => (
                  <div
                    key={i}
                    className={`border-apollo-border grid ${all.some((a) => a.mechanism) ? "grid-cols-[56px_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"} items-baseline gap-3 border-b py-2.5 text-[14px] leading-[1.45]`}
                  >
                    {all.some((a) => a.mechanism) && (
                      <span className="font-mono text-[12px] font-semibold text-[var(--evidence-body)]">
                        {g.mechanism ?? ""}
                      </span>
                    )}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-pretty">
                        {g.applId != null ? (
                          <ExtLink
                            href={reporterUrl(g.applId)}
                            className="hover:text-apollo-maroon text-inherit hover:underline"
                          >
                            {g.title}
                          </ExtLink>
                        ) : (
                          g.title
                        )}
                      </span>
                      <span className="text-[12px] text-[var(--evidence-faint)]">{g.funder}</span>
                    </div>
                    <span className="text-[12px] whitespace-nowrap text-[var(--evidence-faint)]">
                      to {g.endYear}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="bg-apollo-surface-2 border-apollo-border flex flex-col gap-3 border-t p-5 sm:p-6 md:w-[300px] md:flex-none md:border-t-0 md:border-l print:w-[34%] print:flex-none print:border-t-0 print:border-l">
          <SectionLabel>Key papers</SectionLabel>
          {pi.keyPapers.length > 0 ? (
            pi.keyPapers.map((paper) => (
              <a
                key={paper.pmid}
                href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.pmid)}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-apollo-surface border-apollo-border hover:border-apollo-border-strong flex flex-col gap-1 rounded-lg border p-3 text-[#1a1a1a] no-underline"
              >
                {paper.year != null ? (
                  <span className="text-[12px] font-semibold text-[var(--evidence-faint)]">
                    {paper.year}
                  </span>
                ) : null}
                <PubTitle value={paper.title} className="text-[14px] leading-[1.4] text-pretty" />
                <span className="text-apollo-slate text-[12px]">PMID {paper.pmid} ↗</span>
              </a>
            ))
          ) : (
            <Empty />
          )}
        </aside>
      </div>
    </article>
  );
}

export function MatchaReportView({ report }: { report: MatchaReport }) {
  const footer = reportFooterText(report.generatedAt);
  return (
    <main
      data-matcha-report
      className="bg-apollo-page min-h-screen font-sans text-[#1a1a1a] antialiased"
    >
      <style dangerouslySetInnerHTML={{ __html: printCss(footer) }} />
      <div data-report-bar className="bg-apollo-bar text-white">
        <div className="mx-auto flex max-w-[1040px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5 text-[13px] sm:px-8">
          <div className="font-semibold tracking-[0.01em]">Weill Cornell Medicine</div>
          <div className="text-[#d9d3ce]">
            Investigator scouting report · {reportDate(report.generatedAt)}
          </div>
        </div>
      </div>

      <div
        data-report-body
        className="mx-auto flex max-w-[1040px] flex-col gap-10 px-4 pt-6 pb-20 sm:px-8"
      >
        <div
          data-report-screen-only
          className="flex flex-wrap items-center justify-end gap-3 text-[13px] text-[var(--evidence-faint)]"
        >
          <span>Use your browser&rsquo;s print dialog to save a PDF</span>
          <MatchaPrintButton />
        </div>

        <header className="flex flex-col gap-6">
          <div className="text-apollo-maroon text-[12px] font-semibold tracking-[0.08em] uppercase">
            Matcha scouting report
          </div>
          <h1 className="m-0 max-w-[820px] font-serif text-[32px] leading-[1.12] font-normal tracking-[-0.01em] text-balance sm:text-[44px]">
            {report.title}
          </h1>
          <p className="m-0 max-w-[720px] text-[17px] leading-[1.55] text-pretty text-[var(--evidence-body)]">
            {reportSubtitle(report.pis.length)}
          </p>
          <div className="border-apollo-border-strong flex flex-wrap gap-x-10 gap-y-3 border-t pt-5 text-[14px]">
            {report.requester ? (
              <div data-slot="matcha-report-prepared-for" className="flex flex-col gap-0.5">
                <span className="text-[12px] text-[var(--evidence-faint)]">Prepared for</span>
                <span className="font-semibold">{report.requester}</span>
              </div>
            ) : null}
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] text-[var(--evidence-faint)]">Prepared by</span>
              <span className="font-semibold">
                {report.officer.name}
                {report.officer.dept ? `, ${report.officer.dept}` : ""}
              </span>
            </div>
            {report.officer.email ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px] text-[var(--evidence-faint)]">Contact</span>
                <a
                  href={`mailto:${report.officer.email}`}
                  className="text-apollo-slate hover:text-apollo-maroon font-semibold hover:underline"
                >
                  {report.officer.email}
                </a>
              </div>
            ) : null}
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] text-[var(--evidence-faint)]">Source</span>
              <span className="font-semibold">
                Matcha, using Weill Cornell Scholars data as of {shortDate(report.generatedAt)}
              </span>
            </div>
          </div>
        </header>

        <Stats report={report} />
        <Coverage report={report} />
        <Shortlist report={report} />

        {report.pis.length > 0 ? (
          <section aria-label="Investigator profiles" className="flex flex-col gap-6">
            <H2>Investigator profiles</H2>
            {report.pis.map((pi) => (
              <ProfileCard key={pi.cwid} pi={pi} />
            ))}
          </section>
        ) : null}

        <footer
          data-report-footer
          className="border-apollo-border-strong flex flex-col gap-1.5 border-t pt-5 text-[13px] leading-[1.6] text-[var(--evidence-faint)]"
        >
          <div data-report-footer-text className="text-pretty">
            {footer}
          </div>
          {report.searchTerms.length > 0 ? (
            <div data-report-search-terms className="text-pretty">
              Full search terms: {report.searchTerms.join(", ")}.
            </div>
          ) : null}
        </footer>
      </div>
    </main>
  );
}
