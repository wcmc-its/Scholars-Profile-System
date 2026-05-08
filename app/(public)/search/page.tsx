import * as React from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { ChevronDown } from "lucide-react";
import { JournalFacet } from "@/components/search/journal-facet";
import { PeopleResultCard } from "@/components/search/people-result-card";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { AZDirectory } from "@/components/browse/az-directory";
import { TaxonomyCallout } from "@/components/search/taxonomy-callout";
import {
  searchPeople,
  searchPublications,
  type ActivityFilter,
  type DeptDivBucket,
  type PeopleSort,
  type PublicationsSort,
  type SearchFacetBucket,
} from "@/lib/api/search";
import { getAZBuckets } from "@/lib/api/browse";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { formatRoleCategory } from "@/lib/role-display";
import { sanitizePubTitle } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // D-13: noindex but follow — preserves link equity through to profile pages.
  robots: { index: false, follow: true },
};

type SP = Promise<Record<string, string | string[] | undefined>>;

// Per-group OR'd repeated params (#9). Always returns an array; preserves
// order from the URL so chip-rendering matches what the user clicked.
function parseList(val: string | string[] | undefined): string[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const type = (Array.isArray(sp.type) ? sp.type[0] : sp.type) ?? "people";
  const rawPage = parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;
  const rawSort = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  const sort = rawSort ?? (q === "" && type === "publications" ? "year" : "relevance");

  const showAZ = q === "" && type === "people";
  const [azBuckets, taxonomyMatch] = await Promise.all([
    showAZ ? getAZBuckets() : Promise.resolve(null),
    q.trim().length >= 3
      ? matchQueryToTaxonomy(q)
      : Promise.resolve({ state: "none" as const }),
  ]);

  // People filters (multi-select).
  const deptDiv = parseList(sp.deptDiv);
  const personType = parseList(sp.personType);
  const activity = parseList(sp.activity).filter(
    (a): a is ActivityFilter => a === "has_grants" || a === "recent_pub",
  );

  // Pub filters.
  const yearMin = parseOptionalInt(sp.yearMin);
  const yearMax = parseOptionalInt(sp.yearMax);
  const publicationType =
    (Array.isArray(sp.publicationType) ? sp.publicationType[0] : sp.publicationType) ?? "";
  const journal = parseList(sp.journal);
  const wcmAuthorRole = parseList(sp.wcmAuthorRole).filter(
    (r): r is "first" | "senior" | "middle" =>
      r === "first" || r === "senior" || r === "middle",
  );

  // Issue #8 item 1: the subhead "{n} people · {n} publications" needs both
  // counts regardless of which tab is active. Run a lightweight count for
  // the inactive tab in parallel (size: 0 — facet aggs / pagination skipped).
  const [peopleResult, pubsResult] = await Promise.all([
    searchPeople({
      q,
      page: type === "people" ? page : 0,
      sort: type === "people" ? (sort as PeopleSort) : "relevance",
      filters: {
        deptDiv: deptDiv.length > 0 ? deptDiv : undefined,
        personType: personType.length > 0 ? personType : undefined,
        activity: activity.length > 0 ? activity : undefined,
      },
    }),
    searchPublications({
      q,
      page: type === "publications" ? page : 0,
      sort: type === "publications" ? (sort as PublicationsSort) : "relevance",
      filters: {
        yearMin,
        yearMax,
        publicationType: publicationType || undefined,
        journal: journal.length > 0 ? journal : undefined,
        wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
      },
    }),
  ]);

  return (
    <main>
      <SearchMeta q={q} peopleCount={peopleResult.total} pubCount={pubsResult.total} />
      <div className="mx-auto max-w-[1280px] px-6">
        <TaxonomyCallout result={taxonomyMatch} />
      </div>
      <ModeTabs
        q={q}
        activeType={type}
        peopleCount={peopleResult.total}
        pubCount={pubsResult.total}
      />
      {showAZ && azBuckets ? (
        <div className="mx-auto max-w-[1280px] px-6 pt-6">
          <AZDirectory buckets={azBuckets} />
          <div className="mt-2 text-right">
            <Link
              href="/browse"
              className="text-sm text-[var(--color-accent-slate)] hover:underline"
            >
              Or browse departments &amp; centers &#x2192;
            </Link>
          </div>
        </div>
      ) : null}
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-6 pt-6 pb-16 md:grid-cols-[240px_1fr]">
        {type === "publications" ? (
          <PublicationsResults
            q={q}
            page={page}
            sort={sort as PublicationsSort}
            yearMin={yearMin}
            yearMax={yearMax}
            publicationType={publicationType || undefined}
            journal={journal}
            wcmAuthorRole={wcmAuthorRole}
            result={pubsResult}
          />
        ) : (
          <PeopleResults
            q={q}
            page={page}
            sort={sort as PeopleSort}
            deptDiv={deptDiv}
            personType={personType}
            activity={activity}
            result={peopleResult}
          />
        )}
      </div>
    </main>
  );
}

function parseOptionalInt(val: string | string[] | undefined): number | undefined {
  const s = Array.isArray(val) ? val[0] : val;
  if (s === undefined || s === "") return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Stable sort that pulls active items to the front so they survive the
 * `collapseAfter` cutoff in FacetGroup. Keeps the original order (count-
 * desc) inside each partition.
 */
function sortActiveFirst<T>(items: T[], isActive: (t: T) => boolean): T[] {
  const active: T[] = [];
  const rest: T[] = [];
  for (const it of items) (isActive(it) ? active : rest).push(it);
  return [...active, ...rest];
}

/* ============================================================
 * Search-meta strip — h1 with quoted query span + counts subhead
 * ============================================================ */
function SearchMeta({
  q,
  peopleCount,
  pubCount,
}: {
  q: string;
  peopleCount: number;
  pubCount: number;
}) {
  return (
    <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
      <h1 className="mb-1 text-[28px] font-bold leading-tight tracking-[-0.01em]">
        {q ? (
          <>
            Results for{" "}
            <span className="font-bold text-[#2c4f6e]">{"“"}{q}{"”"}</span>
          </>
        ) : (
          "Browse scholars"
        )}
      </h1>
      <div className="text-[13px] text-[#757575]">
        {peopleCount.toLocaleString()} {peopleCount === 1 ? "person" : "people"} ·{" "}
        {pubCount.toLocaleString()} publications
      </div>
    </div>
  );
}

/* ============================================================
 * Mode tabs — slate accent with count pills
 * ============================================================ */
function ModeTabs({
  q,
  activeType,
  peopleCount,
  pubCount,
}: {
  q: string;
  activeType: string;
  peopleCount: number;
  pubCount: number;
}) {
  const peopleHref = `/search?${new URLSearchParams({ q, type: "people" }).toString()}`;
  const pubHref = `/search?${new URLSearchParams({ q, type: "publications" }).toString()}`;
  return (
    <nav className="mx-auto flex max-w-[1280px] gap-1 border-b border-[#e3e2dd] px-6">
      <ModeTab href={peopleHref} label="People" count={peopleCount} active={activeType === "people"} />
      <ModeTab href={pubHref} label="Publications" count={pubCount} active={activeType === "publications"} />
    </nav>
  );
}

function ModeTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`-mb-px inline-flex h-[42px] items-center gap-2 border-b-2 px-4 text-[13px] transition-colors ${
        active
          ? "border-[#2c4f6e] font-semibold text-[#2c4f6e]"
          : "border-transparent font-medium text-[#4a4a4a] hover:text-[#1a1a1a]"
      }`}
    >
      {label}
      <span
        className={`inline-flex h-5 min-w-[28px] items-center justify-center rounded-full px-1.5 text-[11px] font-medium ${
          active ? "bg-[#eaf0f5] text-[#2c4f6e]" : "bg-[#f7f6f3] text-[#757575]"
        }`}
      >
        {count.toLocaleString()}
      </span>
    </Link>
  );
}

/* ============================================================
 * People tab content
 * ============================================================ */
type PeopleResultData = Awaited<ReturnType<typeof searchPeople>>;
type PubsResultData = Awaited<ReturnType<typeof searchPublications>>;

async function PeopleResults({
  q,
  page,
  sort,
  deptDiv,
  personType,
  activity,
  result,
}: {
  q: string;
  page: number;
  sort: PeopleSort;
  deptDiv: string[];
  personType: string[];
  activity: ActivityFilter[];
  result: PeopleResultData;
}) {
  // Two URL builders share one base. `resetPage` is true for any link that
  // changes the result set (toggle a facet, change sort, swap tab) — those
  // should land on page 0. Pagination links pass `resetPage: false` so the
  // mutator's `sp.set("page", N)` actually survives.
  const buildUrl = (
    mut: (sp: URLSearchParams) => void,
    { resetPage = true }: { resetPage?: boolean } = {},
  ) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "people");
    if (sort !== "relevance") sp.set("sort", sort);
    for (const v of deptDiv) sp.append("deptDiv", v);
    for (const v of personType) sp.append("personType", v);
    for (const v of activity) sp.append("activity", v);
    if (resetPage) sp.delete("page");
    mut(sp);
    return `/search?${sp.toString()}`;
  };

  const toggleHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      if (current.includes(value)) {
        for (const v of current) if (v !== value) sp.append(axis, v);
      } else {
        for (const v of current) sp.append(axis, v);
        sp.append(axis, value);
      }
    });

  const removeHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      for (const v of current) if (v !== value) sp.append(axis, v);
    });

  const clearAllHref = `/search?${new URLSearchParams({ q, type: "people" }).toString()}`;

  // One chip per selected value. Labels resolved from the facet buckets
  // when available (deptDiv keys are opaque codes), else humanized.
  const labelByDeptDiv = new Map(
    result.facets.deptDivs.map((b) => [b.value, b.label]),
  );
  const chips: Array<{ label: string; removeHref: string }> = [];
  for (const v of personType) {
    chips.push({
      label: formatRoleCategory(v) ?? v,
      removeHref: removeHref("personType", v),
    });
  }
  for (const v of deptDiv) {
    chips.push({
      label: labelByDeptDiv.get(v) ?? v,
      removeHref: removeHref("deptDiv", v),
    });
  }
  for (const v of activity) {
    chips.push({
      label: v === "has_grants" ? "Has active grants" : "Published in last 2 years",
      removeHref: removeHref("activity", v),
    });
  }

  const hasActiveFilters = chips.length > 0;

  return (
    <>
      <FacetSidebar
        deptDivs={result.facets.deptDivs}
        personTypes={result.facets.personTypes}
        activity={result.facets.activity}
        activeDeptDiv={deptDiv}
        activePersonType={personType}
        activeActivity={activity}
        toggleHref={toggleHref}
        clearAllHref={clearAllHref}
        hasActiveFilters={hasActiveFilters}
      />
      <section>
        {chips.length > 0 ? (
          <ActiveFilterChips chips={chips} clearAllHref={clearAllHref} />
        ) : null}
        <ResultsToolbar
          tab="people"
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={sort}
          hasActiveFilters={hasActiveFilters}
          buildSortHref={(value) =>
            buildUrl((sp) => {
              if (value === "relevance") sp.delete("sort");
              else sp.set("sort", value);
            })
          }
        />
        {result.hits.length === 0 ? (
          <EmptyState
            query={q}
            tip={hasActiveFilters ? "Try clearing filters." : "Try a broader search term, or browse by department."}
          />
        ) : (
          <ul className="flex flex-col">
            {result.hits.map((h, i) => (
              <li key={h.cwid}>
                <PeopleResultCard
                  hit={h}
                  position={page * result.pageSize + i}
                  q={q}
                  total={result.total}
                  filters={{ deptDiv, personType, activity }}
                />
              </li>
            ))}
          </ul>
        )}
        <Pagination
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          buildHref={(p) =>
            buildUrl(
              (sp) => {
                if (p > 0) sp.set("page", String(p));
                else sp.delete("page");
              },
              { resetPage: false },
            )
          }
        />
      </section>
    </>
  );
}

/* ============================================================
 * Publications tab — single-select today (no facet rewrite)
 * ============================================================ */
async function PublicationsResults({
  q,
  page,
  sort,
  yearMin,
  yearMax,
  publicationType,
  journal,
  wcmAuthorRole,
  result,
}: {
  q: string;
  page: number;
  sort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
  publicationType?: string;
  journal: string[];
  wcmAuthorRole: Array<"first" | "senior" | "middle">;
  result: PubsResultData;
}) {
  const buildUrl = (
    mut: (sp: URLSearchParams) => void,
    { resetPage = true }: { resetPage?: boolean } = {},
  ) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "publications");
    if (sort !== "relevance") sp.set("sort", sort);
    if (yearMin !== undefined) sp.set("yearMin", String(yearMin));
    if (yearMax !== undefined) sp.set("yearMax", String(yearMax));
    if (publicationType) sp.set("publicationType", publicationType);
    for (const v of journal) sp.append("journal", v);
    for (const v of wcmAuthorRole) sp.append("wcmAuthorRole", v);
    if (resetPage) sp.delete("page");
    mut(sp);
    return `/search?${sp.toString()}`;
  };

  // Toggle a value in/out of a multi-value group, preserving repeated keys.
  const toggleHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      if (current.includes(value)) {
        for (const v of current) if (v !== value) sp.append(axis, v);
      } else {
        for (const v of current) sp.append(axis, v);
        sp.append(axis, value);
      }
    });

  const removeMulti = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      for (const v of current) if (v !== value) sp.append(axis, v);
    });

  const clearAllHref = `/search?${new URLSearchParams({ q, type: "publications" }).toString()}`;

  const ROLE_LABEL: Record<"first" | "senior" | "middle", string> = {
    first: "First author",
    senior: "Senior author",
    middle: "Middle author",
  };

  const chips: Array<{ label: string; removeHref: string }> = [];
  if (yearMin !== undefined || yearMax !== undefined) {
    let label: string;
    if (yearMin !== undefined && yearMax !== undefined) {
      label = yearMin === yearMax ? `${yearMin}` : `${yearMin}–${yearMax}`;
    } else if (yearMin !== undefined) {
      label = `Since ${yearMin}`;
    } else {
      label = `Through ${yearMax}`;
    }
    chips.push({
      label,
      removeHref: buildUrl((sp) => {
        sp.delete("yearMin");
        sp.delete("yearMax");
      }),
    });
  }
  if (publicationType) {
    chips.push({
      label: publicationType,
      removeHref: buildUrl((sp) => sp.delete("publicationType")),
    });
  }
  for (const v of wcmAuthorRole) {
    chips.push({ label: ROLE_LABEL[v], removeHref: removeMulti("wcmAuthorRole", v) });
  }
  for (const v of journal) {
    chips.push({ label: v, removeHref: removeMulti("journal", v) });
  }

  return (
    <>
      <FacetSidebarPubs
        yearMin={yearMin}
        activePublicationType={publicationType}
        publicationTypes={result.facets.publicationTypes}
        journals={result.facets.journals}
        activeJournals={journal}
        wcmAuthorRoleCounts={result.facets.wcmAuthorRoles}
        activeWcmAuthorRole={wcmAuthorRole}
        toggleHref={toggleHref}
        buildHref={(overrides) => buildUrl((sp) => {
          for (const [k, v] of Object.entries(overrides)) {
            if (v === "") sp.delete(k);
            else sp.set(k, v);
          }
        })}
        hasActiveFilters={chips.length > 0}
        clearAllHref={clearAllHref}
      />
      <section>
        {chips.length > 0 ? (
          <ActiveFilterChips chips={chips} clearAllHref={clearAllHref} />
        ) : null}
        <ResultsToolbar
          tab="publications"
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={sort}
          hasActiveFilters={chips.length > 0}
          buildSortHref={(value) =>
            buildUrl((sp) => {
              if (value === "relevance") sp.delete("sort");
              else sp.set("sort", value);
            })
          }
        />
        {result.hits.length === 0 ? (
          <EmptyState
            query={q}
            tip="Try removing the year filter, or search a different phrase."
          />
        ) : (
          <ul>
            {result.hits.map((h) => {
              const titleHtml = sanitizePubTitle(h.title);
              return (
                <li key={h.pmid} className="border-b border-[#e3e2dd] py-5">
                  <div className="mb-2 text-[16px] font-semibold leading-snug">
                    {h.pubmedUrl ? (
                      <a
                        href={h.pubmedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#1a1a1a] hover:text-[#2c4f6e] hover:no-underline"
                        dangerouslySetInnerHTML={{ __html: titleHtml }}
                      />
                    ) : (
                      <span dangerouslySetInnerHTML={{ __html: titleHtml }} />
                    )}
                  </div>
                  <div className="mb-2 text-[13px] leading-snug text-[#4a4a4a]">
                    {h.journal ? <em className="not-italic">{h.journal}</em> : null}
                    {h.journal && h.year ? ". " : null}
                    {h.year ?? null}.
                  </div>
                  <AuthorChipRow authors={h.wcmAuthors} />
                  <div className="mt-2 flex gap-3 text-xs text-[#757575]">
                    {h.citationCount > 0 ? (
                      <span className="font-medium text-[#4a4a4a]">{h.citationCount} citations</span>
                    ) : null}
                    {h.doi ? (
                      <a
                        href={`https://doi.org/${h.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2 hover:text-[#2c4f6e]"
                      >
                        DOI
                      </a>
                    ) : null}
                    {h.pubmedUrl ? (
                      <a
                        href={h.pubmedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2 hover:text-[#2c4f6e]"
                      >
                        PubMed
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Pagination
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          buildHref={(p) =>
            buildUrl(
              (sp) => {
                if (p > 0) sp.set("page", String(p));
                else sp.delete("page");
              },
              { resetPage: false },
            )
          }
        />
      </section>
    </>
  );
}

/* ============================================================
 * Active filter chips — one chip per selected value
 * ============================================================ */
function ActiveFilterChips({
  chips,
  clearAllHref,
}: {
  chips: Array<{ label: string; removeHref: string }>;
  clearAllHref: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <Link
          key={`${c.label}-${c.removeHref}`}
          href={c.removeHref}
          aria-label={`Remove filter: ${c.label}`}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-[#c5d3df] bg-[#eaf0f5] py-0 pl-3 pr-1.5 text-xs font-medium text-[#2c4f6e] no-underline transition-colors hover:border-[#9fb6c9] hover:bg-[#dde7f0] hover:no-underline"
        >
          <span>{c.label}</span>
          <span
            aria-hidden="true"
            className="ml-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[14px] leading-none text-[#2c4f6e] hover:bg-[#2c4f6e]/15"
          >
            ×
          </span>
        </Link>
      ))}
      <Link href={clearAllHref} className="ml-1 text-xs text-[#757575] hover:text-[#2c4f6e]">
        Clear all
      </Link>
    </div>
  );
}

/* ============================================================
 * Results toolbar — left: count line; right: sort dropdown
 * ============================================================ */
function ResultsToolbar({
  tab,
  total,
  page,
  pageSize,
  sort,
  buildSortHref,
  hasActiveFilters,
}: {
  tab: "people" | "publications";
  total: number;
  page: number;
  pageSize: number;
  sort: PeopleSort | PublicationsSort;
  buildSortHref: (value: string) => string;
  hasActiveFilters: boolean;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  // "matching filters" only when at least one facet is active. Without
  // filters, the qualifier reads like the count is filtered when it isn't.
  const noun = tab === "people"
    ? `${total === 1 ? "person" : "people"}${hasActiveFilters ? " matching filters" : ""}`
    : "publications";

  const peopleOpts: Array<{ value: PeopleSort; label: string }> = [
    { value: "relevance", label: "Relevance" },
    { value: "lastname", label: "Last name (A–Z)" },
    { value: "recentPub", label: "Most recent publication" },
  ];
  const pubOpts: Array<{ value: PublicationsSort; label: string }> = [
    { value: "relevance", label: "Relevance" },
    { value: "year", label: "Year (newest)" },
    { value: "citations", label: "Citation count" },
  ];
  const opts = tab === "people" ? peopleOpts : pubOpts;

  return (
    <div className="mb-2 flex items-center border-b border-[#e3e2dd] pb-3 text-[13px] text-[#757575]">
      {total > 0 ? (
        <span>
          Showing {start}–{end} of{" "}
          <strong className="font-semibold text-[#4a4a4a]">{total.toLocaleString()}</strong> {noun}
        </span>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-2 text-[#4a4a4a]">
        Sort:
        <SortLinks current={sort} options={opts} buildSortHref={buildSortHref} />
      </span>
    </div>
  );
}

// Server-rendered sort selector — render the active option as the visible
// label, the rest as a small dropdown of links via <details>. Native
// behavior, no client JS, accessible by keyboard.
function SortLinks({
  current,
  options,
  buildSortHref,
}: {
  current: string;
  options: Array<{ value: string; label: string }>;
  buildSortHref: (value: string) => string;
}) {
  const activeLabel = options.find((o) => o.value === current)?.label ?? options[0].label;
  return (
    <details className="relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e] [&::-webkit-details-marker]:hidden">
        {activeLabel}
        <ChevronDown aria-hidden className="h-3.5 w-3.5 text-[#757575]" strokeWidth={2} />
      </summary>
      <ul className="absolute right-0 top-full z-20 mt-1 min-w-[180px] rounded-md border border-[#e3e2dd] bg-white py-1 shadow-md">
        {options.map((o) => (
          <li key={o.value}>
            <Link
              href={buildSortHref(o.value)}
              className={`block px-3 py-1.5 text-[13px] hover:bg-[#fafaf8] ${
                o.value === current ? "font-semibold text-[#2c4f6e]" : "text-[#1a1a1a]"
              }`}
            >
              {o.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ============================================================
 * Sidebar — checkbox-style facet lists
 * ============================================================ */
function FacetSidebar({
  deptDivs,
  personTypes,
  activity,
  activeDeptDiv,
  activePersonType,
  activeActivity,
  toggleHref,
  clearAllHref,
  hasActiveFilters,
}: {
  deptDivs: DeptDivBucket[];
  personTypes: SearchFacetBucket[];
  activity: { hasGrants: number; recentPub: number };
  activeDeptDiv: string[];
  activePersonType: string[];
  activeActivity: ActivityFilter[];
  toggleHref: (axis: string, value: string) => string;
  clearAllHref: string;
  hasActiveFilters: boolean;
}) {
  return (
    <aside className="text-[13px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#757575]">
          Filters
        </span>
        {hasActiveFilters ? (
          <Link href={clearAllHref} className="text-xs font-medium text-[#2c4f6e] hover:underline">
            Clear all
          </Link>
        ) : null}
      </div>

      {personTypes.length > 0 ? (
        <FacetGroup label="Person type" collapseAfter={5}>
          {sortActiveFirst(personTypes, (p) => activePersonType.includes(p.value)).map((p) => (
            <FacetCheckbox
              key={p.value}
              label={formatRoleCategory(p.value) ?? p.value}
              count={p.count}
              isActive={activePersonType.includes(p.value)}
              href={toggleHref("personType", p.value)}
            />
          ))}
        </FacetGroup>
      ) : null}

      {deptDivs.length > 0 ? (
        <FacetGroup label="Department / division" collapseAfter={5}>
          {sortActiveFirst(deptDivs, (d) => activeDeptDiv.includes(d.value)).map((d) => (
            <FacetCheckbox
              key={d.value}
              label={d.label}
              count={d.count}
              isActive={activeDeptDiv.includes(d.value)}
              href={toggleHref("deptDiv", d.value)}
            />
          ))}
        </FacetGroup>
      ) : null}

      <FacetGroup label="Activity">
        <FacetCheckbox
          label="Has active grants"
          count={activity.hasGrants}
          isActive={activeActivity.includes("has_grants")}
          href={toggleHref("activity", "has_grants")}
        />
        <FacetCheckbox
          label="Published in last 2 years"
          count={activity.recentPub}
          isActive={activeActivity.includes("recent_pub")}
          href={toggleHref("activity", "recent_pub")}
        />
      </FacetGroup>
    </aside>
  );
}

function FacetSidebarPubs({
  yearMin,
  activePublicationType,
  publicationTypes,
  journals,
  activeJournals,
  wcmAuthorRoleCounts,
  activeWcmAuthorRole,
  toggleHref,
  buildHref,
  hasActiveFilters,
  clearAllHref,
}: {
  yearMin?: number;
  activePublicationType?: string;
  publicationTypes: SearchFacetBucket[];
  journals: SearchFacetBucket[];
  activeJournals: string[];
  wcmAuthorRoleCounts: { first: number; senior: number; middle: number };
  activeWcmAuthorRole: Array<"first" | "senior" | "middle">;
  toggleHref: (axis: string, value: string) => string;
  buildHref: (overrides: Record<string, string>) => string;
  hasActiveFilters: boolean;
  clearAllHref: string;
}) {
  const yearChoices = [2024, 2020, 2015, 2010];
  return (
    <aside className="text-[13px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#757575]">
          Filters
        </span>
        {hasActiveFilters ? (
          <Link href={clearAllHref} className="text-xs font-medium text-[#2c4f6e] hover:underline">
            Clear all
          </Link>
        ) : null}
      </div>

      {/* WCM author role first — it's the highest-signal pub filter
          for promotion/recruiting use cases. */}
      <FacetGroup label="WCM author role">
        <FacetCheckbox
          label="First author"
          count={wcmAuthorRoleCounts.first}
          isActive={activeWcmAuthorRole.includes("first")}
          href={toggleHref("wcmAuthorRole", "first")}
        />
        <FacetCheckbox
          label="Senior author"
          count={wcmAuthorRoleCounts.senior}
          isActive={activeWcmAuthorRole.includes("senior")}
          href={toggleHref("wcmAuthorRole", "senior")}
        />
        <FacetCheckbox
          label="Middle author"
          count={wcmAuthorRoleCounts.middle}
          isActive={activeWcmAuthorRole.includes("middle")}
          href={toggleHref("wcmAuthorRole", "middle")}
        />
      </FacetGroup>

      <FacetGroup label="Year (since)">
        {yearChoices.map((y) => (
          <FacetCheckbox
            key={y}
            label={`${y}–present`}
            isActive={yearMin === y}
            href={buildHref({ yearMin: yearMin === y ? "" : String(y) })}
          />
        ))}
      </FacetGroup>

      {journals.length > 0 ? (
        <JournalFacet
          journals={journals}
          activeJournals={activeJournals}
          toggleHref={toggleHref}
        />
      ) : null}

      {publicationTypes.length > 0 ? (
        <FacetGroup label="Publication type" collapseAfter={5}>
          {publicationTypes.map((p) => (
            <FacetCheckbox
              key={p.value}
              label={p.value}
              count={p.count}
              isActive={p.value === activePublicationType}
              href={buildHref({
                publicationType: p.value === activePublicationType ? "" : p.value,
              })}
            />
          ))}
        </FacetGroup>
      ) : null}
    </aside>
  );
}

/**
 * Sidebar facet group. When `collapseAfter` is set and the group has more
 * than that many items, the tail is hidden inside a native <details> with
 * a "Show all N" toggle. We split children into a head and tail server-
 * side so the cap is consistent regardless of viewport width.
 *
 * Two practical notes:
 *   - The toggle uses native <details>, no client JS, so it stays open
 *     on the same render. Navigation away (clicking a checkbox) collapses
 *     it — but the caller is expected to sort buckets so currently-active
 *     values appear in the head, so the user never has to re-expand to
 *     see what they ticked.
 *   - The summary marker is suppressed in favor of a Lucide chevron for
 *     visual consistency with the rest of the page.
 */
function FacetGroup({
  label,
  children,
  collapseAfter,
}: {
  label: string;
  children: React.ReactNode;
  collapseAfter?: number;
}) {
  const items = React.Children.toArray(children);
  const shouldCollapse =
    collapseAfter !== undefined && items.length > collapseAfter;
  const head = shouldCollapse ? items.slice(0, collapseAfter!) : items;
  const tail = shouldCollapse ? items.slice(collapseAfter!) : [];
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[13px] font-semibold text-[#1a1a1a]">{label}</h3>
      <ul className="m-0 flex list-none flex-col p-0">{head}</ul>
      {tail.length > 0 ? (
        // Tailwind 4 lacks `group-open:` directly; arbitrary descendant
        // variants (`[&[open]_.x]:hidden`) compile to
        // `details[open] .x { display: none }` and let the open/closed
        // labels swap without any client JS.
        <details
          className="mt-1 [&[open]_.fg-show]:hidden [&:not([open])_.fg-hide]:hidden [&[open]_.fg-chevron]:rotate-180"
        >
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden
              className="fg-chevron h-3.5 w-3.5 transition-transform"
              strokeWidth={2}
            />
            <span className="fg-show">Show all {items.length}</span>
            <span className="fg-hide">Show fewer</span>
          </summary>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">{tail}</ul>
        </details>
      ) : null}
    </div>
  );
}

function FacetCheckbox({
  label,
  count,
  isActive,
  href,
}: {
  label: string;
  count?: number;
  isActive?: boolean;
  href: string;
}) {
  return (
    <li className="flex items-center gap-2 py-1 leading-[1.4]">
      <Link
        href={href}
        title={label}
        className="flex flex-1 items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
      >
        {/* readOnly checkbox: state lives in the URL; the link toggles it. */}
        <input
          type="checkbox"
          readOnly
          checked={!!isActive}
          tabIndex={-1}
          aria-hidden="true"
          className="cursor-pointer accent-[#2c4f6e]"
        />
        {/* Truncate keeps the count column straight when names are long
            ("Pathology and Laboratory Medicine"); the title attribute on
            the parent surfaces the full label on hover. */}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined ? (
          <span className="shrink-0 text-[12px] tabular-nums text-[#757575]">
            {count.toLocaleString()}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/* ============================================================
 * Empty state + Pagination (with ellipsis)
 * ============================================================ */
function EmptyState({ query, tip }: { query: string; tip: string }) {
  return (
    <div className="mt-12 flex flex-col items-center text-center">
      <div className="text-lg font-medium">No results{query ? ` for "${query}"` : ""}</div>
      <div className="mt-1 text-sm text-[#757575]">{tip}</div>
    </div>
  );
}

function Pagination({
  page,
  total,
  pageSize,
  buildHref,
}: {
  page: number;
  total: number;
  pageSize: number;
  buildHref: (p: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  // Always include first + last; ellipsis when the window doesn't reach them.
  const window = new Set<number>();
  window.add(0);
  window.add(totalPages - 1);
  for (let p = page - 1; p <= page + 1; p++) {
    if (p >= 0 && p < totalPages) window.add(p);
  }
  // Fill so the first 5 pages (or last 5) render densely without ellipsis.
  for (let p = 0; p < Math.min(5, totalPages); p++) window.add(p);
  for (let p = Math.max(0, totalPages - 5); p < totalPages; p++) window.add(p);

  const sorted = [...window].sort((a, b) => a - b);

  type Cell = { kind: "page"; n: number } | { kind: "ellipsis"; key: string };
  const cells: Cell[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) {
      cells.push({ kind: "ellipsis", key: `e-${sorted[i - 1]}-${sorted[i]}` });
    }
    cells.push({ kind: "page", n: sorted[i] });
  }

  return (
    <nav
      className="mt-8 flex items-center justify-center gap-1 pt-6"
      aria-label="Pagination"
    >
      <PaginationButton
        href={page > 0 ? buildHref(page - 1) : null}
        label="‹ Prev"
      />
      {cells.map((c) =>
        c.kind === "ellipsis" ? (
          <span key={c.key} className="px-1 text-[13px] text-[#757575]">
            …
          </span>
        ) : (
          <PaginationButton
            key={c.n}
            href={buildHref(c.n)}
            label={String(c.n + 1)}
            active={c.n === page}
          />
        ),
      )}
      <PaginationButton
        href={page < totalPages - 1 ? buildHref(page + 1) : null}
        label="Next ›"
      />
    </nav>
  );
}

function PaginationButton({
  href,
  label,
  active,
}: {
  href: string | null;
  label: string;
  active?: boolean;
}) {
  const base =
    "inline-flex h-8 min-w-[32px] items-center justify-center rounded-sm border px-2 text-[13px] no-underline transition-colors";
  if (!href) {
    return (
      <span className={`${base} cursor-not-allowed border-[#e3e2dd] bg-white text-[#c8c6be]`}>
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={
        active
          ? `${base} border-[#2c4f6e] bg-[#2c4f6e] font-medium text-white`
          : `${base} border-[#c8c6be] bg-white text-[#4a4a4a] hover:border-[#2c4f6e] hover:text-[#2c4f6e]`
      }
    >
      {label}
    </Link>
  );
}
