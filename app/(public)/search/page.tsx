import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PeopleResultCard } from "@/components/search/people-result-card";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
  type SearchFacetBucket,
} from "@/lib/api/search";
import { formatRoleCategory } from "@/lib/role-display";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // D-13: noindex but follow — preserves link equity through to profile pages.
  // No canonical tag (page is intentionally non-canonical).
  robots: { index: false, follow: true },
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const type = (Array.isArray(sp.type) ? sp.type[0] : sp.type) ?? "people";
  const rawPage = parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;
  const sort = (Array.isArray(sp.sort) ? sp.sort[0] : sp.sort) ?? "relevance";

  const department = (Array.isArray(sp.department) ? sp.department[0] : sp.department) ?? "";
  const personType = (Array.isArray(sp.personType) ? sp.personType[0] : sp.personType) ?? "";
  const hasGrantsParam = Array.isArray(sp.hasActiveGrants) ? sp.hasActiveGrants[0] : sp.hasActiveGrants;
  const hasActiveGrants = hasGrantsParam === undefined ? undefined : hasGrantsParam === "true";

  const yearMin = parseOptionalInt(sp.yearMin);
  const yearMax = parseOptionalInt(sp.yearMax);
  const publicationType =
    (Array.isArray(sp.publicationType) ? sp.publicationType[0] : sp.publicationType) ?? "";

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold">
        {q ? `Results for "${q}"` : "Browse scholars"}
      </h1>
      <SearchTabs q={q} activeType={type} />
      <div className="mt-6 grid grid-cols-1 gap-8 md:grid-cols-[220px_1fr]">
        {type === "publications" ? (
          <PublicationsResults
            q={q}
            page={page}
            sort={sort as PublicationsSort}
            yearMin={yearMin}
            yearMax={yearMax}
            publicationType={publicationType || undefined}
          />
        ) : (
          <PeopleResults
            q={q}
            page={page}
            sort={sort as PeopleSort}
            department={department || undefined}
            personType={personType || undefined}
            hasActiveGrants={hasActiveGrants}
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

function SearchTabs({ q, activeType }: { q: string; activeType: string }) {
  const peopleHref = `/search?${new URLSearchParams({ q, type: "people" }).toString()}`;
  const pubHref = `/search?${new URLSearchParams({ q, type: "publications" }).toString()}`;
  const baseClass =
    "px-4 py-2 text-sm font-medium border-b-2 transition-colors";
  const activeClass = "border-primary text-foreground";
  const inactiveClass = "border-transparent text-muted-foreground hover:text-foreground";
  return (
    <div className="border-border flex gap-2 border-b">
      <Link
        href={peopleHref}
        className={`${baseClass} ${activeType === "people" ? activeClass : inactiveClass}`}
      >
        People
      </Link>
      <Link
        href={pubHref}
        className={`${baseClass} ${activeType === "publications" ? activeClass : inactiveClass}`}
      >
        Publications
      </Link>
    </div>
  );
}

async function PeopleResults({
  q,
  page,
  sort,
  department,
  personType,
  hasActiveGrants,
}: {
  q: string;
  page: number;
  sort: PeopleSort;
  department?: string;
  personType?: string;
  hasActiveGrants?: boolean;
}) {
  const result = await searchPeople({
    q,
    page,
    sort,
    filters: { department, personType, hasActiveGrants },
  });

  return (
    <>
      <aside>
        <FacetSidebar
          query={q}
          activeType="people"
          activeSort={sort}
          activeDepartment={department}
          activePersonType={personType}
          activeHasGrants={hasActiveGrants}
          departments={result.facets.departments}
          personTypes={result.facets.personTypes}
        />
      </aside>
      <section>
        <ActiveFilterChips
          chips={buildPeopleChips({ q, sort, department, personType, hasActiveGrants })}
          clearAllHref={`/search?${new URLSearchParams({ q, type: "people" }).toString()}`}
        />
        <ResultsHeader
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
        />
        {result.hits.length === 0 ? (
          <EmptyState
            query={q}
            tip={
              department || personType || hasActiveGrants !== undefined
                ? "Try clearing filters."
                : "Try a broader search term, or browse by department."
            }
          />
        ) : (
          <ul className="mt-4 flex flex-col gap-1 divide-y divide-zinc-200 dark:divide-zinc-800">
            {result.hits.map((h, i) => (
              <li key={h.cwid}>
                <PeopleResultCard
                  hit={h}
                  position={page * result.pageSize + i}
                  q={q}
                  total={result.total}
                  filters={{
                    department: department || undefined,
                    personType: personType || undefined,
                    hasActiveGrants,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <Pagination
          q={q}
          type="people"
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          extra={{
            sort,
            ...(department ? { department } : {}),
            ...(personType ? { personType } : {}),
            ...(hasActiveGrants !== undefined
              ? { hasActiveGrants: String(hasActiveGrants) }
              : {}),
          }}
        />
      </section>
    </>
  );
}

async function PublicationsResults({
  q,
  page,
  sort,
  yearMin,
  yearMax,
  publicationType,
}: {
  q: string;
  page: number;
  sort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
  publicationType?: string;
}) {
  const result = await searchPublications({
    q,
    page,
    sort,
    filters: { yearMin, yearMax, publicationType },
  });

  return (
    <>
      <aside>
        <FacetSidebarPubs
          query={q}
          activeSort={sort}
          yearMin={yearMin}
          yearMax={yearMax}
          activePublicationType={publicationType}
          publicationTypes={result.facets.publicationTypes}
        />
      </aside>
      <section>
        <ActiveFilterChips
          chips={buildPublicationsChips({ q, sort, yearMin, yearMax, publicationType })}
          clearAllHref={`/search?${new URLSearchParams({ q, type: "publications" }).toString()}`}
        />
        <ResultsHeader
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
        />
        {result.hits.length === 0 ? (
          <EmptyState
            query={q}
            tip="Try removing the year filter, or search a different phrase."
          />
        ) : (
          <ul className="mt-4 flex flex-col gap-1 divide-y divide-zinc-200 dark:divide-zinc-800">
            {result.hits.map((h) => (
              <li key={h.pmid} className="py-4">
                <div className="font-medium leading-snug">
                  {h.pubmedUrl ? (
                    <a
                      href={h.pubmedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {h.title}
                    </a>
                  ) : (
                    h.title
                  )}
                </div>
                {h.wcmAuthors.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {h.wcmAuthors.map((a) => (
                      <Link
                        key={a.cwid}
                        href={`/scholars/${a.slug}`}
                        className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                      >
                        {a.preferredName}
                      </Link>
                    ))}
                  </div>
                ) : null}
                <div className="text-muted-foreground mt-1 text-xs">
                  {h.externalAuthors}
                </div>
                <div className="text-muted-foreground mt-1 text-xs">
                  {h.journal} · {h.year}
                  {h.publicationType ? ` · ${h.publicationType}` : ""}
                  {h.citationCount > 0 ? ` · ${h.citationCount} citations` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pagination
          q={q}
          type="publications"
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          extra={{
            sort,
            ...(yearMin !== undefined ? { yearMin: String(yearMin) } : {}),
            ...(yearMax !== undefined ? { yearMax: String(yearMax) } : {}),
            ...(publicationType ? { publicationType } : {}),
          }}
        />
      </section>
    </>
  );
}

type ChipSpec = { label: string; removeHref: string };

function ActiveFilterChips({
  chips,
  clearAllHref,
}: {
  chips: ChipSpec[];
  clearAllHref: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <Link
          key={c.label}
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
      {chips.length > 1 ? (
        <Link
          href={clearAllHref}
          className="ml-1 text-xs text-zinc-500 hover:text-[#2c4f6e]"
        >
          Clear all
        </Link>
      ) : null}
    </div>
  );
}

function buildPeopleChips({
  q,
  sort,
  department,
  personType,
  hasActiveGrants,
}: {
  q: string;
  sort: PeopleSort;
  department?: string;
  personType?: string;
  hasActiveGrants?: boolean;
}): ChipSpec[] {
  const baseEntries = (omit: string): Array<[string, string]> => {
    const entries: Array<[string, string]> = [["q", q], ["type", "people"]];
    if (sort !== "relevance") entries.push(["sort", sort]);
    if (department && omit !== "department") entries.push(["department", department]);
    if (personType && omit !== "personType") entries.push(["personType", personType]);
    if (hasActiveGrants !== undefined && omit !== "hasActiveGrants") {
      entries.push(["hasActiveGrants", String(hasActiveGrants)]);
    }
    return entries;
  };
  const hrefWithout = (key: string) =>
    `/search?${new URLSearchParams(baseEntries(key)).toString()}`;

  const chips: ChipSpec[] = [];
  if (personType) {
    chips.push({
      label: formatRoleCategory(personType) ?? personType,
      removeHref: hrefWithout("personType"),
    });
  }
  if (department) {
    chips.push({ label: department, removeHref: hrefWithout("department") });
  }
  if (hasActiveGrants === true) {
    chips.push({ label: "Has active grants", removeHref: hrefWithout("hasActiveGrants") });
  }
  return chips;
}

function buildPublicationsChips({
  q,
  sort,
  yearMin,
  yearMax,
  publicationType,
}: {
  q: string;
  sort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
  publicationType?: string;
}): ChipSpec[] {
  const baseEntries = (omit: Array<"yearMin" | "yearMax" | "publicationType">): Array<[string, string]> => {
    const entries: Array<[string, string]> = [["q", q], ["type", "publications"]];
    if (sort !== "relevance") entries.push(["sort", sort]);
    if (yearMin !== undefined && !omit.includes("yearMin")) entries.push(["yearMin", String(yearMin)]);
    if (yearMax !== undefined && !omit.includes("yearMax")) entries.push(["yearMax", String(yearMax)]);
    if (publicationType && !omit.includes("publicationType")) entries.push(["publicationType", publicationType]);
    return entries;
  };
  const hrefWithout = (keys: Array<"yearMin" | "yearMax" | "publicationType">) =>
    `/search?${new URLSearchParams(baseEntries(keys)).toString()}`;

  const chips: ChipSpec[] = [];
  if (yearMin !== undefined || yearMax !== undefined) {
    let label: string;
    if (yearMin !== undefined && yearMax !== undefined) {
      label = yearMin === yearMax ? `${yearMin}` : `${yearMin}–${yearMax}`;
    } else if (yearMin !== undefined) {
      label = `Since ${yearMin}`;
    } else {
      label = `Through ${yearMax}`;
    }
    chips.push({ label, removeHref: hrefWithout(["yearMin", "yearMax"]) });
  }
  if (publicationType) {
    chips.push({ label: publicationType, removeHref: hrefWithout(["publicationType"]) });
  }
  return chips;
}

function ResultsHeader({
  total,
  page,
  pageSize,
}: {
  total: number;
  page: number;
  pageSize: number;
}) {
  if (total === 0) return null;
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="text-muted-foreground text-sm">
      Showing {start}–{end} of {total}
    </div>
  );
}

function EmptyState({ query, tip }: { query: string; tip: string }) {
  return (
    <div className="mt-12 flex flex-col items-center text-center">
      <div className="text-lg font-medium">No results{query ? ` for "${query}"` : ""}</div>
      <div className="text-muted-foreground mt-1 text-sm">{tip}</div>
    </div>
  );
}

function FacetSidebar({
  query,
  activeType,
  activeSort,
  activeDepartment,
  activePersonType,
  activeHasGrants,
  departments,
  personTypes,
}: {
  query: string;
  activeType: "people";
  activeSort: PeopleSort;
  activeDepartment?: string;
  activePersonType?: string;
  activeHasGrants?: boolean;
  departments: SearchFacetBucket[];
  personTypes: SearchFacetBucket[];
}) {
  const baseParams = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({ q: query, type: activeType });
    if (activeSort !== "relevance") p.set("sort", activeSort);
    if (activeDepartment) p.set("department", activeDepartment);
    if (activePersonType) p.set("personType", activePersonType);
    if (activeHasGrants !== undefined) p.set("hasActiveGrants", String(activeHasGrants));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    return p.toString();
  };

  return (
    <div className="flex flex-col gap-6 text-sm">
      <FacetGroup label="Sort">
        <SortLink label="Relevance" current={activeSort} value="relevance" hrefBuilder={baseParams} />
        <SortLink label="Last name (A–Z)" current={activeSort} value="lastname" hrefBuilder={baseParams} />
        <SortLink label="Most recent publication" current={activeSort} value="recentPub" hrefBuilder={baseParams} />
      </FacetGroup>

      {departments.length > 0 ? (
        <FacetGroup label="Department">
          {activeDepartment ? (
            <Link
              href={`/search?${baseParams({ department: "" })}`}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              ← All departments
            </Link>
          ) : null}
          {departments.map((d) => (
            <FacetLink
              key={d.value}
              label={d.value}
              count={d.count}
              isActive={d.value === activeDepartment}
              href={`/search?${baseParams({ department: d.value })}`}
            />
          ))}
        </FacetGroup>
      ) : null}

      {personTypes.length > 0 ? (
        <FacetGroup label="Person type">
          {activePersonType ? (
            <Link
              href={`/search?${baseParams({ personType: "" })}`}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              ← All person types
            </Link>
          ) : null}
          {personTypes.map((p) => (
            <FacetLink
              key={p.value}
              label={formatRoleCategory(p.value) ?? p.value}
              count={p.count}
              isActive={p.value === activePersonType}
              href={`/search?${baseParams({ personType: p.value })}`}
            />
          ))}
        </FacetGroup>
      ) : null}

      <FacetGroup label="Grants">
        <FacetLink
          label="Has active grants"
          isActive={activeHasGrants === true}
          href={`/search?${baseParams({
            hasActiveGrants: activeHasGrants === true ? "" : "true",
          })}`}
        />
      </FacetGroup>
    </div>
  );
}

function FacetSidebarPubs({
  query,
  activeSort,
  yearMin,
  yearMax,
  activePublicationType,
  publicationTypes,
}: {
  query: string;
  activeSort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
  activePublicationType?: string;
  publicationTypes: SearchFacetBucket[];
}) {
  const baseParams = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({ q: query, type: "publications" });
    if (activeSort !== "relevance") p.set("sort", activeSort);
    if (yearMin !== undefined) p.set("yearMin", String(yearMin));
    if (yearMax !== undefined) p.set("yearMax", String(yearMax));
    if (activePublicationType) p.set("publicationType", activePublicationType);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    return p.toString();
  };

  const yearChoices = [2024, 2020, 2015, 2010];
  return (
    <div className="flex flex-col gap-6 text-sm">
      <FacetGroup label="Sort">
        <SortLink label="Relevance" current={activeSort} value="relevance" hrefBuilder={baseParams} />
        <SortLink label="Year (newest)" current={activeSort} value="year" hrefBuilder={baseParams} />
        <SortLink label="Citations" current={activeSort} value="citations" hrefBuilder={baseParams} />
      </FacetGroup>

      <FacetGroup label="Year (since)">
        {yearChoices.map((y) => (
          <FacetLink
            key={y}
            label={`${y}–present`}
            isActive={yearMin === y}
            href={`/search?${baseParams({ yearMin: yearMin === y ? "" : String(y) })}`}
          />
        ))}
      </FacetGroup>

      {publicationTypes.length > 0 ? (
        <FacetGroup label="Publication type">
          {activePublicationType ? (
            <Link
              href={`/search?${baseParams({ publicationType: "" })}`}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              ← All types
            </Link>
          ) : null}
          {publicationTypes.map((p) => (
            <FacetLink
              key={p.value}
              label={p.value}
              count={p.count}
              isActive={p.value === activePublicationType}
              href={`/search?${baseParams({ publicationType: p.value })}`}
            />
          ))}
        </FacetGroup>
      ) : null}
    </div>
  );
}

function FacetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function FacetLink({
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
    <Link
      href={href}
      className={`flex items-center justify-between rounded px-1.5 py-1 ${
        isActive
          ? "bg-zinc-100 font-medium dark:bg-zinc-800"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
      }`}
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground text-xs">{count}</span>
      ) : null}
    </Link>
  );
}

function SortLink<T extends string>({
  label,
  current,
  value,
  hrefBuilder,
}: {
  label: string;
  current: T;
  value: T;
  hrefBuilder: (overrides: Record<string, string>) => string;
}) {
  const href = `/search?${hrefBuilder({ sort: value === "relevance" ? "" : value })}`;
  return (
    <Link
      href={href}
      className={`rounded px-1.5 py-1 ${
        current === value
          ? "bg-zinc-100 font-medium dark:bg-zinc-800"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
      }`}
    >
      {label}
    </Link>
  );
}

function Pagination({
  q,
  type,
  page,
  total,
  pageSize,
  extra,
}: {
  q: string;
  type: string;
  page: number;
  total: number;
  pageSize: number;
  extra: Record<string, string>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const buildHref = (p: number) => {
    const params = new URLSearchParams({ q, type, ...extra });
    if (p > 0) params.set("page", String(p));
    return `/search?${params.toString()}`;
  };

  // Simple windowed page numbers: prev, 1..N within ±2 of current, next.
  const windowStart = Math.max(0, page - 2);
  const windowEnd = Math.min(totalPages - 1, page + 2);
  const pageNumbers = [];
  for (let p = windowStart; p <= windowEnd; p++) pageNumbers.push(p);

  return (
    <>
      <Separator className="mt-8" />
      <nav className="mt-6 flex items-center justify-center gap-1" aria-label="Pagination">
        <PaginationButton
          href={page > 0 ? buildHref(page - 1) : null}
          label="Previous"
        />
        {pageNumbers.map((p) => (
          <PaginationButton
            key={p}
            href={buildHref(p)}
            label={String(p + 1)}
            active={p === page}
          />
        ))}
        <PaginationButton
          href={page < totalPages - 1 ? buildHref(page + 1) : null}
          label="Next"
        />
      </nav>
    </>
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
  if (!href) {
    return (
      <Button variant="ghost" size="sm" disabled>
        {label}
      </Button>
    );
  }
  return (
    <Button asChild variant={active ? "default" : "ghost"} size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  );
}

