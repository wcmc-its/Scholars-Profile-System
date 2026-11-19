/**
 * `/edit/research-security` — the dashboard body: caution, filters, headline
 * tiles, the five views and the Methods section. A plain server component: the
 * URL is the only state (a GET form and links), every row is already filtered
 * and paginated by the page, and nothing here ships to the client as data.
 *
 * Drill-down is links only: an entity, a person or a count links to another
 * view with the `entity` / `person` filter set (`linkTo`).
 *
 * Colour carries three meanings and no others: slate = confirmed counts,
 * links and the screening notice; amber = waiting on a person's judgment (the
 * not-yet-attributed tier, "verify" flags); maroon / slate chips = campus.
 *
 * Chrome (cards, tables, hand-drawn bars) follows
 * `components/edit/data-sharing-dashboard.tsx`; no chart library.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  METHODS_PEOPLE_CAP as METHODS_PEOPLE_LIMIT,
  type InferredMethods,
} from "@/lib/api/research-security-methods";
import {
  articleLink,
  attributionReason,
  isoDay,
  type ArticleFact,
  type EntityProfile,
  type EntityRow,
  type FundingRow,
  type MatchedString,
  type PaperRow,
  type PersonProfile,
  type PersonRow,
  type ResearchSecuritySummary,
  type UnattributedGroup,
  type UnattributedRow,
} from "@/lib/api/research-security-report";
import {
  CAMPUS_FILTERS,
  CAMPUS_LABEL,
  CONSORTIUM_AUTHORS,
  LIST_COUNTRY,
  LIST_FILTERS,
  LIST_FILTER_DESCRIPTION,
  LIST_FILTER_LABEL,
  RESEARCH_SECURITY_VIEWS,
  SORT_KEYS,
  VIEW_LABEL,
  campusName,
  defaultSortDir,
  filterChips,
  researchSecurityQuery,
  type ListFilter,
  type ResearchSecurityFilters,
  type ResearchSecurityUiParams,
  type ResearchSecurityView,
} from "@/lib/edit/research-security-dashboard";
import type { ResearchSecurityMethodsDoc } from "@/lib/edit/research-security-methods-doc";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";
import { cn } from "@/lib/utils";

import { MethodsDisclosure } from "./research-security-methods";

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
  /** `groups` (one row per candidate) is shown when present; `rows` (one per
   *  candidate and paper) when a single person is selected. */
  | { view: "unattributed"; rows: UnattributedRow[]; groups?: UnattributedGroup[] };

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
  /** The entities (countries, in the country tier) the entity filter offers. */
  entities: string[];
  /** The person of the person filter, when they are on a paper in scope. */
  profile?: PersonProfile | null;
  /** Where else this person has a record; absent when they have none. */
  profileLinks?: { console: string; publicProfile?: string };
  /** The entity of the entity filter, when it has a match in scope. */
  entityProfile?: EntityProfile | null;
  /** Its most common matched affiliation strings (entity lists only). */
  entityAffiliations?: Array<{ affiliation: string; papers: number }>;
  /** Methods and tools inferred from each card's confirmed papers; null when
   *  the methods data is off or there is nothing to look in. */
  personMethods?: InferredMethods | null;
  entityMethods?: InferredMethods | null;
  /** Rows of the selected view after the search, and before it. */
  viewShown?: number;
  viewTotal?: number;
  dataAsOf: Date | null;
  methods: ResearchSecurityMethodsDoc;
};

const BASE = "/edit/research-security";

/** A link to a view under the current filters with some of them replaced. */
type LinkTo = (view: ResearchSecurityView, over?: Partial<ResearchSecurityFilters>) => string;

function linkBuilder(f: ResearchSecurityFilters): LinkTo {
  return (view, over = {}) => `${BASE}${researchSecurityQuery({ view, filters: { ...f, ...over } })}`;
}

const linkClass = "text-apollo-slate hover:underline";
const chipBase =
  "inline-flex items-center rounded-full border px-2 py-px text-[12px] leading-[1.5] whitespace-nowrap";
const CHIP_TONE = {
  neutral: "bg-apollo-surface-2 border-apollo-border-strong text-apollo-ink-2",
  slate: "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate",
  amber: "bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber",
  maroon: "bg-apollo-red-tint border-apollo-red-tint-border text-apollo-maroon",
} as const;

function Chip({
  tone = "neutral",
  href,
  title,
  children,
}: {
  tone?: keyof typeof CHIP_TONE;
  href?: string;
  title?: string;
  children: ReactNode;
}) {
  const className = cn(chipBase, CHIP_TONE[tone], href && "hover:underline");
  return href ? (
    <Link href={href} title={title} className={className}>
      {children}
    </Link>
  ) : (
    <span title={title} className={className}>
      {children}
    </span>
  );
}

function CampusChip({ campus }: { campus: string }) {
  if (campus === "wcm") return <Chip tone="maroon" title={CAMPUS_LABEL.wcm}>WCM</Chip>;
  if (campus === "ithaca") return <Chip tone="slate" title={CAMPUS_LABEL.ithaca}>Cornell</Chip>;
  return <Chip>{campusName(campus)}</Chip>;
}

/** Entities as chips; each one narrows `view` to that entity. */
function EntityChips({
  entities,
  view,
  to,
  over,
}: {
  entities: string[];
  view: ResearchSecurityView;
  to: LinkTo;
  over?: Partial<ResearchSecurityFilters>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {entities.map((e) => (
        <Chip key={e} tone="slate" href={to(view, { ...over, entity: e })} title={`Only ${e}`}>
          {e}
        </Chip>
      ))}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  href,
  tone = "plain",
}: {
  label: string;
  value: number;
  sub: ReactNode;
  href: string;
  tone?: "plain" | "primary" | "pending";
}) {
  return (
    <Link
      href={href}
      className={cn(
        cardClass,
        "hover:border-apollo-slate flex flex-col gap-[3px] px-4 py-3.5 transition-colors",
        tone === "primary" && "border-t-apollo-slate border-t-[3px]",
        tone === "pending" &&
          "bg-apollo-amber-tint border-apollo-amber-tint-border hover:border-apollo-amber border-dashed",
      )}
    >
      <span
        className={cn(
          "text-xs font-medium tracking-[.08em] uppercase",
          tone === "pending" ? "text-apollo-amber" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-[28px] leading-tight font-semibold tracking-[-.01em] tabular-nums",
          tone === "primary" && "text-apollo-slate",
        )}
      >
        {value.toLocaleString("en-US")}
      </span>
      <span className="text-apollo-ink-2 text-[12.5px] leading-snug">{sub}</span>
    </Link>
  );
}

/** A count that links to the rows behind it; a zero is plain text. */
function Count({ value, href, title }: { value: number; href?: string; title?: string }) {
  const text = value.toLocaleString("en-US");
  return href && value > 0 ? (
    <Link href={href} title={title} className={linkClass}>
      {text}
    </Link>
  ) : (
    <>{text}</>
  );
}

/** A count with a bar against the largest value in the column. */
function BarCell({ value, max, href }: { value: number; max: number; href?: string }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="bg-apollo-slate-tint hidden h-2 w-24 overflow-hidden rounded-full sm:block">
        {value > 0 && (
          <div
            className="bg-apollo-slate h-full rounded-full"
            style={{ width: `${Math.max(2, (value / Math.max(1, max)) * 100)}%` }}
          />
        )}
      </div>
      <span className="w-12 text-right font-semibold tabular-nums">
        <Count value={value} href={href} />
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

/** Confirmed authors ("Name (cwid)") of one campus; each name narrows the
 *  view to that person's papers. */
function Authors({
  campus,
  authors,
  view,
  to,
}: {
  campus: "wcm" | "ithaca";
  authors: string[];
  view: ResearchSecurityView;
  to: LinkTo;
}) {
  if (authors.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <CampusChip campus={campus} />
      {authors.map((a, i) => {
        const cwid = /\(([^()]+)\)$/.exec(a)?.[1];
        return (
          <span key={a}>
            {cwid ? (
              <Link href={to(view, { person: cwid.toLowerCase() })} className={linkClass}>
                {a}
              </Link>
            ) : (
              a
            )}
            {i < authors.length - 1 ? ";" : ""}
          </span>
        );
      })}
    </div>
  );
}

/** A column header that sorts the view; a second click reverses it. */
function SortLink({ ui, k, children }: { ui: ResearchSecurityUiParams; k: string; children: ReactNode }) {
  const defaultKey = SORT_KEYS[ui.view][0];
  const currentKey = ui.sort ?? defaultKey;
  const active = currentKey === k;
  const currentDir = ui.dir ?? defaultSortDir(currentKey);
  const nextDir = active ? (currentDir === "asc" ? "desc" : "asc") : defaultSortDir(k);
  const href = `${BASE}${researchSecurityQuery({
    view: ui.view,
    filters: ui.filters,
    q: ui.q,
    sort: k === defaultKey ? undefined : k,
    dir: nextDir === defaultSortDir(k) ? undefined : nextDir,
  })}`;
  return (
    <Link
      href={href}
      title={active ? "Reverse the order" : "Sort by this column"}
      aria-label={`Sort by ${typeof children === "string" ? children : k}${active ? `, currently ${currentDir === "asc" ? "ascending" : "descending"}` : ""}`}
      className={cn("hover:text-apollo-slate whitespace-nowrap hover:underline", active && "text-apollo-slate")}
    >
      {children}
      <span aria-hidden className={cn("ml-1", !active && "opacity-40")}>
        {active ? (currentDir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Link>
  );
}

const SEARCH_HINT: Record<ResearchSecurityView, string> = {
  entity: "Entity or category",
  person: "Name, CWID or department",
  paper: "Title, journal, PMID or author",
  funding: "Title, program or grant ID",
  unattributed: "Candidate, title or PMID",
};

function FilterBar({
  ui,
  categories,
  entities,
}: {
  ui: ResearchSecurityUiParams;
  categories: string[];
  entities: string[];
}) {
  const f = ui.filters;
  const country = f.list === LIST_COUNTRY;
  return (
    <form
      method="get"
      action={BASE}
      className={cn(cardClass, "flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3.5")}
    >
      <input type="hidden" name="view" value={ui.view} />
      {f.person && <input type="hidden" name="person" value={f.person} />}
      {ui.sort && <input type="hidden" name="sort" value={ui.sort} />}
      {ui.dir && <input type="hidden" name="dir" value={ui.dir} />}
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
      {/* The country tier has one category ("Country"): nothing to choose. */}
      {!country && (
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Category</span>
          <select name="category" defaultValue={f.category ?? ""} className={inputClass}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">{country ? "Country" : "Entity"}</span>
        <select name="entity" defaultValue={f.entity ?? ""} className={cn(inputClass, "max-w-[30ch]")}>
          <option value="">{country ? "All countries" : "All entities"}</option>
          {entities.map((e) => (
            <option key={e} value={e}>
              {e}
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
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="text-muted-foreground">Search {VIEW_LABEL[ui.view].toLowerCase()}</span>
        <input
          type="search"
          name="q"
          defaultValue={ui.q ?? ""}
          placeholder={SEARCH_HINT[ui.view]}
          className={cn(inputClass, "w-[26ch]")}
        />
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
      <p className="text-apollo-ink-2 border-apollo-border basis-full border-t pt-2.5 text-[12.5px] leading-snug">
        <span className="font-medium">{LIST_FILTER_LABEL[f.list]}.</span>{" "}
        {LIST_FILTER_DESCRIPTION[f.list]}
      </p>
    </form>
  );
}

/** The filters in force, each removable on its own when it is not a default. */
function FilterChips({
  ui,
  personLabel,
}: {
  ui: ResearchSecurityUiParams;
  personLabel?: string;
}) {
  return (
    <ul aria-label="Filters applied" className="flex flex-wrap items-center gap-1.5">
      {filterChips(ui.filters, personLabel).map((c) => (
        <li
          key={c.text}
          className={cn(chipBase, "gap-1.5 py-0.5", CHIP_TONE[c.without ? "slate" : "neutral"])}
        >
          {c.text}
          {c.without && (
            <Link
              href={`${BASE}${researchSecurityQuery({ view: ui.view, filters: c.without })}`}
              aria-label={`Remove filter: ${c.text}`}
              className="hover:text-apollo-ink -mr-0.5 font-semibold"
            >
              ×
            </Link>
          )}
        </li>
      ))}
    </ul>
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
            "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px]",
            v === ui.view
              ? "border-apollo-slate text-apollo-slate font-semibold"
              : "text-apollo-ink-2 hover:text-apollo-ink border-transparent",
          )}
        >
          {VIEW_LABEL[v]}
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[12px] font-medium tabular-nums",
              v === "unattributed"
                ? "bg-apollo-amber-tint text-apollo-amber"
                : v === ui.view
                  ? "bg-apollo-slate-tint text-apollo-slate"
                  : "bg-apollo-surface-2 text-apollo-ink-2",
            )}
          >
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
    `${BASE}${researchSecurityQuery({ view: ui.view, filters: ui.filters, q: ui.q, sort: ui.sort, dir: ui.dir, page: p })}`;
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

/** The not-yet-attributed tier inside a confirmed table: tinted, so the two
 *  are never read as one count. */
const pendingCell = "bg-apollo-amber-tint/60";

function EntityTable({ rows, ui }: { rows: EntityRow[]; ui: ResearchSecurityUiParams }) {
  const max = Math.max(1, ...rows.map((r) => r.papers));
  const to = linkBuilder(ui.filters);
  const noun = ui.filters.list === LIST_COUNTRY ? "Country" : "Entity";
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>
            <SortLink ui={ui} k="entity">{noun}</SortLink>
          </th>
          <th className={thClass}>Category</th>
          <th className={cn(thClass, "text-right")}>
            <SortLink ui={ui} k="papers">Co-publications</SortLink>
          </th>
          <th className={cn(thClass, "text-right")}>WCM</th>
          <th className={cn(thClass, "text-right")}>Cornell</th>
          <th
            className={cn(thClass, "text-right")}
            title={`Co-publications with fewer than ${CONSORTIUM_AUTHORS} authors`}
          >
            Excl. consortia
          </th>
          <th className={cn(thClass, "text-right")}>
            <SortLink ui={ui} k="people">Our authors</SortLink>
          </th>
          <th
            className={cn(thClass, "text-right")}
            title="Confirmed papers where the co-author at this entity has the name of one of our confirmed authors"
          >
            Our author lists it
          </th>
          <th className={cn(thClass, pendingCell, "text-apollo-amber text-right")}>
            <SortLink ui={ui} k="unattributed">Not yet attributed</SortLink>
          </th>
          <th
            className={cn(thClass, pendingCell, "text-apollo-amber text-right")}
            title="Not-yet-attributed papers whose best candidate is priority 1 or 2"
          >
            Priority 1–2
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={10} />}
        {rows.map((r) => {
          const over = { entity: r.entity };
          return (
            <tr key={`${r.listCode}|${r.entity}`} className={rowClass}>
              <td className={cn(tdClass, "font-medium")}>
                <Link
                  href={to("paper", over)}
                  title={`Papers with a co-author at ${r.entity}`}
                  className={linkClass}
                >
                  {r.entity}
                </Link>
                {r.listNo != null && (
                  <span className="text-muted-foreground font-normal"> · no. {r.listNo}</span>
                )}
              </td>
              <td className={tdClass}>
                <Chip>{r.category}</Chip>
              </td>
              <td className={tdClass}>
                <BarCell value={r.papers} max={max} href={to("paper", over)} />
              </td>
              <td className={cn(tdClass, numClass)}>
                <Count value={r.papersWcm} href={to("paper", { ...over, campus: "wcm" })} />
              </td>
              <td className={cn(tdClass, numClass)}>
                <Count value={r.papersIthaca} href={to("paper", { ...over, campus: "ithaca" })} />
              </td>
              <td className={cn(tdClass, numClass)}>
                <Count
                  value={r.papersExcludingConsortia}
                  href={to("paper", { ...over, excludeConsortia: true })}
                />
              </td>
              <td className={cn(tdClass, numClass)}>
                <Count value={r.people} href={to("person", over)} />
              </td>
              <td className={cn(tdClass, numClass)}>
                {r.papersOurAuthorListsEntity > 0 ? (
                  <Chip tone="amber" title="Verify: possible dual appointment or a namesake">
                    {r.papersOurAuthorListsEntity.toLocaleString("en-US")}
                  </Chip>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </td>
              <td className={cn(tdClass, numClass, pendingCell)}>
                <Count value={r.unattributedPapers} href={to("unattributed", over)} />
              </td>
              <td className={cn(tdClass, numClass, pendingCell)}>
                {r.unattributedPriority12.toLocaleString("en-US")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PersonTable({ rows, ui }: { rows: PersonRow[]; ui: ResearchSecurityUiParams }) {
  const max = Math.max(1, ...rows.map((r) => r.papers));
  const to = linkBuilder(ui.filters);
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>
            <SortLink ui={ui} k="name">Person</SortLink>
          </th>
          <th className={thClass}>Campus</th>
          <th className={thClass}>
            <SortLink ui={ui} k="department">Department</SortLink>
          </th>
          <th className={cn(thClass, "text-right")}>
            <SortLink ui={ui} k="papers">Co-publications</SortLink>
          </th>
          <th
            className={cn(thClass, "text-right")}
            title={`Co-publications with fewer than ${CONSORTIUM_AUTHORS} authors`}
          >
            Excl. consortia
          </th>
          <th className={thClass}>
            {ui.filters.list === LIST_COUNTRY ? "Countries" : "Entities"}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={6} />}
        {rows.map((r) => {
          const over = r.cwid ? { person: r.cwid.toLowerCase() } : undefined;
          return (
            <tr key={r.cwid ?? r.name} className={rowClass}>
              <td className={tdClass}>
                {over ? (
                  <Link
                    href={to("paper", over)}
                    title={`${r.name}'s co-publications`}
                    className={cn(linkClass, "font-medium")}
                  >
                    {r.name}
                  </Link>
                ) : (
                  <span className="font-medium">{r.name}</span>
                )}
                {r.cwid && <span className="text-muted-foreground"> (<span className="font-mono">{r.cwid}</span>)</span>}
                {r.title && <div className="text-muted-foreground text-[12.5px]">{r.title}</div>}
              </td>
              <td className={tdClass}>
                <CampusChip campus={r.campus} />
              </td>
              <td className={cn(tdClass, "text-apollo-ink-2 text-[13px]")}>
                {r.department ?? "—"}
              </td>
              <td className={tdClass}>
                <BarCell value={r.papers} max={max} href={over && to("paper", over)} />
              </td>
              <td className={cn(tdClass, numClass)}>
                {r.papersExcludingConsortia.toLocaleString("en-US")}
              </td>
              <td className={cn(tdClass, "max-w-[44ch]")}>
                {over ? (
                  <EntityChips entities={r.entities} view="paper" to={to} over={over} />
                ) : (
                  <span className="text-[13px]">{r.entities.join("; ")}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PaperTable({
  rows,
  matchedStrings,
  ui,
}: {
  rows: PaperRow[];
  matchedStrings: MatchedString[];
  ui: ResearchSecurityUiParams;
}) {
  const strings = new Map<string, MatchedString[]>();
  for (const m of matchedStrings) strings.set(m.articleId, [...(strings.get(m.articleId) ?? []), m]);
  const to = linkBuilder(ui.filters);
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>
            Paper
            <span className="ml-3 inline-flex gap-3 font-normal tracking-normal normal-case">
              <SortLink ui={ui} k="date">Date</SortLink>
              <SortLink ui={ui} k="title">Title</SortLink>
              <SortLink ui={ui} k="authors">Author count</SortLink>
            </span>
          </th>
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
                <div className="flex flex-col gap-1">
                  <Authors campus="wcm" authors={r.wcmAuthors} view="paper" to={to} />
                  <Authors campus="ithaca" authors={r.ithacaAuthors} view="paper" to={to} />
                </div>
              </td>
              <td className={cn(tdClass, "max-w-[52ch] text-[13px]")}>
                <EntityChips entities={r.entities} view="paper" to={to} />
                <details className="mt-1.5">
                  <summary className="text-apollo-slate cursor-pointer">
                    {mine.length.toLocaleString("en-US")} matched{" "}
                    {mine.length === 1 ? "string" : "strings"} ·{" "}
                    {r.coAuthorsAtEntities.toLocaleString("en-US")}{" "}
                    {r.coAuthorsAtEntities === 1 ? "co-author" : "co-authors"}
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {mine.map((m, i) => (
                      <li
                        key={i}
                        className={cn(
                          "border-l-2 pl-2",
                          m.isInstitutionAuthor ? "border-apollo-amber" : "border-apollo-slate-tint-border",
                        )}
                      >
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
              <td className={tdClass}>
                <div className="flex flex-col items-start gap-1">
                  {r.ourAuthorListsEntity && (
                    <Chip tone="amber" title="The matched co-author has the name of one of our confirmed authors: verify">
                      Our author may list the entity
                    </Chip>
                  )}
                  {r.fundingPrograms.map((p) => (
                    <Chip key={p} tone="slate" title={p}>
                      Funding: {p}
                    </Chip>
                  ))}
                  {r.consortium && <Chip>Large consortium</Chip>}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FundingTable({ rows, ui }: { rows: FundingRow[]; ui: ResearchSecurityUiParams }) {
  const to = linkBuilder(ui.filters);
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>
            Paper
            <span className="ml-3 font-normal tracking-normal normal-case">
              <SortLink ui={ui} k="date">Date</SortLink>
            </span>
          </th>
          <th className={thClass}>
            <SortLink ui={ui} k="program">Program flagged</SortLink>
          </th>
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
            <td className={tdClass}>
              <Chip tone="slate">{r.program}</Chip>
            </td>
            <td className={cn(tdClass, "max-w-[30ch] text-[13px]")}>{r.agency ?? "—"}</td>
            <td className={cn(tdClass, "text-[13px] tabular-nums")}>{r.grantId ?? "—"}</td>
            <td className={cn(tdClass, "max-w-[30ch] text-[13px]")}>
              <div className="flex flex-col gap-1">
                <Authors campus="wcm" authors={r.wcmAuthors} view="funding" to={to} />
                <Authors campus="ithaca" authors={r.ithacaAuthors} view="funding" to={to} />
              </div>
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
const PRIORITY_LABEL: Record<number, string> = {
  1: "Verify namesake",
  2: "Likely ours",
  3: "Lower score",
  4: "Consortium",
};
const PRIORITY_TONE: Record<number, keyof typeof CHIP_TONE> = {
  1: "amber",
  2: "slate",
  3: "neutral",
  4: "neutral",
};

function UnattributedTable({ rows, ui }: { rows: UnattributedRow[]; ui: ResearchSecurityUiParams }) {
  const to = linkBuilder(ui.filters);
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
            <td className={tdClass}>
              <Chip tone={PRIORITY_TONE[r.priority]} title={PRIORITY_MEANING[r.priority]}>
                <span className="font-semibold tabular-nums">{r.priority}</span>
                <span className="mx-1">·</span>
                {PRIORITY_LABEL[r.priority]}
              </Chip>
              {r.alreadyConfirmed && (
                <div className="text-muted-foreground mt-1 text-[12px]">
                  Already confirmed for another author; not counted
                </div>
              )}
            </td>
            <td className={tdClass}>
              {r.person.cwid ? (
                <Link
                  href={to("unattributed", { person: r.person.cwid.toLowerCase() })}
                  title={`Only ${r.person.displayName}'s open rows`}
                  className={cn(linkClass, "font-medium")}
                >
                  {r.person.displayName}
                </Link>
              ) : (
                <span className="font-medium">{r.person.displayName}</span>
              )}
              {r.person.cwid && <span className="text-muted-foreground"> (<span className="font-mono">{r.person.cwid}</span>)</span>}
              <div className="text-apollo-ink-2 mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                <CampusChip campus={r.person.campus} />
                {r.person.department}
              </div>
              {r.candidateListsEntity && (
                <div className="text-apollo-amber mt-0.5 text-[12.5px]">Candidate also lists the entity</div>
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
            <td className={cn(tdClass, "max-w-[36ch]")}>
              <EntityChips entities={r.entities} view="unattributed" to={to} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Papers listed under a candidate before "All N rows" takes over. */
const GROUP_PREVIEW = 5;
const GROUP_ENTITIES = 6;

/** Not yet attributed, one row per candidate. The name opens everything the
 *  screen holds about that person. */
function UnattributedGroupTable({
  groups,
  ui,
}: {
  groups: UnattributedGroup[];
  ui: ResearchSecurityUiParams;
}) {
  const to = linkBuilder(ui.filters);
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>
            <SortLink ui={ui} k="priority">Priority</SortLink>
          </th>
          <th className={thClass}>
            <SortLink ui={ui} k="name">Candidate</SortLink>
          </th>
          <th className={cn(thClass, "text-right")}>
            <SortLink ui={ui} k="papers">Open papers</SortLink>
          </th>
          <th className={cn(thClass, "text-right")}>
            <SortLink ui={ui} k="score">Top ReCiter score</SortLink>
          </th>
          <th className={thClass}>Listed entities</th>
          <th className={thClass}>Papers</th>
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 && <Empty cols={6} />}
        {groups.map((g) => {
          const mine = g.person.cwid
            ? to("unattributed", { person: g.person.cwid.toLowerCase() })
            : undefined;
          const notCounted = g.rows.filter((r) => r.alreadyConfirmed).length;
          return (
            <tr key={g.key} className={rowClass}>
              <td className={tdClass}>
                <Chip tone={PRIORITY_TONE[g.priority]} title={PRIORITY_MEANING[g.priority]}>
                  <span className="font-semibold tabular-nums">{g.priority}</span>
                  <span className="mx-1">·</span>
                  {PRIORITY_LABEL[g.priority]}
                </Chip>
              </td>
              <td className={tdClass}>
                {mine ? (
                  <Link
                    href={mine}
                    title={`Everything on file for ${g.person.displayName}`}
                    className={cn(linkClass, "font-medium")}
                  >
                    {g.person.displayName}
                  </Link>
                ) : (
                  <span className="font-medium">{g.person.displayName}</span>
                )}
                {g.person.cwid && <span className="text-muted-foreground"> (<span className="font-mono">{g.person.cwid}</span>)</span>}
                <div className="text-apollo-ink-2 mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <CampusChip campus={g.person.campus} />
                  {g.person.department}
                </div>
                {g.candidateListsEntity && (
                  <div className="text-apollo-amber mt-0.5 text-[12.5px]">Candidate also lists the entity</div>
                )}
              </td>
              <td className={cn(tdClass, numClass)}>
                <span className="font-semibold">
                  <Count value={g.papers} href={mine} />
                </span>
                {notCounted > 0 && (
                  <div className="text-muted-foreground text-[12px]">
                    +{notCounted} already confirmed
                  </div>
                )}
              </td>
              <td className={cn(tdClass, numClass)}>
                {g.maxScore == null ? "—" : g.maxScore.toFixed(1)}
              </td>
              <td className={cn(tdClass, "max-w-[34ch]")}>
                <EntityChips
                  entities={g.entities.slice(0, GROUP_ENTITIES)}
                  view="unattributed"
                  to={to}
                />
                {g.entities.length > GROUP_ENTITIES && (
                  <div className="text-muted-foreground mt-1 text-[12px]">
                    +{g.entities.length - GROUP_ENTITIES} more
                  </div>
                )}
              </td>
              <td className={cn(tdClass, "max-w-[48ch] text-[13px]")}>
                <details>
                  <summary className="text-apollo-slate cursor-pointer">
                    {g.rows.length.toLocaleString("en-US")} {g.rows.length === 1 ? "row" : "rows"}
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-2">
                    {g.rows.slice(0, GROUP_PREVIEW).map((r) => {
                      const href = articleLink(r.article);
                      const title = r.article.title ?? r.article.articleId;
                      return (
                        <li key={r.article.articleId} className="border-apollo-amber-tint-border border-l-2 pl-2">
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium hover:underline">
                              {title}
                            </a>
                          ) : (
                            <span className="font-medium">{title}</span>
                          )}
                          <div className="text-muted-foreground text-[12.5px]">
                            {[
                              isoDay(r.article.publicationDate),
                              r.person.reciterScore == null ? null : `score ${r.person.reciterScore.toFixed(1)}`,
                              attributionReason(r.person),
                              r.alreadyConfirmed ? "already confirmed for another author; not counted" : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {mine && g.rows.length > GROUP_PREVIEW && (
                    <Link href={mine} className={cn(linkClass, "mt-2 inline-block")}>
                      All {g.rows.length.toLocaleString("en-US")} rows →
                    </Link>
                  )}
                </details>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Stat({
  label,
  value,
  href,
  sub,
  tone,
}: {
  label: string;
  value: number;
  href?: string;
  sub?: ReactNode;
  tone?: "pending";
}) {
  return (
    <div
      className={cn(
        "flex min-w-[150px] flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2",
        tone === "pending" && value > 0
          ? "bg-apollo-amber-tint border-apollo-amber-tint-border"
          : "border-apollo-border bg-apollo-page",
      )}
    >
      <span className="text-muted-foreground text-[11.5px] font-medium tracking-[.06em] uppercase">
        {label}
      </span>
      <span className="text-xl font-semibold tabular-nums">
        <Count value={value} href={href} />
      </span>
      {sub && <span className="text-apollo-ink-2 text-[12.5px] leading-snug">{sub}</span>}
    </div>
  );
}

/** Everything the screen holds about the selected person, under the other
 *  filters. Shown above the tabs whenever a person filter is on. */
function PersonCard({
  profile,
  links,
  methods,
  ui,
}: {
  profile: PersonProfile;
  links?: { console: string; publicProfile?: string };
  methods?: InferredMethods | null;
  ui: ResearchSecurityUiParams;
}) {
  const f = ui.filters;
  const to = linkBuilder(f);
  const country = f.list === LIST_COUNTRY;
  const years =
    profile.firstYear == null
      ? null
      : profile.firstYear === profile.lastYear
        ? String(profile.firstYear)
        : `${profile.firstYear}–${profile.lastYear}`;
  const scores =
    profile.scoreMax == null
      ? null
      : profile.scoreMin === profile.scoreMax
        ? `ReCiter score ${profile.scoreMax.toFixed(1)}`
        : `ReCiter scores ${profile.scoreMin!.toFixed(1)}–${profile.scoreMax.toFixed(1)}`;
  return (
    <section
      aria-label={`On file for ${profile.name}`}
      className={cn(cardClass, "border-l-apollo-slate flex flex-col gap-3.5 border-l-4 px-4 py-4 sm:px-5")}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg leading-tight font-semibold">
            {profile.name} <span className="text-muted-foreground font-normal">(<span className="font-mono">{profile.cwid}</span>)</span>
          </h2>
          <div className="text-apollo-ink-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <CampusChip campus={profile.campus} />
            {[profile.title, profile.department].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {links && (
            <Link href={links.console} className={linkClass}>
              Console record
            </Link>
          )}
          {links?.publicProfile && (
            <Link href={links.publicProfile} className={linkClass}>
              Public profile
            </Link>
          )}
          <Link
            href={to(ui.view, { list: country ? "entities" : LIST_COUNTRY, category: undefined, entity: undefined })}
            className={linkClass}
          >
            {country ? "See listed entities" : "See country-of-concern tier"}
          </Link>
          <Link href={to(ui.view, { person: undefined })} className={linkClass}>
            Close
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Stat
          label="Confirmed co-publications"
          value={profile.confirmedPapers}
          href={to("paper")}
          sub={
            [
              years,
              profile.confirmedPapers > 0
                ? `${profile.confirmedExcludingConsortia.toLocaleString("en-US")} excluding consortia`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "None under these filters"
          }
        />
        <Stat
          label="Name matches a listed co-author"
          value={profile.listsEntityPapers}
          tone="pending"
          sub="Confirmed papers where the co-author at the entity has this person's name: verify"
        />
        <Stat
          label="Not yet attributed"
          value={profile.openPapers}
          href={to("unattributed")}
          tone="pending"
          sub={
            [
              scores,
              profile.openListsEntity > 0 ? `${profile.openListsEntity} also list the entity` : null,
              profile.openInReviewQueue > 0 ? `${profile.openInReviewQueue} in the review queue` : null,
              profile.openAlreadyConfirmed > 0
                ? `${profile.openAlreadyConfirmed} more already confirmed for another author`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No open suggestions"
          }
        />
        <Stat
          label="Funding-flag papers"
          value={profile.fundingFlagPapers}
          href={to("funding")}
          sub="CSC or a talent program in grant metadata"
        />
      </div>
      {profile.entities.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-muted-foreground text-[11.5px] font-medium tracking-[.06em] uppercase">
            {country ? "Countries" : "Listed entities"} · confirmed, and open in amber
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {profile.entities.map((e) => (
              <li key={e.entity} className={cn(chipBase, CHIP_TONE.slate, "gap-1.5")}>
                <Link
                  href={to(e.confirmed > 0 ? "paper" : "unattributed", { entity: e.entity })}
                  className="hover:underline"
                >
                  {e.entity}
                </Link>
                <span className="font-semibold tabular-nums">{e.confirmed}</span>
                {e.open > 0 && (
                  <Link
                    href={to("unattributed", { entity: e.entity })}
                    title="Not yet attributed"
                    className="text-apollo-amber font-semibold tabular-nums hover:underline"
                  >
                    +{e.open}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {profile.coAuthors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-muted-foreground text-[11.5px] font-medium tracking-[.06em] uppercase">
            Our other confirmed authors on these papers
          </h3>
          <p className="text-[13px] leading-relaxed">
            {profile.coAuthors.slice(0, 12).map((c, i, shown) => (
              <span key={c.cwid ?? c.name}>
                {c.cwid ? (
                  <Link href={to(ui.view, { person: c.cwid.toLowerCase() })} className={linkClass}>
                    {c.name}
                  </Link>
                ) : (
                  c.name
                )}
                <span className="text-muted-foreground"> {c.papers}</span>
                {i < shown.length - 1 ? "; " : ""}
              </span>
            ))}
            {profile.coAuthors.length > 12 && (
              <span className="text-muted-foreground"> and {profile.coAuthors.length - 12} more</span>
            )}
          </p>
        </div>
      )}
      {methods && <MethodsBlock methods={methods} />}
      <p className="text-muted-foreground text-[12.5px]">
        Screening results under the filters above, not a determination. Names match approximately:
        read the matched affiliation strings (By paper) before acting.
      </p>
    </section>
  );
}

const cardHeading = "text-muted-foreground text-[11.5px] font-medium tracking-[.06em] uppercase";

/** Methods and tools ReciterAI inferred from a card's confirmed papers. */
function MethodsBlock({ methods }: { methods: InferredMethods }) {
  const n = (x: number) => x.toLocaleString("en-US");
  const coverage = `Read from ${n(methods.papersCovered)} of ${n(methods.papers)} confirmed papers`;
  return (
    <div className="flex flex-col gap-2">
      <h3 className={cardHeading}>Methods and tools on these papers · inferred</h3>
      {methods.families.length === 0 && methods.tools.length === 0 ? (
        <p className="text-apollo-ink-2 text-[13px]">
          None inferred for these papers ({n(methods.pubmedPapers)} of {n(methods.papers)} are in
          PubMed).
        </p>
      ) : (
        <>
          {methods.families.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-apollo-ink-2 text-[12.5px]">
                Method families
                {methods.familyCount > methods.families.length
                  ? ` · top ${methods.families.length} of ${n(methods.familyCount)}`
                  : ""}
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {methods.families.map((f) => (
                  <li
                    key={`${f.supercategory}|${f.label}`}
                    title={[
                      supercategoryLabel(f.supercategory),
                      f.definition ? `${f.definition} (AI-generated definition)` : null,
                      `${n(f.papers)} papers · ${n(f.people)} of our authors`,
                      f.sensitive ? "Sensitive family: hidden on public profiles" : null,
                    ]
                      .filter(Boolean)
                      .join(" — ")}
                    className={cn(chipBase, CHIP_TONE.slate, "gap-1.5")}
                  >
                    {f.label}
                    <span className="font-semibold tabular-nums">{n(f.papers)}</span>
                    {f.sensitive && <span className="text-apollo-amber">sensitive</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {methods.tools.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-apollo-ink-2 text-[12.5px]">
                Named tools
                {methods.toolCount > methods.tools.length
                  ? ` · top ${methods.tools.length} of ${n(methods.toolCount)}`
                  : ""}
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {methods.tools.map((t) => (
                  <li
                    key={t.name}
                    title={[t.category, `${n(t.papers)} papers · ${n(t.people)} of our authors`]
                      .filter(Boolean)
                      .join(" — ")}
                    className={cn(chipBase, CHIP_TONE.neutral, "gap-1.5")}
                  >
                    {t.name}
                    <span className="font-semibold tabular-nums">{n(t.papers)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="text-muted-foreground text-[12.5px]">
        {coverage}. Inferred by ReciterAI from each paper&apos;s text and not reviewed; PubMed papers
        with an author who has methods data only
        {methods.peopleCapped ? `; limited to the ${n(METHODS_PEOPLE_LIMIT)} authors on the most papers` : ""}
        . It describes what a paper used, not what any co-author contributed or received.
      </p>
    </div>
  );
}

/** Everything the screen holds about the selected entity (or country), under
 *  the other filters. Shown above the tabs whenever an entity filter is on. */
function EntityCard({
  profile,
  affiliations,
  methods,
  ui,
}: {
  profile: EntityProfile;
  affiliations?: Array<{ affiliation: string; papers: number }>;
  methods?: InferredMethods | null;
  ui: ResearchSecurityUiParams;
}) {
  const to = linkBuilder(ui.filters);
  const country = ui.filters.list === LIST_COUNTRY;
  const maxYear = Math.max(1, ...profile.byYear.map((y) => y.papers));
  const maxPeople = Math.max(1, ...profile.topPeople.map((p) => p.papers));
  const maxDept = Math.max(1, ...profile.departments.map((d) => d.papers));
  return (
    <section
      aria-label={`On file for ${profile.entity}`}
      className={cn(cardClass, "border-l-apollo-slate flex flex-col gap-4 border-l-4 px-4 py-4 sm:px-5")}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg leading-tight font-semibold">{profile.entity}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {profile.listings.map((l) => (
              <Chip key={`${l.listCode}|${l.category}`}>
                {LIST_FILTER_LABEL[l.listCode as ListFilter] ?? l.listCode}
                {country ? "" : ` · ${l.category}`}
                {l.listNo != null ? ` · no. ${l.listNo}` : ""}
              </Chip>
            ))}
          </div>
        </div>
        <Link href={to(ui.view, { entity: undefined })} className={cn(linkClass, "ml-auto text-[13px]")}>
          Close
        </Link>
      </div>

      <div className="flex flex-wrap gap-2.5">
        <Stat
          label="Confirmed co-publications"
          value={profile.confirmedPapers}
          href={to("paper")}
          sub={`WCM ${profile.papersWcm.toLocaleString("en-US")} · Cornell ${profile.papersIthaca.toLocaleString("en-US")} · ${profile.confirmedExcludingConsortia.toLocaleString("en-US")} excluding consortia`}
        />
        <Stat
          label="Our authors"
          value={profile.people}
          href={to("person")}
          sub="Distinct confirmed WCM and Cornell people"
        />
        <Stat
          label={country ? "Our author lists the country" : "Our author lists it"}
          value={profile.papersOurAuthorListsEntity}
          tone="pending"
          sub="Confirmed papers where the co-author here has one of our authors' names: verify"
        />
        <Stat
          label="Not yet attributed"
          value={profile.unattributedPapers}
          href={to("unattributed")}
          tone="pending"
          sub="Papers awaiting review · not in any confirmed count"
        />
        <Stat
          label="Also funding-flagged"
          value={profile.fundingFlagPapers}
          sub="Confirmed co-publications naming CSC or a talent program"
        />
      </div>

      {profile.byYear.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <h3 className={cardHeading}>Confirmed co-publications by year</h3>
          <ol className="flex h-[92px] items-end gap-1.5" aria-label="Confirmed co-publications by year">
            {profile.byYear.map((y) => (
              <li
                key={y.year}
                title={`${y.year}: ${y.papers.toLocaleString("en-US")}`}
                className="flex h-full max-w-14 min-w-7 flex-1 flex-col items-center justify-end gap-0.5"
              >
                <span className="text-[11.5px] font-medium tabular-nums">
                  {y.papers.toLocaleString("en-US")}
                </span>
                <span
                  className="bg-apollo-slate w-full rounded-t-[3px]"
                  style={{ height: `${Math.max(y.papers > 0 ? 3 : 1, (y.papers / maxYear) * 52)}px` }}
                />
                <span className="text-muted-foreground text-[11.5px] tabular-nums">{y.year}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-x-8 gap-y-4">
        {profile.topPeople.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className={cardHeading}>
              Our people with the most co-publications
              {profile.people > profile.topPeople.length ? ` · top ${profile.topPeople.length} of ${profile.people.toLocaleString("en-US")}` : ""}
            </h3>
            <ul className="flex flex-col gap-1 text-[13px]">
              {profile.topPeople.map((p) => (
                <li key={p.cwid ?? p.name} className="flex items-center gap-2">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
                    {p.cwid ? (
                      <Link href={to(ui.view, { person: p.cwid.toLowerCase() })} className={linkClass}>
                        {p.name}
                      </Link>
                    ) : (
                      p.name
                    )}
                    <CampusChip campus={p.campus} />
                    {p.department && <span className="text-muted-foreground">{p.department}</span>}
                  </span>
                  <BarCell value={p.papers} max={maxPeople} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {profile.departments.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className={cardHeading}>Our departments</h3>
            <ul className="flex flex-col gap-1 text-[13px]">
              {profile.departments.map((d) => (
                <li key={`${d.campus}|${d.department}`} className="flex items-center gap-2">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
                    {d.department}
                    <CampusChip campus={d.campus} />
                  </span>
                  <BarCell value={d.papers} max={maxDept} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {methods && <MethodsBlock methods={methods} />}

      {profile.coAuthors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className={cardHeading}>
            Co-authors {country ? "there" : "at this entity"} on two or more of these papers
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {profile.coAuthors.map((c) => (
              <li
                key={c.name}
                title={c.ourName ? "Has the name of one of our confirmed authors: verify" : undefined}
                className={cn(chipBase, CHIP_TONE[c.ourName ? "amber" : "neutral"], "gap-1.5")}
              >
                {c.name}
                <span className="font-semibold tabular-nums">{c.papers}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-[12.5px]">
            Grouped by the name in the byline, which is approximate: two people can share a name.
            Amber = the name is also one of our confirmed authors&apos;. Verify against the matched
            strings (By paper).
          </p>
        </div>
      )}

      {affiliations && affiliations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className={cardHeading}>Most common matched affiliation strings</h3>
          <ul className="flex flex-col gap-1 text-[13px]">
            {affiliations.map((a) => (
              <li key={a.affiliation} className="border-apollo-slate-tint-border flex gap-2 border-l-2 pl-2">
                <span className="text-apollo-ink-2 min-w-0 flex-1 break-words">{a.affiliation}</span>
                <span className="font-semibold tabular-nums">{a.papers.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-muted-foreground text-[12.5px]">
        Screening results under the filters above, not a determination: a match says an affiliation
        string fits a pattern, nothing about the collaboration itself.
      </p>
    </section>
  );
}

const VIEW_NOTE: Record<ResearchSecurityView, string> = {
  entity:
    "Confirmed co-publications per listed entity. Select a name or a count to see the rows behind it. The two shaded columns are the not-yet-attributed tier and are not part of any confirmed count.",
  person:
    "Our people with a confirmed co-publication. Confirmed authorships only. Select a name to see that person's papers.",
  paper:
    "Confirmed co-publications, newest first. Open a row's matched strings to read the exact co-author and affiliation text.",
  funding:
    "Papers with a confirmed author whose grant metadata names the China Scholarship Council or a talent program. Paper-level: it does not say which author held the award. The list, category and entity filters do not apply.",
  unattributed:
    "Suggestions nobody has reviewed and open review-queue rows, one row per candidate. Never part of a confirmed count. Select a name to see everything on file for that person. A paper already confirmed for another of our authors is marked and not counted.",
};

function MethodsSection({ doc }: { doc: ResearchSecurityMethodsDoc }) {
  return (
    <section className="flex flex-col gap-3.5">
      <MethodsDisclosure
        id="methods"
        className="group scroll-mt-32"
        summary={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span aria-hidden className="text-apollo-slate text-sm group-open:rotate-90">
              ▶
            </span>
            <h2 className="text-xl font-semibold">Methods &amp; assumptions</h2>
            <span className="text-muted-foreground text-[13px]">
              {doc.sections.length} sections: lists, matching, known limits
            </span>
          </span>
        }
      >
        <div
          className={cn(
            cardClass,
            "mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-4 px-4 py-[18px] sm:px-[22px]",
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
      </MethodsDisclosure>
      {/* Plain <a>: the target is a download route handler. */}
      <a
        href={`${BASE}/export?section=methods`}
        className="text-apollo-slate self-start text-[13px] hover:underline"
      >
        Download methods
      </a>
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
  entities,
  profile,
  profileLinks,
  entityProfile,
  entityAffiliations,
  personMethods,
  entityMethods,
  viewShown,
  viewTotal,
  dataAsOf,
  methods,
}: ResearchSecurityDashboardProps) {
  const f = ui.filters;
  const noun = summary.tier === "country" ? "Country-of-concern" : "Listed-entity";
  const to = linkBuilder(f);
  const exportHref = `${BASE}/export${researchSecurityQuery({ view: ui.view, filters: f, q: ui.q, sort: ui.sort, dir: ui.dir })}`;
  const personLabel = profile ? `${profile.name} (${profile.cwid})` : undefined;
  const unit =
    current.view === "unattributed" ? (current.groups ? "candidates" : "rows") : "rows";
  return (
    <div className="flex flex-col gap-6">
      <p
        role="note"
        className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-notice-text border-l-apollo-slate rounded-[13px] border border-l-4 px-4 py-3 text-[14px] leading-normal"
      >
        <strong>{methods.notice}</strong>{" "}
        <a href="#methods" className="text-apollo-slate underline underline-offset-2">
          Methods &amp; assumptions
        </a>
      </p>

      <FilterBar ui={ui} categories={categories} entities={entities} />

      {dataAsOf === null ? (
        <p className={cn(cardClass, "text-muted-foreground px-4 py-6 text-center text-[14px]")}>
          No data has been loaded yet. The nightly research-security step fills this page.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
            <Kpi
              tone="primary"
              href={to("paper")}
              label={`${noun} co-publications`}
              value={summary.coPublications}
              sub={`Confirmed authorships · ${summary.coPublicationsExcludingConsortia.toLocaleString("en-US")} excluding ${CONSORTIUM_AUTHORS}+ author consortia`}
            />
            <Kpi
              href={to("person")}
              label="Our authors"
              value={summary.people}
              sub="Distinct confirmed WCM and Cornell people"
            />
            <Kpi
              href={to("entity")}
              label={summary.tier === "country" ? "Countries" : "Entities"}
              value={summary.entities}
              sub="With at least one confirmed co-publication"
            />
            <Kpi
              href={to("funding")}
              label="Funding-flag papers"
              value={summary.fundingFlagPapers}
              sub="CSC or a talent program in grant metadata"
            />
            <Kpi
              tone="pending"
              href={to("unattributed")}
              label="Not yet attributed"
              value={summary.unattributedPapers}
              sub="Papers awaiting review · not in any confirmed count"
            />
          </div>
          <div className="-mt-3 flex flex-col gap-1.5">
            <FilterChips ui={ui} personLabel={personLabel} />
            <p className="text-muted-foreground text-[12.5px]">
              Data as of {isoDay(dataAsOf)}
              {summary.tier === "entity"
                ? " · country-of-concern matches are a separate tier and are not in these counts; select that list to see them"
                : " · a far wider net than the entity lists; never added to an entity total"}
              {f.person ? " · every count covers this person's papers only" : ""}
            </p>
          </div>

          {entityProfile && (
            <EntityCard
              profile={entityProfile}
              affiliations={entityAffiliations}
              methods={entityMethods}
              ui={ui}
            />
          )}
          {profile && <PersonCard profile={profile} links={profileLinks} methods={personMethods} ui={ui} />}
          {f.person && !profile && (
            <p className={cn(cardClass, "text-apollo-ink-2 px-4 py-3 text-[13.5px]")}>
              Nothing is on file for <strong>{f.person}</strong> under these filters.{" "}
              <Link href={to(ui.view, { person: undefined })} className={linkClass}>
                Remove the person filter
              </Link>
            </p>
          )}

          <section className="flex flex-col gap-3">
            <Tabs ui={ui} tabCounts={tabCounts} />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-muted-foreground max-w-[90ch] text-[13px]">
                {ui.view === "unattributed" && f.person
                  ? "This person's open suggestions and review-queue rows, one per paper. Never part of a confirmed count."
                  : VIEW_NOTE[ui.view]}
              </p>
              {/* Plain <a>: the target is a download route handler. */}
              <a href={exportHref} className="text-apollo-slate ml-auto text-[13px] hover:underline">
                Download this view (.xlsx)
              </a>
            </div>
            {ui.q && viewShown != null && viewTotal != null && (
              <p className="text-[13px]">
                <strong>
                  {viewShown.toLocaleString("en-US")} of {viewTotal.toLocaleString("en-US")} {unit}
                </strong>{" "}
                match “{ui.q}”. The tiles and tab counts above are not narrowed by the search.{" "}
                <Link
                  href={`${BASE}${researchSecurityQuery({ view: ui.view, filters: f, sort: ui.sort, dir: ui.dir })}`}
                  className={linkClass}
                >
                  Clear search
                </Link>
              </p>
            )}
            <div className={tableWrapClass}>
              {current.view === "entity" && <EntityTable rows={current.rows} ui={ui} />}
              {current.view === "person" && <PersonTable rows={current.rows} ui={ui} />}
              {current.view === "paper" && (
                <PaperTable rows={current.rows} matchedStrings={current.matchedStrings} ui={ui} />
              )}
              {current.view === "funding" && <FundingTable rows={current.rows} ui={ui} />}
              {current.view === "unattributed" &&
                (current.groups ? (
                  <UnattributedGroupTable groups={current.groups} ui={ui} />
                ) : (
                  <UnattributedTable rows={current.rows} ui={ui} />
                ))}
            </div>
            <Pager ui={ui} page={page} totalPages={totalPages} />
          </section>
        </>
      )}

      <MethodsSection doc={methods} />
    </div>
  );
}
