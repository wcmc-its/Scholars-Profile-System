/**
 * `/edit/research-security` — the dashboard body: caution, filters, headline
 * tiles, the five views and the Methods section. A plain server component: the
 * URL is the only state (a GET form and links), every row is already filtered
 * and paginated by the page, and nothing here ships to the client as data.
 *
 * Chrome (cards, tables, hand-drawn bars) follows
 * `components/edit/data-sharing-dashboard.tsx`; no chart library.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  articleLink,
  attributionReason,
  isoDay,
  type ArticleFact,
  type EntityRow,
  type FundingRow,
  type MatchedString,
  type PaperRow,
  type PersonRow,
  type ResearchSecuritySummary,
  type UnattributedRow,
} from "@/lib/api/research-security-report";
import {
  CAMPUS_FILTERS,
  CAMPUS_LABEL,
  CONSORTIUM_AUTHORS,
  LIST_FILTERS,
  LIST_FILTER_LABEL,
  RESEARCH_SECURITY_VIEWS,
  VIEW_LABEL,
  campusName,
  filterSummary,
  researchSecurityQuery,
  type ResearchSecurityUiParams,
  type ResearchSecurityView,
} from "@/lib/edit/research-security-dashboard";
import type { ResearchSecurityMethodsDoc } from "@/lib/edit/research-security-methods-doc";
import { cn } from "@/lib/utils";

const cardClass = "border-apollo-border-strong bg-apollo-surface rounded-[13px] border";
const tableWrapClass = `${cardClass} overflow-x-auto`;
const theadClass =
  "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground border-b text-left text-[11.5px] font-medium tracking-[.06em] uppercase";
const thClass = "px-3 py-2.5 font-medium first:pl-[18px] last:pr-[18px]";
const tdClass = "px-3 py-2 align-top first:pl-[18px] last:pr-[18px]";
const rowClass = "border-apollo-border hover:bg-apollo-page border-t first:border-t-0";
const numClass = "text-right tabular-nums";
const inputClass =
  "border-apollo-border-strong bg-apollo-surface h-8 rounded-md border px-2 text-[13px]";

export type ResearchSecurityViewRows =
  | { view: "entity"; rows: EntityRow[] }
  | { view: "person"; rows: PersonRow[] }
  | { view: "paper"; rows: PaperRow[]; matchedStrings: MatchedString[] }
  | { view: "funding"; rows: FundingRow[] }
  | { view: "unattributed"; rows: UnattributedRow[] };

export type ResearchSecurityDashboardProps = {
  ui: ResearchSecurityUiParams;
  summary: ResearchSecuritySummary;
  /** Rows per view under the current filters, for the tab labels. */
  tabCounts: Record<ResearchSecurityView, number>;
  /** One page of the selected view. */
  current: ResearchSecurityViewRows;
  page: number;
  totalPages: number;
  categories: string[];
  dataAsOf: Date | null;
  methods: ResearchSecurityMethodsDoc;
};

const BASE = "/edit/research-security";

function Kpi({ label, value, sub }: { label: string; value: number; sub: ReactNode }) {
  return (
    <div className={cn(cardClass, "flex flex-col gap-[3px] px-4 py-3.5")}>
      <span className="text-muted-foreground text-xs font-medium tracking-[.08em] uppercase">
        {label}
      </span>
      <span className="text-[28px] leading-tight font-semibold tracking-[-.01em] tabular-nums">
        {value.toLocaleString("en-US")}
      </span>
      <span className="text-muted-foreground text-[12.5px] leading-snug">{sub}</span>
    </div>
  );
}

/** A count with a bar against the largest value in the column. */
function BarCell({ value, max }: { value: number; max: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="bg-apollo-surface-2 hidden h-2 w-24 overflow-hidden rounded-full sm:block">
        {value > 0 && (
          <div
            className="bg-apollo-slate h-full rounded-full"
            style={{ width: `${(value / Math.max(1, max)) * 100}%` }}
          />
        )}
      </div>
      <span className="w-12 text-right font-semibold tabular-nums">
        {value.toLocaleString("en-US")}
      </span>
    </div>
  );
}

function ArticleCell({ article }: { article: ArticleFact }) {
  const href = articleLink(article);
  return (
    <div className="flex max-w-[52ch] flex-col gap-0.5">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-apollo-slate font-medium hover:underline"
        >
          {article.title ?? article.articleId}
        </a>
      ) : (
        <span className="font-medium">{article.title ?? article.articleId}</span>
      )}
      <span className="text-muted-foreground text-[12.5px]">
        {[article.journal, isoDay(article.publicationDate), article.publicationType]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="text-muted-foreground text-[12.5px]">
        {article.totalAuthors > 0
          ? `${article.totalAuthors.toLocaleString("en-US")} authors`
          : "Author count unknown"}
        {article.totalAuthors >= CONSORTIUM_AUTHORS ? " · large consortium" : ""}
        {` · ${article.pmid ? `PMID ${article.pmid}` : article.articleId}`}
      </span>
    </div>
  );
}

function FilterBar({ ui, categories }: { ui: ResearchSecurityUiParams; categories: string[] }) {
  const f = ui.filters;
  return (
    <form
      method="get"
      action={BASE}
      className={cn(cardClass, "flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3.5")}
    >
      <input type="hidden" name="view" value={ui.view} />
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">Campus</span>
        <select name="campus" defaultValue={f.campus} className={inputClass}>
          {CAMPUS_FILTERS.map((c) => (
            <option key={c} value={c}>
              {c === "both" ? "WCM and Cornell University" : CAMPUS_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">List</span>
        <select name="list" defaultValue={f.list} className={inputClass}>
          {LIST_FILTERS.map((l) => (
            <option key={l} value={l}>
              {LIST_FILTER_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">Category</span>
        <select
          name="category"
          defaultValue={f.category ?? ""}
          className={inputClass}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">Published from</span>
        <input type="date" name="from" defaultValue={f.dateFrom} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">to</span>
        <input type="date" name="to" defaultValue={f.dateTo ?? ""} className={inputClass} />
      </label>
      <label className="flex h-8 items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          name="consortia"
          value="exclude"
          defaultChecked={f.excludeConsortia}
        />
        Exclude {CONSORTIUM_AUTHORS}+ author consortia
      </label>
      <button
        type="submit"
        className="bg-apollo-slate h-8 rounded-md px-3 text-[13px] font-medium text-white"
      >
        Apply
      </button>
      <Link
        href={`${BASE}${ui.view === "entity" ? "" : `?view=${ui.view}`}`}
        className="text-apollo-slate text-[13px] hover:underline"
      >
        Clear filters
      </Link>
    </form>
  );
}

function Tabs({
  ui,
  tabCounts,
}: {
  ui: ResearchSecurityUiParams;
  tabCounts: Record<ResearchSecurityView, number>;
}) {
  return (
    <nav aria-label="Views" className="border-apollo-border-strong flex flex-wrap gap-1 border-b">
      {RESEARCH_SECURITY_VIEWS.map((v) => (
        <Link
          key={v}
          href={`${BASE}${researchSecurityQuery({ view: v, filters: ui.filters })}`}
          aria-current={v === ui.view ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-[13.5px]",
            v === ui.view
              ? "border-apollo-slate font-semibold"
              : "text-muted-foreground border-transparent hover:underline",
          )}
        >
          {VIEW_LABEL[v]}{" "}
          <span className="text-muted-foreground tabular-nums">
            {tabCounts[v].toLocaleString("en-US")}
          </span>
        </Link>
      ))}
    </nav>
  );
}

function Pager({
  ui,
  page,
  totalPages,
}: {
  ui: ResearchSecurityUiParams;
  page: number;
  totalPages: number;
}) {
  const href = (p: number) =>
    `${BASE}${researchSecurityQuery({ view: ui.view, filters: ui.filters, page: p })}`;
  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 px-1 text-[13px]">
      <span>
        Page {page} of {totalPages}
      </span>
      <span className="flex gap-4">
        {page > 1 && (
          <Link href={href(page - 1)} className="text-apollo-slate hover:underline">
            ← Previous
          </Link>
        )}
        {page < totalPages && (
          <Link href={href(page + 1)} className="text-apollo-slate hover:underline">
            Next →
          </Link>
        )}
      </span>
    </div>
  );
}

function Empty({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="text-muted-foreground px-[18px] py-6 text-center text-[13.5px]">
        Nothing matches these filters.
      </td>
    </tr>
  );
}

function EntityTable({ rows }: { rows: EntityRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.papers));
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Entity</th>
          <th className={thClass}>Category</th>
          <th className={cn(thClass, "text-right")}>Co-publications</th>
          <th className={cn(thClass, "text-right")}>WCM</th>
          <th className={cn(thClass, "text-right")}>Cornell</th>
          <th className={cn(thClass, "text-right")}>Excl. {CONSORTIUM_AUTHORS}+</th>
          <th className={cn(thClass, "text-right")}>Our authors</th>
          <th className={cn(thClass, "text-right")}>Our author lists entity</th>
          <th className={cn(thClass, "text-right")}>Not yet attributed</th>
          <th className={cn(thClass, "text-right")}>Priority 1–2</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={10} />}
        {rows.map((r) => (
          <tr key={`${r.listCode}|${r.entity}`} className={rowClass}>
            <td className={cn(tdClass, "font-medium")}>
              {r.entity}
              {r.listNo != null && (
                <span className="text-muted-foreground font-normal"> · no. {r.listNo}</span>
              )}
            </td>
            <td className={cn(tdClass, "text-muted-foreground text-[13px]")}>{r.category}</td>
            <td className={tdClass}>
              <BarCell value={r.papers} max={max} />
            </td>
            <td className={cn(tdClass, numClass)}>{r.papersWcm.toLocaleString("en-US")}</td>
            <td className={cn(tdClass, numClass)}>{r.papersIthaca.toLocaleString("en-US")}</td>
            <td className={cn(tdClass, numClass)}>
              {r.papersExcludingConsortia.toLocaleString("en-US")}
            </td>
            <td className={cn(tdClass, numClass)}>{r.people.toLocaleString("en-US")}</td>
            <td className={cn(tdClass, numClass)}>
              {r.papersOurAuthorListsEntity.toLocaleString("en-US")}
            </td>
            <td className={cn(tdClass, numClass, "text-muted-foreground")}>
              {r.unattributedPapers.toLocaleString("en-US")}
            </td>
            <td className={cn(tdClass, numClass, "text-muted-foreground")}>
              {r.unattributedPriority12.toLocaleString("en-US")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PersonTable({ rows }: { rows: PersonRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.papers));
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Person</th>
          <th className={thClass}>Campus</th>
          <th className={thClass}>Department</th>
          <th className={cn(thClass, "text-right")}>Co-publications</th>
          <th className={cn(thClass, "text-right")}>Excl. {CONSORTIUM_AUTHORS}+</th>
          <th className={thClass}>Entities</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={6} />}
        {rows.map((r) => (
          <tr key={r.cwid ?? r.name} className={rowClass}>
            <td className={tdClass}>
              <span className="font-medium">{r.name}</span>
              {r.cwid && <span className="text-muted-foreground"> ({r.cwid})</span>}
              {r.title && <div className="text-muted-foreground text-[12.5px]">{r.title}</div>}
            </td>
            <td className={cn(tdClass, "text-[13px]")}>{campusName(r.campus)}</td>
            <td className={cn(tdClass, "text-muted-foreground text-[13px]")}>
              {r.department ?? "—"}
            </td>
            <td className={tdClass}>
              <BarCell value={r.papers} max={max} />
            </td>
            <td className={cn(tdClass, numClass)}>
              {r.papersExcludingConsortia.toLocaleString("en-US")}
            </td>
            <td className={cn(tdClass, "max-w-[44ch] text-[13px]")}>{r.entities.join("; ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PaperTable({ rows, matchedStrings }: { rows: PaperRow[]; matchedStrings: MatchedString[] }) {
  const strings = new Map<string, MatchedString[]>();
  for (const m of matchedStrings) strings.set(m.articleId, [...(strings.get(m.articleId) ?? []), m]);
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Paper</th>
          <th className={thClass}>Our authors (confirmed)</th>
          <th className={thClass}>Listed entities and matched strings</th>
          <th className={thClass}>Flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={4} />}
        {rows.map((r) => {
          const mine = strings.get(r.article.articleId) ?? [];
          return (
            <tr key={r.article.articleId} className={rowClass}>
              <td className={tdClass}>
                <ArticleCell article={r.article} />
              </td>
              <td className={cn(tdClass, "max-w-[30ch] text-[13px]")}>
                {r.wcmAuthors.length > 0 && <div>WCM: {r.wcmAuthors.join("; ")}</div>}
                {r.ithacaAuthors.length > 0 && <div>Cornell: {r.ithacaAuthors.join("; ")}</div>}
              </td>
              <td className={cn(tdClass, "max-w-[52ch] text-[13px]")}>
                <div>{r.entities.join("; ")}</div>
                <details className="mt-1">
                  <summary className="text-apollo-slate cursor-pointer">
                    {mine.length.toLocaleString("en-US")} matched{" "}
                    {mine.length === 1 ? "string" : "strings"} ·{" "}
                    {r.coAuthorsAtEntities.toLocaleString("en-US")}{" "}
                    {r.coAuthorsAtEntities === 1 ? "co-author" : "co-authors"}
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {mine.map((m, i) => (
                      <li key={i} className="border-apollo-border border-l-2 pl-2">
                        <span className="font-medium">{m.authorName ?? "Unnamed author"}</span>
                        {m.isInstitutionAuthor && (
                          <span className="text-apollo-amber"> · has one of our authors&apos; names</span>
                        )}
                        <span className="text-muted-foreground"> · {m.entity}</span>
                        <div className="text-apollo-ink-2 break-words">{m.affiliation ?? "—"}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              </td>
              <td className={cn(tdClass, "text-[12.5px]")}>
                {r.ourAuthorListsEntity && (
                  <div className="text-apollo-amber">Our author may list the entity</div>
                )}
                {r.fundingPrograms.map((p) => (
                  <div key={p}>Funding: {p}</div>
                ))}
                {r.consortium && <div className="text-muted-foreground">Large consortium</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FundingTable({ rows }: { rows: FundingRow[] }) {
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Paper</th>
          <th className={thClass}>Program flagged</th>
          <th className={thClass}>Grant agency</th>
          <th className={thClass}>Grant ID</th>
          <th className={thClass}>Our authors (confirmed)</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={5} />}
        {rows.map((r) => (
          <tr key={`${r.article.articleId}|${r.program}`} className={rowClass}>
            <td className={tdClass}>
              <ArticleCell article={r.article} />
            </td>
            <td className={cn(tdClass, "font-medium")}>{r.program}</td>
            <td className={cn(tdClass, "max-w-[30ch] text-[13px]")}>{r.agency ?? "—"}</td>
            <td className={cn(tdClass, "text-[13px]")}>{r.grantId ?? "—"}</td>
            <td className={cn(tdClass, "max-w-[30ch] text-[13px]")}>
              {r.wcmAuthors.length > 0 && <div>WCM: {r.wcmAuthors.join("; ")}</div>}
              {r.ithacaAuthors.length > 0 && <div>Cornell: {r.ithacaAuthors.join("; ")}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PRIORITY_MEANING: Record<number, string> = {
  1: "Candidate also lists the entity (often a namesake): verify",
  2: "Likely ours: score 90+ or review-queue row",
  3: "Score under 90",
  4: `${CONSORTIUM_AUTHORS}+ author consortium`,
};

function UnattributedTable({ rows }: { rows: UnattributedRow[] }) {
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Priority</th>
          <th className={thClass}>Candidate</th>
          <th className={thClass}>Why unattributed</th>
          <th className={cn(thClass, "text-right")}>ReCiter score</th>
          <th className={thClass}>Paper</th>
          <th className={thClass}>Listed entities</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={6} />}
        {rows.map((r, i) => (
          <tr key={`${r.article.articleId}|${r.person.cwid ?? r.person.displayName}|${i}`} className={rowClass}>
            <td className={tdClass} title={PRIORITY_MEANING[r.priority]}>
              <span className="font-semibold tabular-nums">{r.priority}</span>
              {r.alreadyConfirmed && (
                <div className="text-muted-foreground text-[12px]">
                  Already confirmed for another author; not counted
                </div>
              )}
            </td>
            <td className={tdClass}>
              <span className="font-medium">{r.person.displayName}</span>
              {r.person.cwid && <span className="text-muted-foreground"> ({r.person.cwid})</span>}
              <div className="text-muted-foreground text-[12.5px]">
                {[campusName(r.person.campus), r.person.department].filter(Boolean).join(" · ")}
              </div>
              {r.candidateListsEntity && (
                <div className="text-apollo-amber text-[12.5px]">Candidate also lists the entity</div>
              )}
            </td>
            <td className={cn(tdClass, "text-[13px]")}>
              {attributionReason(r.person)}
            </td>
            <td className={cn(tdClass, numClass)}>
              {r.person.reciterScore == null ? "—" : r.person.reciterScore.toFixed(1)}
            </td>
            <td className={tdClass}>
              <ArticleCell article={r.article} />
            </td>
            <td className={cn(tdClass, "max-w-[36ch] text-[13px]")}>{r.entities.join("; ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const VIEW_NOTE: Record<ResearchSecurityView, string> = {
  entity:
    "Confirmed co-publications per listed entity. The two right-hand columns are the not-yet-attributed tier and are not part of any confirmed count.",
  person: "Our people with a confirmed co-publication. Confirmed authorships only.",
  paper:
    "Confirmed co-publications, newest first. Open a row's matched strings to read the exact co-author and affiliation text.",
  funding:
    "Papers with a confirmed author whose grant metadata names the China Scholarship Council or a talent program. Paper-level: it does not say which author held the award. The list and category filters do not apply.",
  unattributed:
    "Suggestions nobody has reviewed and open review-queue rows. Never part of a confirmed count. A paper already confirmed for another of our authors is marked and not counted.",
};

function MethodsSection({ doc }: { doc: ResearchSecurityMethodsDoc }) {
  return (
    <section id="methods" className="flex scroll-mt-32 flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">Methods &amp; assumptions</h2>
        {/* Plain <a>: the target is a download route handler. */}
        <a
          href={`${BASE}/export?section=methods`}
          className="text-apollo-slate ml-auto text-[13px] hover:underline"
        >
          Download methods
        </a>
      </div>
      <div
        className={cn(
          cardClass,
          "grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-4 px-4 py-[18px] sm:px-[22px]",
        )}
      >
        {doc.sections.map((s) => (
          <div key={s.heading} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{s.heading}</h3>
            {s.body.split("\n").map((line, i) => (
              <p key={i} className="text-apollo-ink-2 text-[13.5px] leading-relaxed">
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResearchSecurityDashboard({
  ui,
  summary,
  tabCounts,
  current,
  page,
  totalPages,
  categories,
  dataAsOf,
  methods,
}: ResearchSecurityDashboardProps) {
  const f = ui.filters;
  const noun = summary.tier === "country" ? "Country-of-concern" : "Listed-entity";
  const exportHref = `${BASE}/export${researchSecurityQuery({ view: ui.view, filters: f })}`;
  return (
    <div className="flex flex-col gap-6">
      <p
        role="note"
        className="border-apollo-amber bg-apollo-surface rounded-[13px] border px-4 py-3 text-[14px] leading-normal"
      >
        <strong>{methods.notice}</strong>{" "}
        <a href="#methods" className="text-apollo-slate hover:underline">
          Methods &amp; assumptions
        </a>
      </p>

      <FilterBar ui={ui} categories={categories} />

      {dataAsOf === null ? (
        <p className={cn(cardClass, "text-muted-foreground px-4 py-6 text-center text-[14px]")}>
          No data has been loaded yet. The nightly research-security step fills this page.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
            <Kpi
              label={`${noun} co-publications`}
              value={summary.coPublications}
              sub={`Confirmed authorships · ${summary.coPublicationsExcludingConsortia.toLocaleString("en-US")} excluding ${CONSORTIUM_AUTHORS}+ author consortia`}
            />
            <Kpi label="Our authors" value={summary.people} sub="Distinct confirmed WCM and Cornell people" />
            <Kpi
              label={summary.tier === "country" ? "Countries" : "Entities"}
              value={summary.entities}
              sub="With at least one confirmed co-publication"
            />
            <Kpi
              label="Funding-flag papers"
              value={summary.fundingFlagPapers}
              sub="CSC or a talent program in grant metadata"
            />
            <Kpi
              label="Not yet attributed"
              value={summary.unattributedPapers}
              sub="Papers awaiting review · not in any confirmed count"
            />
          </div>
          <p className="text-muted-foreground -mt-3 text-[12.5px]">
            {filterSummary(f).join(" · ")} · data as of {isoDay(dataAsOf)}
            {summary.tier === "entity"
              ? " · country-of-concern matches are a separate tier and are not in these counts; select that list to see them"
              : " · a far wider net than the entity lists; never added to an entity total"}
          </p>

          <section className="flex flex-col gap-3">
            <Tabs ui={ui} tabCounts={tabCounts} />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-muted-foreground max-w-[90ch] text-[13px]">{VIEW_NOTE[ui.view]}</p>
              {/* Plain <a>: the target is a download route handler. */}
              <a href={exportHref} className="text-apollo-slate ml-auto text-[13px] hover:underline">
                Download this view (.xlsx)
              </a>
            </div>
            <div className={tableWrapClass}>
              {current.view === "entity" && <EntityTable rows={current.rows} />}
              {current.view === "person" && <PersonTable rows={current.rows} />}
              {current.view === "paper" && (
                <PaperTable rows={current.rows} matchedStrings={current.matchedStrings} />
              )}
              {current.view === "funding" && <FundingTable rows={current.rows} />}
              {current.view === "unattributed" && <UnattributedTable rows={current.rows} />}
            </div>
            <Pager ui={ui} page={page} totalPages={totalPages} />
          </section>
        </>
      )}

      <MethodsSection doc={methods} />
    </div>
  );
}
