import { notFound } from "next/navigation";
import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";
import { getDeptHighlights } from "@/lib/api/dept-highlights";
import {
  getDeptPublicationsList,
  getDeptGrantsList,
  type PubSort,
  type GrantSort,
} from "@/lib/api/dept-lists";
import { LeaderCard } from "@/components/scholar/leader-card";
import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import { HighlightsSection } from "@/components/department/highlights-section";
import { PublicationCard } from "@/components/department/publication-card";
import { GrantCard } from "@/components/department/grant-card";
import { DeptTabs } from "@/components/department/dept-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { DeptGrantsList } from "@/components/department/dept-grants-list";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications" | "grants";

export async function DepartmentPage({
  deptSlug,
  page,
  tab = "scholars",
  sort = null,
}: {
  deptSlug: string;
  page: number;
  tab?: Tab;
  sort?: string | null;
}) {
  const detail = await getDepartment(deptSlug);
  if (!detail) notFound();

  // Single base path for tab links. Division navigation is handled by
  // the chip-row in the hero, which links to first-class division pages.
  const basePath = `/departments/${detail.dept.slug}`;

  // Fetch highlights regardless of tab — they render above the tabs on every
  // tab view per the spec. Each section returns null when its list is empty.
  const highlights = await getDeptHighlights(detail.dept.code);

  // Tab-specific data. Only fetch the heavy list relevant to the active tab.
  const faculty =
    tab === "scholars"
      ? await getDepartmentFaculty(detail.dept.code, {
          page: Math.max(0, page - 1),
        })
      : null;
  const pubsList =
    tab === "publications"
      ? await getDeptPublicationsList(detail.dept.code, {
          page: Math.max(0, page - 1),
          sort: (sort === "most_cited" ? "most_cited" : "newest") as PubSort,
        })
      : null;
  const grantsList =
    tab === "grants"
      ? await getDeptGrantsList(detail.dept.code, {
          page: Math.max(0, page - 1),
          sort: (sort === "end_date" ? "end_date" : "most_recent") as GrantSort,
        })
      : null;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      {/* Breadcrumbs per UI-SPEC §7 */}
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse">Browse</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse#departments">Departments</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.dept.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Hero card per neurology_dept_hero_per_spec.html — bordered card
          containing the dept identity (eyebrow, name, description), the
          embedded chair card, the top research areas pill row, and the
          dashed-divider stats line. */}
      <section className="rounded-lg border border-border bg-background px-7 py-[26px]">
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          Department
        </div>
        <h1 className="mb-[18px] font-serif text-[40px] font-medium leading-none tracking-[-0.01em]">
          {detail.dept.name}
        </h1>
        {detail.dept.description && (
          <p className="mb-[22px] max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {detail.dept.description}
          </p>
        )}

        {detail.chair && <LeaderCard leader={detail.chair} role="Chair" />}

        {detail.topResearchAreas.length > 0 && (
          <div className="mt-6">
            <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Top research areas
            </div>
            <div className="flex flex-wrap gap-[7px]">
              {detail.topResearchAreas.map((t) => (
                <a
                  key={t.topicId}
                  href={`/topics/${t.topicSlug}`}
                  className="inline-flex items-center gap-[7px] rounded-full border border-border bg-background px-3 py-[5px] text-[13px] text-foreground hover:bg-accent"
                  style={{ textDecoration: "none" }}
                >
                  {t.topicLabel}
                  <span className="text-[12px] text-[var(--color-text-tertiary)]">
                    {t.pubCount.toLocaleString()}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {detail.divisions.length > 0 && (
          <div className="mt-6">
            <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {detail.divisions.length} {detail.divisions.length === 1 ? "division" : "divisions"}
            </div>
            <div className="flex flex-wrap gap-[6px]">
              {detail.divisions.map((d) => (
                <a
                  key={d.code}
                  href={`/departments/${detail.dept.slug}/divisions/${d.slug}`}
                  className="rounded-full border border-[var(--color-accent-slate)] bg-white px-3 py-[3px] text-[12px] text-[var(--color-accent-slate)] hover:bg-[var(--color-accent-slate)] hover:text-white"
                  style={{ textDecoration: "none" }}
                >
                  {d.name}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Stats line — dashed top divider, dept-tertiary em separators. */}
        <div className="mt-[22px] flex flex-wrap gap-[9px] border-t border-dashed border-border pt-4 text-[14px] text-muted-foreground">
          {(
            [
              detail.stats.scholars > 0
                ? { value: detail.stats.scholars, label: "scholars" }
                : null,
              detail.stats.divisions > 0
                ? { value: detail.stats.divisions, label: "divisions" }
                : null,
              detail.stats.publications > 0
                ? { value: detail.stats.publications, label: "publications" }
                : null,
              detail.stats.activeGrants > 0
                ? { value: detail.stats.activeGrants, label: "active grants" }
                : null,
            ].filter(Boolean) as Array<{ value: number; label: string }>
          ).map((s, i, all) => (
            <span key={s.label}>
              <b className="font-medium text-foreground">
                {s.value.toLocaleString()}
              </b>{" "}
              {s.label}
              {i < all.length - 1 && (
                <span className="ml-[9px] text-[var(--color-text-tertiary)]">
                  ·
                </span>
              )}
            </span>
          ))}
        </div>
      </section>

      {/* Recent publications + Active grants highlight rows. Each section
          renders only when its data is non-empty (suppress per spec). */}
      <HighlightsSection
        eyebrow="Recent publications"
        caveatItem="publications"
        cards={highlights.publications.map((p) => (
          <PublicationCard key={p.pmid} pub={p} />
        ))}
        totalCount={detail.stats.publications}
        viewAllHref={`${basePath}?tab=publications#tab-content`}
        viewAllLabel="publications"
      />
      <HighlightsSection
        eyebrow="Active grants"
        caveatItem="grants"
        cards={highlights.grants.map((g, i) => (
          <GrantCard key={g.externalId ?? `g-${i}`} grant={g} />
        ))}
        totalCount={detail.stats.activeGrants}
        viewAllHref={`${basePath}?tab=grants#tab-content`}
        viewAllLabel="active grants"
      />

      <div id="tab-content" className="mt-12 scroll-mt-16">
        <DeptTabs
          active={tab}
          basePath={basePath}
          scholarsCount={detail.stats.scholars}
          publicationsCount={detail.stats.publications}
          grantsCount={detail.stats.activeGrants}
        />

        {tab === "scholars" && faculty && (
          // Scholars tab body — single bordered card containing the
          // full-dept faculty list. The DivisionsRail is gone; division
          // navigation now happens via the chip-row in the hero, which
          // links out to the first-class division page.
          <div className="rounded-lg border border-border bg-background p-6">
            <DepartmentFacultyClient
              faculty={faculty.hits}
              total={faculty.total}
              roleCategoryCounts={faculty.roleCategoryCounts}
              page={faculty.page + 1}
              pageSize={faculty.pageSize}
              deptSlug={detail.dept.slug}
              divisionSlug={null}
            />
          </div>
        )}

        {tab === "publications" && pubsList && (
          <DeptPublicationsList
            hits={pubsList.hits}
            total={pubsList.total}
            page={pubsList.page + 1}
            pageSize={pubsList.pageSize}
            sort={(sort === "most_cited" ? "most_cited" : "newest") as PubSort}
            basePath={basePath}
          />
        )}

        {tab === "grants" && grantsList && (
          <DeptGrantsList
            hits={grantsList.hits}
            total={grantsList.total}
            page={grantsList.page + 1}
            pageSize={grantsList.pageSize}
            sort={(sort === "end_date" ? "end_date" : "most_recent") as GrantSort}
            basePath={basePath}
          />
        )}
      </div>
    </main>
  );
}
