/**
 * Division page — first-class surface for /departments/[slug]/divisions/[div].
 *
 * Parallels the department-page structure: bordered hero card with eyebrow,
 * description, chief card, top research areas (computed for the division),
 * sibling-division chip-row, dashed-divider stats line; recent publications
 * + active grants highlight rows; Scholars / Publications / Grants tabs
 * driven by URL state.
 */
import { notFound } from "next/navigation";
import {
  getDivision,
  getDivisionFaculty,
  getDivisionHighlights,
  getDivisionPublicationsList,
  getDivisionGrantsList,
} from "@/lib/api/divisions";
import { LeaderCard } from "@/components/scholar/leader-card";
import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import { HighlightsSection } from "@/components/department/highlights-section";
import { PublicationCard } from "@/components/department/publication-card";
import { GrantCard } from "@/components/department/grant-card";
import { DeptTabs } from "@/components/department/dept-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { DeptGrantsList } from "@/components/department/dept-grants-list";
import type { PubSort, GrantSort } from "@/lib/api/dept-lists";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications" | "grants";

export async function DivisionPage({
  deptSlug,
  divSlug,
  page,
  tab = "scholars",
  sort = null,
}: {
  deptSlug: string;
  divSlug: string;
  page: number;
  tab?: Tab;
  sort?: string | null;
}) {
  const detail = await getDivision(deptSlug, divSlug);
  if (!detail) notFound();

  const basePath = `/departments/${detail.parentDept.slug}/divisions/${detail.division.slug}`;
  const highlights = await getDivisionHighlights(detail.division.code);

  const faculty =
    tab === "scholars"
      ? await getDivisionFaculty(detail.division.code, {
          page: Math.max(0, page - 1),
        })
      : null;
  const pubsList =
    tab === "publications"
      ? await getDivisionPublicationsList(detail.division.code, {
          page: Math.max(0, page - 1),
          sort: (sort === "most_cited" ? "most_cited" : "newest") as PubSort,
        })
      : null;
  const grantsList =
    tab === "grants"
      ? await getDivisionGrantsList(detail.division.code, {
          page: Math.max(0, page - 1),
          sort: (sort === "end_date" ? "end_date" : "most_recent") as GrantSort,
        })
      : null;

  const parentShortName = detail.parentDept.name.replace(/^Department of /, "");

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
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
            <BreadcrumbLink href={`/departments/${detail.parentDept.slug}`}>
              {detail.parentDept.name}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.division.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="rounded-lg border border-border bg-background px-7 py-[26px]">
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          Division
          <span className="ml-2 text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
            in{" "}
            <a
              href={`/departments/${detail.parentDept.slug}`}
              className="hover:underline"
              style={{ textDecoration: "none" }}
            >
              {detail.parentDept.name}
            </a>
          </span>
        </div>
        <h1 className="mb-[18px] font-serif text-[40px] font-medium leading-none tracking-[-0.01em]">
          {detail.division.name}
        </h1>
        {detail.division.description && (
          <p className="mb-[22px] max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {detail.division.description}
          </p>
        )}

        {detail.chief && <LeaderCard leader={detail.chief} role="Chief" />}

        {detail.topResearchAreas.length > 0 && (
          <div className="mt-6">
            <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Top research areas in this division
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

        {detail.siblingDivisions.length > 1 && (
          <div className="mt-6">
            <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Other divisions in {parentShortName}
            </div>
            <div className="flex flex-wrap gap-[6px]">
              {detail.siblingDivisions.map((s) => {
                const isCurrent = s.code === detail.division.code;
                if (isCurrent) {
                  return (
                    <span
                      key={s.code}
                      className="rounded-full border border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] px-3 py-[3px] text-[12px] font-medium text-white"
                    >
                      {s.name}
                    </span>
                  );
                }
                return (
                  <a
                    key={s.code}
                    href={`/departments/${detail.parentDept.slug}/divisions/${s.slug}`}
                    className="rounded-full border border-[var(--color-accent-slate)] bg-white px-3 py-[3px] text-[12px] text-[var(--color-accent-slate)] hover:bg-[var(--color-accent-slate)] hover:text-white"
                    style={{ textDecoration: "none" }}
                  >
                    {s.name}
                  </a>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-[22px] flex flex-wrap gap-[9px] border-t border-dashed border-border pt-4 text-[14px] text-muted-foreground">
          {(
            [
              detail.stats.scholars > 0
                ? { value: detail.stats.scholars, label: "scholars" }
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
          <DepartmentFacultyClient
            faculty={faculty.hits}
            total={faculty.total}
            roleCategoryCounts={faculty.roleCategoryCounts}
            page={faculty.page + 1}
            pageSize={faculty.pageSize}
            deptSlug={detail.parentDept.slug}
            divisionSlug={detail.division.slug}
          />
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
