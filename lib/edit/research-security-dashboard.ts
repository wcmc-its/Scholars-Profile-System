/**
 * Research security dashboard (`/edit/research-security`) — feature flag and
 * URL parameters. Modelled on `lib/edit/data-sharing-dashboard.ts`.
 *
 * Audience: superuser or `research_security_viewer`
 * (`lib/auth/research-security-viewer.ts`); the gate itself is
 * `canViewDashboard(session, "research-security")` in
 * `lib/edit/dashboard-access.ts`. The page holds sensitive, per-person
 * screening results: nothing here is read by a public page.
 *
 * PURE MODULE: no db import, safe in any bundle.
 */

/** Whether the dashboard is enabled (off by default). When off the route and
 *  its export 404 and the sub-nav tab is hidden. */
export function isResearchSecurityDashboardEnabled(): boolean {
  return process.env.EDIT_RESEARCH_SECURITY_DASHBOARD === "on";
}

export const LIST_HOUSE = "house-1286-nominations";
export const LIST_USUAL = "usual-suspects";
export const LIST_COUNTRY = "country-of-concern";

/**
 * The list filter is single-choice ON PURPOSE. Country of concern is a far
 * broader net than the entity lists, so it is its own tier: it is counted only
 * when it is the list selected, and never in the same total as an entity list.
 * `entities` (the default) is the two entity lists together.
 */
export const LIST_FILTERS = ["entities", LIST_HOUSE, LIST_USUAL, LIST_COUNTRY] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export const LIST_FILTER_LABEL: Record<ListFilter, string> = {
  entities: "All listed entities",
  [LIST_HOUSE]: "House Select Committee nominations (Oct 2026)",
  [LIST_USUAL]: "Defense-affiliated institutions (curated)",
  [LIST_COUNTRY]: "Country of concern (broader tier)",
};

/** One line under the filter bar saying what the selected list is, so nobody
 *  has to scroll to Methods to read a count. */
export const LIST_FILTER_DESCRIPTION: Record<ListFilter, string> = {
  entities:
    "Both entity lists together: the House Select Committee nominations and the curated defense-affiliated institutions.",
  [LIST_HOUSE]:
    "The 134 entities the House Select Committee on the CCP nominated for the Section 1286 List in its letter of 2026-10-01. Nominations, not designations.",
  [LIST_USUAL]:
    "A short curated list: the Seven Sons of National Defence, defence universities and research academies, PLA medical universities and hospitals.",
  [LIST_COUNTRY]:
    "Any co-author affiliation in China (including Hong Kong and Macau), Russia, Iran, North Korea, Cuba or Venezuela. A far wider net than the entity lists; never added to an entity total.",
};

/** The `list_code` values a list filter reads. */
export function listCodesFor(list: ListFilter): string[] {
  return list === "entities" ? [LIST_HOUSE, LIST_USUAL] : [list];
}

export const CAMPUS_FILTERS = ["both", "wcm", "ithaca"] as const;
export type CampusFilter = (typeof CAMPUS_FILTERS)[number];
export const CAMPUS_LABEL: Record<"wcm" | "ithaca", string> = {
  wcm: "Weill Cornell Medicine",
  ithaca: "Cornell University",
};

/** A person row's campus as text. 'unknown' is a review-queue row with no
 *  proposed person: no campus is claimed for it. */
export function campusName(campus: string): string {
  if (campus === "unknown") return "Campus not assigned";
  return CAMPUS_LABEL[campus as "wcm" | "ithaca"] ?? campus;
}

export const RESEARCH_SECURITY_VIEWS = ["entity", "person", "paper", "funding", "unattributed"] as const;
export type ResearchSecurityView = (typeof RESEARCH_SECURITY_VIEWS)[number];
export const VIEW_LABEL: Record<ResearchSecurityView, string> = {
  entity: "By entity",
  person: "By person",
  paper: "By paper",
  funding: "Funding flags",
  unattributed: "Not yet attributed",
};

/** The workbook this dashboard replaces screened publications from this date. */
export const DEFAULT_DATE_FROM = "2021-01-01";
/** A paper with this many authors or more is a large consortium. */
export const CONSORTIUM_AUTHORS = 50;
export const PAGE_SIZE = 50;

export type ResearchSecurityFilters = {
  campus: CampusFilter;
  list: ListFilter;
  /** One category within the selected list(s); undefined = all. */
  category?: string;
  /** One entity (a country, in the country tier) within the selected list(s). */
  entity?: string;
  /** One of our people, by cwid: only the papers this person is on. */
  person?: string;
  /** Inclusive ISO dates on the publication date. */
  dateFrom: string;
  dateTo?: string;
  excludeConsortia: boolean;
};

export type ResearchSecurityUiParams = {
  view: ResearchSecurityView;
  /** 1-indexed. */
  page: number;
  filters: ResearchSecurityFilters;
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function isoDate(v: string | undefined): string | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

/** Parses the page's query string. Every value is optional and an invalid one
 *  falls back to its default, never an error: a typed URL is the only input. */
export function parseResearchSecurityParams(sp: RawParams): ResearchSecurityUiParams {
  const view = first(sp.view) as ResearchSecurityView;
  const list = first(sp.list) as ListFilter;
  const campus = first(sp.campus) as CampusFilter;
  const page = Number(first(sp.page));
  const category = first(sp.category)?.trim();
  const entity = first(sp.entity)?.trim();
  const person = first(sp.person)?.trim().toLowerCase();
  return {
    view: RESEARCH_SECURITY_VIEWS.includes(view) ? view : "entity",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    filters: {
      campus: CAMPUS_FILTERS.includes(campus) ? campus : "both",
      list: LIST_FILTERS.includes(list) ? list : "entities",
      category: category ? category.slice(0, 64) : undefined,
      entity: entity ? entity.slice(0, 160) : undefined,
      person: person && /^[a-z0-9_.-]{1,32}$/.test(person) ? person : undefined,
      dateFrom: isoDate(first(sp.from)) ?? DEFAULT_DATE_FROM,
      dateTo: isoDate(first(sp.to)),
      excludeConsortia: first(sp.consortia) === "exclude",
    },
  };
}

/**
 * Drops a category that the selected list does not have (`categories` is what
 * `loadCategories` returns for it). The filter form submits the old category
 * when only the list is changed; applied as it stands, every count would be 0
 * while the dropdown read "All categories". The page and the export both call
 * this BEFORE loading anything.
 */
export function withKnownCategory(
  f: ResearchSecurityFilters,
  categories: readonly string[],
): ResearchSecurityFilters {
  return f.category && !categories.includes(f.category) ? { ...f, category: undefined } : f;
}

/** The same rule for the entity filter: an entity the selected list (and
 *  category) does not have is dropped before anything is loaded. */
export function withKnownEntity(
  f: ResearchSecurityFilters,
  entities: readonly string[],
): ResearchSecurityFilters {
  return f.entity && !entities.includes(f.entity) ? { ...f, entity: undefined } : f;
}

export type FilterChip = {
  text: string;
  /** The filters with this one back at its default; absent when it already is. */
  without?: ResearchSecurityFilters;
};

/** The filters as chips under the headline tiles: every filter that changes a
 *  count is named, so no figure is read under a hidden one, and each one that
 *  is not at its default can be removed on its own. */
export function filterChips(f: ResearchSecurityFilters, personLabel?: string): FilterChip[] {
  const chips: FilterChip[] = [
    {
      text: f.campus === "both" ? "WCM and Cornell University" : CAMPUS_LABEL[f.campus],
      without: f.campus === "both" ? undefined : { ...f, campus: "both" },
    },
    {
      text: LIST_FILTER_LABEL[f.list],
      // The category and entity belong to the list, so they go with it.
      without:
        f.list === "entities"
          ? undefined
          : { ...f, list: "entities", category: undefined, entity: undefined },
    },
  ];
  if (f.category) chips.push({ text: `Category: ${f.category}`, without: { ...f, category: undefined } });
  if (f.entity)
    chips.push({
      text: `${f.list === LIST_COUNTRY ? "Country" : "Entity"}: ${f.entity}`,
      without: { ...f, entity: undefined },
    });
  if (f.person)
    chips.push({ text: `Person: ${personLabel ?? f.person}`, without: { ...f, person: undefined } });
  const defaultDates = f.dateFrom === DEFAULT_DATE_FROM && !f.dateTo;
  chips.push({
    text: `Published ${f.dateFrom}${defaultDates ? " (default)" : ""} to ${f.dateTo ?? "present"}`,
    without: defaultDates ? undefined : { ...f, dateFrom: DEFAULT_DATE_FROM, dateTo: undefined },
  });
  chips.push(
    f.excludeConsortia
      ? {
          text: `${CONSORTIUM_AUTHORS}+ author consortia excluded`,
          without: { ...f, excludeConsortia: false },
        }
      : { text: `${CONSORTIUM_AUTHORS}+ author consortia included` },
  );
  return chips;
}

/** The query string for a view + filters; defaults are left out. */
export function researchSecurityQuery(p: {
  view?: ResearchSecurityView;
  page?: number;
  filters: ResearchSecurityFilters;
}): string {
  const q = new URLSearchParams();
  if (p.view && p.view !== "entity") q.set("view", p.view);
  const f = p.filters;
  if (f.campus !== "both") q.set("campus", f.campus);
  if (f.list !== "entities") q.set("list", f.list);
  if (f.category) q.set("category", f.category);
  if (f.entity) q.set("entity", f.entity);
  if (f.person) q.set("person", f.person);
  if (f.dateFrom !== DEFAULT_DATE_FROM) q.set("from", f.dateFrom);
  if (f.dateTo) q.set("to", f.dateTo);
  if (f.excludeConsortia) q.set("consortia", "exclude");
  if (p.page && p.page > 1) q.set("page", String(p.page));
  const s = q.toString();
  return s ? `?${s}` : "";
}
