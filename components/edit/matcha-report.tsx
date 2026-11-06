/**
 * Matcha report v4: the printable scouting report's body. A SERVER component (no "use client"):
 * it renders only what `loadMatchaReport` returns, and that loader never selects notes,
 * researcher emails, scores, researcher-type labels, InfoEd routing fields, award amounts or the
 * raw paste.
 *
 * Order: header bar → cover (eyebrow, title, subtitle, Prepared for / by, Contact, Source, the
 * full search terms) → one stat line → the gaps paragraph → "Coverage and fit" (themes, Fit and
 * Awards columns) → one section per fit tier → the AI disclaimer, once.
 *
 *  - Strong fit: a full profile (angle band, Why, topics citing numbered key papers, methods,
 *    technology, a key-paper grid, up to three funding lines). One printed page each.
 *  - Good and weak fit: a compact card (two Why sentences, one topic, one technology line, two
 *    papers, a one-line funding summary). Two per printed page.
 *
 * Print: US Letter, a running footer ("Matcha scouting report · Weill Cornell Medicine" left,
 * "Page X of Y" right) as page-margin boxes, no card chrome, a 2px rule between investigators,
 * each tier on a new page. Name and sponsor clean-ups are display-only
 * (`lib/edit/matcha-report-format.ts`).
 */
import type { MatchaReport, ReportPaper, ReportPi } from "@/lib/api/matcha-report";
import { WCM_LOGO_SRC } from "@/components/edit/wcm-logo";
import type { MatchaFitTier } from "@/lib/api/matcha-contract";
import {
  briefSourceLabel,
  briefSourceUrl,
  reporterUrl,
  splitMethods,
  type BriefSource,
} from "@/lib/edit/matcha-brief-types";
import { htmlToPlainText } from "@/lib/utils";
import {
  capitalize,
  joinWords,
  numberWord,
  type CoverageMark,
} from "@/lib/edit/matcha-report-coverage";
import {
  awardCode,
  awardsLabel,
  firstSentences,
  fundingSummary,
  mergeMethods,
  punctuateInitials,
  reportName,
  sponsorShort,
  titleWithoutRequester,
} from "@/lib/edit/matcha-report-format";
import { MatchaPrintButton } from "@/components/edit/matcha-print-button";
import { PubTitle } from "@/components/publication/pub-html";

export const NOT_EVIDENT = "Not evident from Scholars records.";
export const NO_BRIEF = "No brief drafted.";
export const NO_FUNDING = "None on record in Scholars.";
export const NO_ACTIVE_FUNDING = "No active funding on record";
/** The running footer's left text (a page-margin box in print). */
export const RUNNING_FOOTER = "Matcha scouting report · Weill Cornell Medicine";

const FIT_LABEL: Record<MatchaFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

const FIT_SHORT: Record<MatchaFitTier, string> = {
  strong: "Strong",
  good: "Good",
  weak: "Weak",
};

const TIER_ORDER: readonly MatchaFitTier[] = ["strong", "good", "weak"];

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

/** A CSS string literal (for an `@page` margin box): quotes and backslashes escaped. */
function cssString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

/** The print stylesheet: page setup, running footer, page breaks and print-only typography. */
export function printCss(): string {
  return `
@page {
  size: letter;
  margin: 0.55in 0.6in 0.7in 0.6in;
  @bottom-left {
    content: ${cssString(RUNNING_FOOTER)};
    font-family: Inter, Helvetica, Arial, sans-serif;
    font-size: 8pt;
    color: #555;
  }
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-family: Inter, Helvetica, Arial, sans-serif;
    font-size: 8pt;
    color: #555;
  }
}
@media print {
  html, body { background: #fff !important; }
  body > *:not([data-matcha-report]) { display: none !important; }
  [data-matcha-report] {
    background: #fff !important;
    font-size: 14px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  [data-matcha-report] * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  [data-report-body] { padding: 16px 0 0 !important; max-width: none !important; }
  [data-report-bar] > div { padding-left: 0 !important; padding-right: 0 !important; }
  [data-report-screen-only] { display: none !important; }
  [data-report-title] { font-size: 36px !important; max-width: none !important; }
  h2, h3, h4, [data-report-label] { break-after: avoid; page-break-after: avoid; }
  [data-report-coverage], [data-report-gaps], [data-report-stats] { break-inside: avoid; }
  [data-report-coverage-scroll] { overflow: visible !important; border: 0 !important; border-radius: 0 !important; }
  [data-report-coverage-table] { min-width: 0 !important; }
  [data-report-tier] { break-before: page; page-break-before: always; }
  [data-report-pi] {
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  [data-report-pi] + [data-report-pi] { border-top: 2px solid #1a1a1a !important; }
  [data-report-pi="strong"] + [data-report-pi="strong"] { break-before: page; page-break-before: always; }
  [data-report-compact] { break-inside: avoid; }
  [data-report-compact]:nth-of-type(2n+1):not(:first-of-type) { break-before: page; page-break-before: always; }
  [data-report-funding-row], [data-report-paper], [data-report-angle], [data-report-tech] { break-inside: avoid; }
  [data-report-more-methods] { display: none !important; }
  [data-report-footer] { border-top: 0 !important; }
}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4
      data-report-label
      className="m-0 text-[11px] font-semibold tracking-[0.08em] text-[var(--evidence-faint)] uppercase"
    >
      {children}
    </h4>
  );
}

/** A section heading with the short WCM-red rule above it. */
function H2({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="bg-apollo-maroon mb-3 h-0.5 w-[132px]" />
      <h2 className="m-0 font-serif text-[28px] leading-tight font-normal">{children}</h2>
      {sub ? (
        <p className="m-0 max-w-[720px] text-[14px] text-pretty text-[var(--evidence-faint)]">
          {sub}
        </p>
      ) : null}
    </div>
  );
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

/** Strong: a filled slate pill. Good: a slate outline. Weak: a faint outline. */
function FitPill({ fit, short = false }: { fit: MatchaFitTier; short?: boolean }) {
  const tone =
    fit === "strong"
      ? "bg-apollo-slate border-apollo-slate text-white"
      : fit === "good"
        ? "border-apollo-slate text-apollo-slate bg-transparent"
        : "border-apollo-border-strong bg-transparent text-[var(--evidence-faint)]";
  return (
    <span
      data-report-fit={fit}
      className={`inline-block rounded-full border px-2 py-px text-[11px] leading-[1.5] font-semibold whitespace-nowrap ${tone}`}
    >
      {short ? FIT_SHORT[fit] : FIT_LABEL[fit]}
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
        className="bg-apollo-slate block size-2.5 rounded-full"
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
        className="border-apollo-slate box-border block size-2.5 rounded-full border-2"
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

/** 48px photo: an `<img>` over the initials, so a missing headshot (empty alt) leaves them. */
function Avatar({ pi }: { pi: ReportPi }) {
  return (
    <div
      data-report-avatar
      className="bg-apollo-surface-2 border-apollo-border relative flex size-12 flex-none items-center justify-center overflow-hidden rounded-full border font-serif text-[15px] text-[var(--evidence-body)]"
    >
      <span aria-hidden="true">{avatarInitials(pi.shortName)}</span>
      {pi.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external directory photo; must print.
        <img
          src={pi.photoUrl}
          alt=""
          className="absolute inset-0 size-full object-cover object-top"
        />
      ) : null}
    </div>
  );
}

/** Distinct licensable technologies across the report. */
function techCount(report: MatchaReport): number {
  return new Set(report.pis.flatMap((pi) => pi.translation.map((t) => t.title))).size;
}

/** "11 investigators (7 strong, 4 good) · 25 active awards · 1 licensable technology · 2 themes
 *  with no strong match", as one line. */
function StatLine({ report }: { report: MatchaReport }) {
  const n = report.pis.length;
  const tiers = TIER_ORDER.map((t) => ({ t, k: report.pis.filter((pi) => pi.fit === t).length }))
    .filter((x) => x.k > 0)
    .map((x) => `${x.k} ${x.t}`);
  const awards = report.pis.reduce((s, pi) => s + pi.funding.length, 0);
  const techs = techCount(report);
  const gaps = report.coverage?.gaps.length ?? 0;
  const stat = (value: number, label: string, amber = false) => (
    <span
      data-report-stat
      {...(amber ? { "data-report-amber": "" } : {})}
      className={`inline-flex items-baseline gap-1.5 ${amber ? "text-apollo-amber" : ""}`}
    >
      <span className="font-serif text-[26px] leading-none">{value}</span>
      <span className={`text-[14px] ${amber ? "" : "text-[var(--evidence-body)]"}`}>{label}</span>
    </span>
  );
  return (
    <section
      data-report-stats
      aria-label="At a glance"
      className="border-apollo-border-strong flex flex-wrap items-baseline gap-x-7 gap-y-2 border-y py-4"
    >
      {stat(
        n,
        `${plural(n, "investigator", "investigators")}${tiers.length ? ` (${tiers.join(", ")})` : ""}`,
      )}
      {stat(awards, `active ${plural(awards, "award", "awards")}`)}
      {stat(techs, `licensable ${plural(techs, "technology", "technologies")}`)}
      {gaps > 0
        ? stat(gaps, `${plural(gaps, "theme", "themes")} with no strong match`, true)
        : null}
    </section>
  );
}

/** "No investigator in this set works directly on A or B. X's work is the closest match on A. …" */
export function gapsProse(report: MatchaReport): string | null {
  const gaps = report.coverage?.gaps ?? [];
  if (gaps.length === 0) return null;
  const nameOf = new Map(report.pis.map((pi) => [pi.cwid, punctuateInitials(pi.shortName)]));
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

function Gaps({ report }: { report: MatchaReport }) {
  const prose = gapsProse(report);
  if (!prose) return null;
  return (
    <p
      data-report-gaps
      data-report-amber
      className="bg-apollo-amber-tint border-apollo-amber-tint-border m-0 rounded-[10px] border px-4 py-3 text-[14px] leading-[1.55] text-pretty text-[#5a3c05]"
    >
      <strong className="font-semibold">Gaps in this report.</strong> {prose}
    </p>
  );
}

/** "Coverage and fit": rank, name (to the profile section), Fit, one column per theme, Awards. */
function Coverage({ report }: { report: MatchaReport }) {
  if (report.pis.length === 0) return null;
  const themes = report.coverage ? (report.themes ?? []) : [];
  const coverage = report.coverage;
  const nTerms = report.searchTerms.length;
  const totalAwards = report.pis.reduce((s, pi) => s + pi.funding.length, 0);
  const cell = "px-2 py-1.5";
  return (
    <section data-report-coverage aria-label="Coverage and fit" className="flex flex-col gap-4">
      <H2
        sub={
          themes.length > 0
            ? `Investigators ranked by fit, against your ${nTerms} search ${plural(nTerms, "term", "terms")} grouped into ${numberWord(themes.length)} ${plural(themes.length, "theme", "themes")}. Names jump to each profile.`
            : "Investigators ranked by fit. Names jump to each profile."
        }
      >
        Coverage and fit
      </H2>
      <div
        data-report-coverage-scroll
        className="bg-apollo-surface border-apollo-border overflow-x-auto rounded-[var(--apollo-radius-card)] border"
      >
        <table
          data-report-coverage-table
          className={`w-full table-fixed border-collapse text-left ${themes.length > 0 ? "min-w-[820px]" : ""}`}
        >
          <colgroup>
            <col className="w-[230px] print:w-[27%]" />
            <col className="w-[72px]" />
            {themes.map((t) => (
              <col key={t.label} />
            ))}
            <col className="w-[64px]" />
          </colgroup>
          <thead>
            <tr className="bg-apollo-surface-2 border-apollo-border-strong border-b text-[11px] font-semibold text-[var(--evidence-body)]">
              <th scope="col" className="px-3 py-2 align-bottom font-semibold">
                Investigator
              </th>
              <th scope="col" className={`${cell} align-bottom font-semibold`}>
                Fit
              </th>
              {themes.map((t) => (
                <th
                  key={t.label}
                  scope="col"
                  className={`${cell} text-center align-bottom leading-[1.3] font-semibold`}
                >
                  {t.label}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right align-bottom font-semibold">
                Awards
              </th>
            </tr>
          </thead>
          <tbody>
            {report.pis.map((pi, i) => (
              <tr
                key={pi.cwid}
                data-report-coverage-row
                className="border-apollo-border border-b text-[13px]"
              >
                <th scope="row" className="px-3 py-1.5 font-normal">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-apollo-maroon w-4 flex-none text-[11px]">{pi.rank}</span>
                    <a
                      href={`#pi-${pi.rank}`}
                      className="text-apollo-slate hover:text-apollo-maroon font-semibold hover:underline"
                    >
                      {reportName(pi.name)}
                    </a>
                  </span>
                </th>
                <td className={cell}>
                  <FitPill fit={pi.fit} short />
                </td>
                {themes.map((t, j) => (
                  <td key={t.label} className={cell}>
                    <span className="flex justify-center">
                      <Mark mark={coverage!.rows[i].marks[j]} />
                    </span>
                  </td>
                ))}
                <td data-report-awards className="px-3 py-1.5 text-right tabular-nums">
                  {pi.funding.length > 0 ? pi.funding.length : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr
              data-report-totals
              className="bg-apollo-surface-2 text-[11px] text-[var(--evidence-faint)]"
            >
              <th scope="row" className="px-3 py-1.5 font-semibold">
                Investigators
              </th>
              <td className={cell} />
              {themes.map((t, j) => (
                <td key={t.label} className={`${cell} text-center`}>
                  {coverage!.totals[j]}
                </td>
              ))}
              <td data-report-awards-total className="px-3 py-1.5 text-right tabular-nums">
                {totalAwards}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-[var(--evidence-body)]">
        {themes.length > 0 ? (
          <>
            <div className="flex items-center gap-1.5">
              <Mark mark="primary" />
              Primary focus
            </div>
            <div className="flex items-center gap-1.5">
              <Mark mark="related" />
              Related work
            </div>
          </>
        ) : null}
        <div>Awards: active sponsored awards on record</div>
      </div>
    </section>
  );
}

function Empty() {
  return <p className="m-0 text-[14px] text-[var(--evidence-faint)] italic">{NOT_EVIDENT}</p>;
}

/** Funding lines on a Strong-fit profile before the "+N more" link. */
export const REPORT_MAX_FUNDING_ROWS = 3;
/** Method pills shown before "+N more" (and the only ones printed). */
export const REPORT_MAX_METHOD_PILLS = 6;
/** Key papers on a compact (Good / Weak fit) card. */
export const COMPACT_MAX_PAPERS = 2;

type Award = ReportPi["funding"][number];

/** One funding row: a single award, or `count` awards grouped by `groupFunding`. */
export type FundingRow = {
  mechanism: string | null;
  /** `awardCode`: the mechanism, else a funder-type label. */
  code: string;
  funder: string;
  /** `sponsorShort`: "NIDDK", never "… via …". */
  sponsor: string;
  title: string;
  endYear: number;
  /** Null on a grouped row: there is no single RePORTER page to link. */
  applId: number | null;
  count: number;
};

/** The title before its first colon, or null when there is none. */
function titleStem(title: string): string | null {
  const i = title.indexOf(":");
  const stem = i > 0 ? title.slice(0, i).trim() : "";
  return stem || null;
}

/**
 * Awards with the SAME mechanism, the SAME funder and an identical title stem (the text before a
 * colon) fold into one row, "Stem: rest A and rest B", ending at the latest end year. Deliberately
 * conservative: a title without a colon never groups. First-appearance order is kept.
 */
export function groupFunding(awards: readonly Award[]): FundingRow[] {
  const rows: (FundingRow & { stem: string | null; rests: string[] })[] = [];
  for (const a of awards) {
    const stem = titleStem(a.title);
    const rest = stem ? a.title.slice(a.title.indexOf(":") + 1).trim() : "";
    const hit = stem
      ? rows.find((r) => r.stem === stem && r.mechanism === a.mechanism && r.funder === a.funder)
      : undefined;
    if (hit) {
      hit.count += 1;
      hit.endYear = Math.max(hit.endYear, a.endYear);
      hit.applId = null;
      if (rest && !hit.rests.includes(rest)) hit.rests.push(rest);
      continue;
    }
    rows.push({
      mechanism: a.mechanism,
      code: awardCode(a),
      funder: a.funder,
      sponsor: sponsorShort(a),
      title: a.title,
      endYear: a.endYear,
      applId: a.applId,
      count: 1,
      stem,
      rests: rest ? [rest] : [],
    });
  }
  return rows.map(({ stem, rests, ...r }) => ({
    ...r,
    title: r.count > 1 && stem ? (rests.length ? `${stem}: ${joinWords(rests)}` : stem) : r.title,
  }));
}

/** A plain-text title cut to about `max` characters at a word boundary, with "…". */
export function clipTitle(title: string, max = 40): string {
  const t = htmlToPlainText(title, Number.POSITIVE_INFINITY)
    .trim()
    .replace(/[.\s]+$/, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,;:.–-]+$/, "")}…`;
}

/** The "Also:" label for a source that is not a numbered key paper. */
export function alsoLabel(s: BriefSource): string {
  if (s.kind === "grant") return briefSourceLabel(s);
  const title = clipTitle(s.title);
  return s.year != null ? `${s.year} · ${title}` : title;
}

/** A topic's sources split into key-paper citation numbers and the rest ("Also:"). */
export function topicCitations(
  sources: readonly BriefSource[],
  keyPapers: readonly ReportPaper[],
): { cites: number[]; also: BriefSource[] } {
  const cites: number[] = [];
  const also: BriefSource[] = [];
  for (const s of sources) {
    const n = s.kind === "pub" ? keyPapers.findIndex((p) => p.pmid === s.pmid) + 1 : 0;
    if (n > 0) {
      if (!cites.includes(n)) cites.push(n);
    } else {
      also.push(s);
    }
  }
  return { cites: cites.sort((a, b) => a - b), also };
}

function AlsoLine({ also }: { also: readonly BriefSource[] }) {
  if (also.length === 0) return null;
  return (
    <span data-report-also className="text-[12px] leading-[1.45] text-[var(--evidence-faint)]">
      Also:{" "}
      {also.map((s, j) => {
        const url = briefSourceUrl(s);
        const label = alsoLabel(s);
        return (
          <span key={j}>
            {j > 0 ? "; " : ""}
            {url ? (
              <ExtLink href={url} className="hover:text-apollo-maroon text-inherit hover:underline">
                {label}
              </ExtLink>
            ) : (
              label
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Topic text with its superscript key-paper cites, then the "Also:" line. */
function TopicBody({
  topic,
  keyPapers,
}: {
  topic: { text: string; sources: BriefSource[] };
  keyPapers: readonly ReportPaper[];
}) {
  const { cites, also } = topicCitations(topic.sources, keyPapers);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-pretty">
        {topic.text}
        {cites.length > 0 ? (
          <>
            {" "}
            <sup data-report-cite className="text-apollo-slate text-[10px] font-semibold">
              [{cites.join(", ")}]
            </sup>
          </>
        ) : null}
      </span>
      <AlsoLine also={also} />
    </div>
  );
}

/** Rank in WCM red, "Name ↗" to the Scholars profile, the fit pill on the right. */
function NameLine({ pi, size }: { pi: ReportPi; size: "lg" | "md" }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <h3
        className={`m-0 font-serif leading-[1.2] font-normal ${size === "lg" ? "text-[24px]" : "text-[20px]"}`}
      >
        <ExtLink
          href={pi.profileUrl}
          className="hover:text-apollo-maroon text-inherit no-underline hover:underline"
        >
          {reportName(pi.name)}
          <span className="text-apollo-slate text-[0.7em]"> ↗</span>
        </ExtLink>
      </h3>
      <span className="pt-1">
        <FitPill fit={pi.fit} />
      </span>
    </div>
  );
}

/** Partnership angle: a pale band with a red left border. `role`, when a brief carries one, is the
 *  bold lead-in; old briefs print the angle alone in regular weight. */
function AngleBand({ angle, role }: { angle: string; role?: string }) {
  return (
    <div
      data-report-angle
      className="bg-apollo-slate-tint border-apollo-maroon flex flex-col gap-1 border-l-[3px] px-4 py-3"
    >
      <SectionLabel>Partnership angle</SectionLabel>
      <p className="m-0 text-[15px] leading-[1.55] font-normal text-pretty">
        {role ? <strong className="font-semibold">{role} </strong> : null}
        {angle}
      </p>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <li
      data-report-pill
      className="bg-apollo-surface-2 border-apollo-border rounded-full border px-2.5 py-0.5 text-[12px] text-[var(--evidence-body)]"
    >
      {children}
    </li>
  );
}

/** One labelled pill row: the first `REPORT_MAX_METHOD_PILLS` shown (and printed), the rest
 *  behind a native "+N more" `<details>` that print hides. */
function PillRow({ label, items }: { label: string; items: readonly string[] }) {
  const shown = items.slice(0, REPORT_MAX_METHOD_PILLS);
  const rest = items.slice(REPORT_MAX_METHOD_PILLS);
  return (
    <div data-report-pill-row={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <span className="pt-0.5 text-[12px] text-[var(--evidence-faint)]">{label}</span>
      <div className="flex flex-col gap-1.5">
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {shown.map((m) => (
            <Pill key={m}>{m}</Pill>
          ))}
        </ul>
        {rest.length > 0 ? (
          <details data-report-more-methods>
            <summary className="text-apollo-slate w-fit cursor-pointer list-none text-[12px] font-semibold">
              +{rest.length} more
            </summary>
            <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-1.5 p-0">
              {rest.map((m) => (
                <Pill key={m}>{m}</Pill>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Methods and data": record-only pill rows (never generated), methods merged by normalized name
 * and ranked by paper count. One row today ("Methods"); a "Data sources" row slots in above it once
 * briefs label them. A clinical-trial count, when any, is a plain line.
 */
function MethodsAndData({
  pi,
}: {
  pi: Pick<ReportPi, "methods" | "trialCount"> & { brief: { dataSources: string[] } | null };
}) {
  const split = splitMethods(mergeMethods(pi.methods), pi.brief?.dataSources ?? []);
  const rows: { label: string; items: string[] }[] = [];
  if (split.dataSources.length > 0)
    rows.push({ label: "Data sources", items: split.dataSources.map((m) => m.name) });
  if (split.methods.length > 0)
    rows.push({ label: "Methods", items: split.methods.map((m) => m.name) });
  if (rows.length === 0 && pi.trialCount <= 0) return null;
  return (
    <div data-report-methods className="flex flex-col gap-2">
      <SectionLabel>Methods and data</SectionLabel>
      {rows.map((r) => (
        <PillRow key={r.label} label={r.label} items={r.items} />
      ))}
      {pi.trialCount > 0 ? (
        <p className="m-0 text-[13px] text-[var(--evidence-body)]">
          {pi.trialCount} clinical {plural(pi.trialCount, "trial", "trials")} on record
        </p>
      ) : null}
    </div>
  );
}

function TechBox({ pi }: { pi: ReportPi }) {
  if (pi.translation.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Licensable technology</SectionLabel>
      {pi.translation.map((t, i) => (
        <div
          key={i}
          data-report-tech
          className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate rounded-lg border px-3.5 py-2.5 text-[14px] leading-[1.45] font-semibold"
        >
          <ExtLink href={t.url} className="text-apollo-slate hover:underline">
            {t.title}
          </ExtLink>
          {t.patentStatus ? (
            <span className="font-normal text-[var(--evidence-body)]"> · {t.patentStatus}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Numbered key papers in a full-width grid: title clamped to two lines, year and PMID link. */
function PaperGrid({ papers }: { papers: readonly ReportPaper[] }) {
  if (papers.length === 0) return <Empty />;
  return (
    <ol
      data-report-papers
      className={`m-0 grid list-none grid-cols-1 gap-x-5 gap-y-3 p-0 ${papers.length >= 3 ? "sm:grid-cols-3 print:grid-cols-3" : "sm:grid-cols-2 print:grid-cols-2"}`}
    >
      {papers.map((paper, i) => (
        <li
          key={paper.pmid}
          data-report-paper={i + 1}
          className="border-apollo-border grid grid-cols-[22px_minmax(0,1fr)] gap-1 border-t pt-2"
        >
          <span className="text-apollo-slate text-[12px] leading-[1.4] font-semibold">
            [{i + 1}]
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <PubTitle value={paper.title} className="line-clamp-2 text-[13px] leading-[1.4]" />
            <span className="text-[12px] text-[var(--evidence-faint)]">
              {paper.year != null ? `${paper.year} · ` : ""}
              <ExtLink
                href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.pmid)}/`}
                className="text-apollo-slate hover:text-apollo-maroon hover:underline"
              >
                PMID {paper.pmid} ↗
              </ExtLink>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Up to three one-line grants (code, title, short sponsor, end year), then "+N more". Hidden by
 *  the caller when there are no awards. */
function FundingList({ pi }: { pi: ReportPi }) {
  const rows = groupFunding(pi.funding);
  const shown = rows.slice(0, REPORT_MAX_FUNDING_ROWS);
  const more = pi.funding.length - shown.reduce((s, r) => s + r.count, 0);
  // No mechanism on any award (e.g. all foundation grants) → drop the code column (#3291).
  const hasMechanism = pi.funding.some((a) => a.mechanism);
  return (
    <section data-report-funding aria-label="Active funding" className="flex flex-col gap-1.5">
      <SectionLabel>Active funding · {pi.funding.length}</SectionLabel>
      <div className="border-apollo-border flex flex-col border-t">
        {shown.map((g, i) => (
          <div
            key={i}
            data-report-funding-row
            className={`border-apollo-border grid ${hasMechanism ? "grid-cols-[56px_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"} items-baseline gap-3 border-b py-1.5 text-[13px] leading-[1.45]`}
          >
            {hasMechanism && (
              <span className="font-mono text-[11px] font-semibold text-[var(--evidence-body)]">
                {g.code}
              </span>
            )}
            <span className="min-w-0 text-pretty">
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
              {g.count > 1 ? ` (${g.count} awards)` : ""}
              <span className="text-[12px] text-[var(--evidence-faint)]"> · {g.sponsor}</span>
            </span>
            <span className="text-[12px] whitespace-nowrap text-[var(--evidence-faint)]">
              to {g.endYear}
            </span>
          </div>
        ))}
      </div>
      {more > 0 ? (
        <ExtLink
          href={pi.profileUrl}
          className="text-apollo-slate hover:text-apollo-maroon w-fit text-[12px] font-semibold hover:underline"
        >
          +{more} more on Scholars profile ↗
        </ExtLink>
      ) : null}
    </section>
  );
}

const cardChrome =
  "bg-apollo-surface border-apollo-border rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]";

/** A Strong-fit investigator: the full profile, one printed page. */
function StrongProfile({ pi }: { pi: ReportPi }) {
  const titleLine = [pi.title, pi.department].filter(Boolean).join(" · ");
  const metaLine = [...pi.centers, ...(pi.funding.length === 0 ? [NO_ACTIVE_FUNDING] : [])].join(
    " · ",
  );
  return (
    <article
      id={`pi-${pi.rank}`}
      data-report-pi="strong"
      data-report-cwid={pi.cwid}
      aria-label={`${pi.rank}. ${reportName(pi.name)}`}
      className={`${cardChrome} flex flex-col gap-5 px-5 py-6 sm:px-7`}
    >
      <header data-report-profile-header className="flex items-start gap-3 sm:gap-4">
        <div className="text-apollo-maroon w-7 flex-none font-serif text-[28px] leading-none">
          {pi.rank}
        </div>
        <Avatar pi={pi} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <NameLine pi={pi} size="lg" />
          {titleLine ? (
            <div className="text-[13px] text-[var(--evidence-body)]">{titleLine}</div>
          ) : null}
          {metaLine ? (
            <div data-report-meta className="text-[12px] text-[var(--evidence-faint)]">
              {metaLine}
            </div>
          ) : null}
        </div>
      </header>

      {pi.brief?.angle ? <AngleBand angle={pi.brief.angle} role={pi.brief.angleRole} /> : null}

      {pi.brief ? (
        <>
          <div className="flex max-w-[820px] flex-col gap-1.5">
            <SectionLabel>Why this investigator</SectionLabel>
            {pi.brief.why.trim() ? (
              <p className="m-0 text-[15px] leading-[1.6] text-pretty">{pi.brief.why}</p>
            ) : (
              <Empty />
            )}
          </div>
          <div className="flex max-w-[820px] flex-col gap-2">
            <SectionLabel>Suggested discussion topics</SectionLabel>
            {pi.brief.topics.length > 0 ? (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {pi.brief.topics.map((t, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[15px] leading-normal"
                  >
                    <span className="text-apollo-slate font-semibold">{i + 1}</span>
                    <TopicBody topic={t} keyPapers={pi.keyPapers} />
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

      <MethodsAndData pi={pi} />
      <TechBox pi={pi} />

      <div className="flex flex-col gap-2">
        <SectionLabel>Key papers</SectionLabel>
        <PaperGrid papers={pi.keyPapers} />
      </div>

      {pi.funding.length > 0 ? <FundingList pi={pi} /> : null}
    </article>
  );
}

function InlineLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--evidence-faint)] uppercase">
      {children}
    </span>
  );
}

/** A Good- or Weak-fit investigator: a compact card, two per printed page. */
function CompactProfile({ pi }: { pi: ReportPi }) {
  const titleLine = [pi.title, pi.department].filter(Boolean).join(" · ");
  const topic = pi.brief?.topics[0];
  const tech = pi.translation[0];
  return (
    <article
      id={`pi-${pi.rank}`}
      data-report-pi={pi.fit}
      data-report-compact
      data-report-cwid={pi.cwid}
      aria-label={`${pi.rank}. ${reportName(pi.name)}`}
      className={`${cardChrome} flex flex-col gap-3 px-5 py-5 sm:px-6`}
    >
      <header data-report-profile-header className="flex items-start gap-3">
        <div className="text-apollo-maroon w-7 flex-none font-serif text-[22px] leading-none">
          {pi.rank}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <NameLine pi={pi} size="md" />
          {titleLine ? (
            <div className="text-[13px] text-[var(--evidence-body)]">{titleLine}</div>
          ) : null}
        </div>
      </header>

      {pi.brief?.why.trim() ? (
        <p data-report-why className="m-0 text-[14px] leading-[1.55] text-pretty">
          {firstSentences(pi.brief.why, 2)}
        </p>
      ) : (
        <p className="m-0 text-[14px] text-[var(--evidence-faint)] italic" data-report-no-brief>
          {NO_BRIEF}
        </p>
      )}

      {topic ? (
        <div data-report-discuss className="flex gap-0 text-[14px] leading-normal">
          <div>
            <InlineLabel>Discuss</InlineLabel>
          </div>
          <TopicBody topic={topic} keyPapers={pi.keyPapers} />
        </div>
      ) : null}

      {tech ? (
        <div data-report-tech-line className="truncate text-[13px]">
          <InlineLabel>Technology</InlineLabel>
          <ExtLink
            href={tech.url}
            className="text-apollo-slate hover:text-apollo-maroon font-semibold hover:underline"
          >
            {tech.title}
          </ExtLink>
          {pi.translation.length > 1 ? (
            <span className="text-[var(--evidence-faint)]"> +{pi.translation.length - 1} more</span>
          ) : null}
        </div>
      ) : null}

      <PaperGrid papers={pi.keyPapers.slice(0, COMPACT_MAX_PAPERS)} />

      <div
        data-report-funding-summary
        className="border-apollo-border border-t pt-2 text-[13px] text-[var(--evidence-body)]"
      >
        <InlineLabel>Funding</InlineLabel>
        {pi.funding.length > 0 ? fundingSummary(pi.funding) : NO_FUNDING}
      </div>
    </article>
  );
}

const TIER_SUB: Record<MatchaFitTier, string> = {
  strong: "Full profiles, in rank order.",
  good: "Short profiles. Full publication and funding detail is on each Scholars profile.",
  weak: "Short profiles. Full publication and funding detail is on each Scholars profile.",
};

function Tier({ fit, pis }: { fit: MatchaFitTier; pis: readonly ReportPi[] }) {
  if (pis.length === 0) return null;
  return (
    <section data-report-tier={fit} aria-label={FIT_LABEL[fit]} className="flex flex-col gap-5">
      <H2 sub={TIER_SUB[fit]}>
        {FIT_LABEL[fit]} · {pis.length}
      </H2>
      <div className="flex flex-col gap-5">
        {pis.map((pi) =>
          fit === "strong" ? (
            <StrongProfile key={pi.cwid} pi={pi} />
          ) : (
            <CompactProfile key={pi.cwid} pi={pi} />
          ),
        )}
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] text-[var(--evidence-faint)]">{label}</span>
      <span className="font-semibold">{children}</span>
    </div>
  );
}

export function MatchaReportView({ report }: { report: MatchaReport }) {
  const footer = reportFooterText(report.generatedAt);
  const nTerms = report.searchTerms.length;
  return (
    <main
      data-matcha-report
      className="bg-apollo-page min-h-screen font-sans text-[#1a1a1a] antialiased"
    >
      <style dangerouslySetInnerHTML={{ __html: printCss() }} />
      <div data-report-bar className="border-apollo-border border-b bg-white">
        <div className="mx-auto flex max-w-[1040px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5 text-[13px] sm:px-8">
          {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG; must print. */}
          <img src={WCM_LOGO_SRC} alt="Weill Cornell Medicine" className="h-7 w-auto" />
          <div className="text-[var(--evidence-faint)]">
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

        <header data-report-cover className="flex flex-col gap-5">
          <div className="text-apollo-maroon text-[12px] font-semibold tracking-[0.08em] uppercase">
            Matcha scouting report
          </div>
          <h1
            data-report-title
            className="m-0 font-serif text-[32px] leading-[1.12] font-normal tracking-[-0.01em] text-balance sm:text-[40px]"
          >
            {titleWithoutRequester(report.title, report.requester)}
          </h1>
          <p className="m-0 max-w-[720px] text-[16px] leading-[1.55] text-pretty text-[var(--evidence-body)]">
            {reportSubtitle(report.pis.length)}
          </p>
          <div className="border-apollo-border-strong flex flex-col gap-4 border-t pt-4 text-[14px]">
            <div className="flex flex-wrap gap-x-10 gap-y-3">
              {report.requester ? (
                <div data-slot="matcha-report-prepared-for">
                  <Detail label="Prepared for">{report.requester}</Detail>
                </div>
              ) : null}
              <Detail label="Prepared by">
                {report.officer.name}
                {report.officer.dept ? `, ${report.officer.dept}` : ""}
              </Detail>
              {report.officer.email ? (
                <Detail label="Contact">
                  <a
                    href={`mailto:${report.officer.email}`}
                    className="text-apollo-slate hover:text-apollo-maroon hover:underline"
                  >
                    {report.officer.email}
                  </a>
                </Detail>
              ) : null}
              <Detail label="Source">
                Matcha, using Weill Cornell Scholars data as of {shortDate(report.generatedAt)}
              </Detail>
            </div>
            {nTerms > 0 ? (
              <div data-report-search-terms className="flex flex-col gap-0.5">
                <span className="text-[12px] text-[var(--evidence-faint)]">
                  Search terms ({nTerms})
                </span>
                <span className="text-[13px] leading-[1.55] text-pretty text-[var(--evidence-body)]">
                  {report.searchTerms.join(", ")}
                </span>
              </div>
            ) : null}
          </div>
        </header>

        <div className="flex flex-col gap-4">
          <StatLine report={report} />
          <Gaps report={report} />
        </div>

        <Coverage report={report} />

        {report.pis.length > 0 ? (
          TIER_ORDER.map((fit) => (
            <Tier key={fit} fit={fit} pis={report.pis.filter((pi) => pi.fit === fit)} />
          ))
        ) : (
          <p className="text-[var(--evidence-faint)]">No researchers selected.</p>
        )}

        <footer
          data-report-footer
          className="border-apollo-border-strong border-t pt-4 text-[12px] leading-[1.6] text-[var(--evidence-faint)]"
        >
          <p data-report-footer-text className="m-0 text-pretty">
            {footer}
          </p>
        </footer>
      </div>
    </main>
  );
}
