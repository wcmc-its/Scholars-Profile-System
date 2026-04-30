import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
  type SearchFacetBucket,
} from "@/lib/api/search";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const type = (Array.isArray(sp.type) ? sp.type[0] : sp.type) ?? "people";
  const page = Math.max(0, parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "0", 10));
  const sort = (Array.isArray(sp.sort) ? sp.sort[0] : sp.sort) ?? "relevance";

  const department = (Array.isArray(sp.department) ? sp.department[0] : sp.department) ?? "";
  const personType = (Array.isArray(sp.personType) ? sp.personType[0] : sp.personType) ?? "";
  const hasGrantsParam = Array.isArray(sp.hasActiveGrants) ? sp.hasActiveGrants[0] : sp.hasActiveGrants;
  const hasActiveGrants = hasGrantsParam === undefined ? undefined : hasGrantsParam === "true";

  const yearMin = parseOptionalInt(sp.yearMin);
  const yearMax = parseOptionalInt(sp.yearMax);

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
            {result.hits.map((h) => (
              <li key={h.cwid}>
                <Link
                  href={`/scholars/${h.slug}`}
                  className="flex gap-4 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <HeadshotAvatar
                    size="md"
                    cwid={h.cwid}
                    preferredName={h.preferredName}
                    identityImageEndpoint={h.identityImageEndpoint}
                  />
                  <div className="flex flex-col gap-0.5">
                    <div className="font-medium">{h.preferredName}</div>
                    {h.primaryTitle ? (
                      <div className="text-sm text-zinc-700 dark:text-zinc-300">
                        {h.primaryTitle}
                      </div>
                    ) : null}
                    {h.primaryDepartment ? (
                      <div className="text-muted-foreground text-xs">
                        {h.primaryDepartment}
                      </div>
                    ) : null}
                    {h.highlight && h.highlight.length > 0 ? (
                      <div
                        className="text-muted-foreground mt-1 text-xs"
                        dangerouslySetInnerHTML={{ __html: h.highlight[0] }}
                      />
                    ) : null}
                  </div>
                  {h.hasActiveGrants ? (
                    <Badge variant="secondary" className="ml-auto self-start">
                      Active grants
                    </Badge>
                  ) : null}
                </Link>
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
}: {
  q: string;
  page: number;
  sort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
}) {
  const result = await searchPublications({
    q,
    page,
    sort,
    filters: { yearMin, yearMax },
  });

  return (
    <>
      <aside>
        <FacetSidebarPubs
          query={q}
          activeSort={sort}
          yearMin={yearMin}
          yearMax={yearMax}
        />
      </aside>
      <section>
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
          }}
        />
      </section>
    </>
  );
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
          {personTypes.map((p) => (
            <FacetLink
              key={p.value}
              label={p.value}
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
}: {
  query: string;
  activeSort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
}) {
  const baseParams = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({ q: query, type: "publications" });
    if (activeSort !== "relevance") p.set("sort", activeSort);
    if (yearMin !== undefined) p.set("yearMin", String(yearMin));
    if (yearMax !== undefined) p.set("yearMax", String(yearMax));
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

