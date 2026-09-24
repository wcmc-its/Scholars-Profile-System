import { notFound } from "next/navigation";
import { buildOrganizationJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";
import { getSpotlightCardsForDepartment } from "@/lib/api/spotlight";
import { getDepartmentDivisionMemberCounts } from "@/lib/api/unit-members";
import { isDepartmentCollaborationEligible } from "@/lib/api/department-collaboration";
import { isCenterCollaborationNetworkEnabled } from "@/lib/center-collaboration/flags";
import { applyAreaPreviewCounts, getUnitAreaPreviews } from "@/lib/api/unit-area-previews";
import {
  getDeptPublicationsList,
  getDeptGrantsList,
  type PubSort,
  type GrantSort,
} from "@/lib/api/dept-lists";
import { officialUnitName } from "@/lib/org-unit-names";
import { LeaderCard } from "@/components/scholar/leader-card";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import { parseRosterSort } from "@/lib/roster-sort";
import { Spotlight } from "@/components/shared/spotlight";
import { UnitWebsiteLink } from "@/components/shared/unit-website-link";
import {
  UnitResearchAreas,
  UnitStatsLine,
  UnitSubunitChips,
  type UnitStat,
} from "@/components/shared/unit-hero";
import { DeptTabs } from "@/components/department/dept-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { DeptGrantsList } from "@/components/department/dept-grants-list";
import { DepartmentCollaborationTab } from "@/components/department/department-collaboration-tab";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications" | "grants" | "collaboration";

export async function DepartmentPage({
  deptSlug,
  page,
  tab = "scholars",
  sort = null,
  area = null,
}: {
  deptSlug: string;
  page: number;
  tab?: Tab;
  sort?: string | null;
  /** Research-area filter for the Publications tab (the `/areas/{topic}` route). */
  area?: { id: string; label: string } | null;
}) {
  const detail = await getDepartment(deptSlug);
  if (!detail) notFound();

  // Single base path for tab links. Division navigation is handled by
  // the chip-row in the hero, which links to first-class division pages.
  const basePath = `/departments/${detail.dept.slug}`;

  // Official / ceremonial department name (e.g. ED "Library" → "Samuel J. Wood
  // Library"). `dept.name` stays the raw ED name; display surfaces use this.
  const deptDisplayName = officialUnitName(detail.dept);

  // §16: Spotlight + the active tab's list are mutually independent — fetch in
  // one batch (all cached via lib/api/swr-cache) so cold-miss scans overlap.
  // Only the active tab's heavy list is loaded.
  const pageIdx = Math.max(0, page - 1);
  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
  const grantSort = (sort === "end_date" ? "end_date" : "most_recent") as GrantSort;
  // Unit Page v2 roster toolbar — the Scholars tab's own `?sort=` values.
  const rosterSort = parseRosterSort(sort);
  const [spotlightCards, divisionCounts, areaPreviews, faculty, pubsList, grantsList] = await Promise.all([
    getSpotlightCardsForDepartment(detail.dept.code),
    // Public per-division counts under the Division-facet predicate (NOT the
    // ETL's Division.scholarCount) — feeds both the hero chips and the facet.
    getDepartmentDivisionMemberCounts(detail.dept.code),
    // Hero research-area hover previews (cached per dept + area list).
    getUnitAreaPreviews(
      "department",
      detail.dept.code,
      detail.topResearchAreas.map((t) => t.topicId),
    ),
    tab === "scholars"
      ? getDepartmentFaculty(detail.dept.code, { page: pageIdx, sort: rosterSort })
      : Promise.resolve(null),
    tab === "publications"
      ? getDeptPublicationsList(detail.dept.code, {
          page: pageIdx,
          sort: pubSort,
          area: area?.id ?? null,
        })
      : Promise.resolve(null),
    tab === "grants"
      ? getDeptGrantsList(detail.dept.code, { page: pageIdx, sort: grantSort })
      : Promise.resolve(null),
  ]);
  // Collaboration tab: the shared collaboration kill switch AND a data gate —
  // ≥2 divisions with ≥1 public member (from the counts already loaded above).
  // A deep link on an ineligible department falls back to the Scholars body.
  const showCollaboration =
    isCenterCollaborationNetworkEnabled() &&
    isDepartmentCollaborationEligible(divisionCounts);
  const activeTab: Tab =
    tab === "collaboration" && !showCollaboration ? "scholars" : tab;
  const facultyData =
    faculty ??
    (activeTab === "scholars"
      ? await getDepartmentFaculty(detail.dept.code, { page: pageIdx, sort: rosterSort })
      : null);
  // Pill counts = the preview's visible total (the same number as the card's
  // blurb, its "See all" and the filtered tab), re-sorted by it.
  const researchAreas = applyAreaPreviewCounts(detail.topResearchAreas, areaPreviews);
  const spotlightData = spotlightCards
    ? {
        cards: spotlightCards,
        totalCount: detail.stats.publications,
        viewAllHref: `${basePath}?tab=publications#tab-content`,
      }
    : null;

  const jsonLd = buildOrganizationJsonLd({
    slug: detail.dept.slug,
    route: "departments",
    name: deptDisplayName,
    description: detail.dept.description,
  });

  // Hero stats — each one links into the page (Unit Page v2): scholars to the
  // roster, divisions to the subunit chips, publications / grants to their tab.
  const stats: UnitStat[] = [
    detail.stats.scholars > 0
      ? { value: detail.stats.scholars, label: "scholars", href: `${basePath}#people` }
      : null,
    detail.stats.divisions > 0
      ? {
          value: detail.stats.divisions,
          label: detail.stats.divisions === 1 ? "division" : "divisions",
          href: "#subunits",
        }
      : null,
    detail.stats.publications > 0
      ? {
          value: detail.stats.publications,
          label: "publications",
          href: `${basePath}?tab=publications#people`,
        }
      : null,
    detail.stats.activeGrants > 0
      ? {
          value: detail.stats.activeGrants,
          label: "active grants",
          href: `${basePath}?tab=grants#people`,
        }
      : null,
  ].filter((s): s is UnitStat => s !== null);

  return (
    <main className="unit-surface mx-auto max-w-[1100px] px-6 pb-24 pt-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {/* Breadcrumbs — Unit Page v2: Home › Departments & Centers › {name}.
          /browse is itself titled "Departments & Centers". */}
      <Breadcrumb>
        <BreadcrumbList className="gap-2.5 text-[14px] sm:gap-2.5">
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-[12px]">›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse#departments">
              Departments &amp; Centers
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-[12px]">›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{deptDisplayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Hero card (Unit Page v2) — eyebrow + website link, name, description,
          the embedded chair card, divisions, top research areas, and the
          dashed-divider stats line. */}
      <section className="mt-4 rounded-[10px] border border-apollo-border bg-background px-7 pb-[26px] pt-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-primary-cornell-red)]">
            Department
          </span>
          <UnitWebsiteLink
            url={detail.dept.url}
            unitName={deptDisplayName}
            variant="text"
            label="Department website"
          />
        </div>
        <h1 className="page-title mt-2 text-balance text-[40px] font-normal leading-[1.15]">
          {deptDisplayName}
        </h1>
        {detail.dept.description && (
          <p className="mt-[14px] max-w-[600px] text-pretty text-[15px] leading-[25px] text-muted-foreground">
            {detail.dept.description}
          </p>
        )}

        {detail.chair && (
          <LeaderCard
            leader={detail.chair}
            role={detail.chair.role}
            interim={detail.chair.isInterim}
          />
        )}

        <UnitSubunitChips
          noun={["division", "divisions"]}
          ariaLabel="Divisions"
          chips={detail.divisions.map((d) => ({
            key: d.code,
            label: d.name,
            href: `/departments/${detail.dept.slug}/divisions/${d.slug}`,
            count: divisionCounts.get(d.code) ?? 0,
          }))}
        />

        <UnitResearchAreas
          areas={researchAreas}
          previews={areaPreviews}
          basePath={basePath}
          unitShort={deptDisplayName.replace(/^Department of /, "")}
          membersNoun="faculty"
          infoButton={
            <SectionInfoButton label="Top research areas" anchor="topResearchAreas">
              Research areas are aggregated from ReCiterAI publication scores
              for this department&apos;s scholars. The order reflects recent
              publication activity, not editorial judgment.
            </SectionInfoButton>
          }
        />

        <UnitStatsLine stats={stats} />
      </section>

      {/* §16 Spotlight — replaces the prior Recent publications + Active
          grants highlight rows. Renders nothing when the dept has no
          qualifying publications under the Highlight selection filters. */}
      <Spotlight data={spotlightData} variant="unit" />

      {/* #people is the Unit Page v2 anchor (hero stats); #tab-content stays for
          the existing tab / Spotlight / deep links. scroll-mt clears the
          sticky site header. */}
      <section id="people" className="mt-14 scroll-mt-16">
        <div id="tab-content" className="scroll-mt-16">
          <DeptTabs
            active={activeTab}
            basePath={basePath}
            scholarsCount={detail.stats.scholars}
            publicationsCount={detail.stats.publications}
            grantsCount={detail.stats.activeGrants}
            showCollaboration={showCollaboration}
          />

          {activeTab === "scholars" && facultyData && (
            // Scholars tab body — Unit Page v2: no bordered card; the facet
            // aside + roster sit directly under the tabs. The hero's division
            // chips still link out to the first-class division pages; the
            // Division facet filters the roster in place.
            <DepartmentFacultyClient
              faculty={facultyData.hits}
              total={facultyData.total}
              roleCategoryCounts={facultyData.roleCategoryCounts}
              page={facultyData.page + 1}
              pageSize={facultyData.pageSize}
              deptSlug={detail.dept.slug}
              divisionSlug={null}
              methodFacet={facultyData.methodFacet}
              divisionFacet={detail.divisions.map((d) => ({
                value: d.code,
                label: d.name,
                count: divisionCounts.get(d.code) ?? 0,
              }))}
              unitKind="department"
              unitCode={detail.dept.code}
              initialSort={rosterSort}
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
              listBasePath={area ? `${basePath}/areas/${encodeURIComponent(area.id)}` : undefined}
              activeArea={
                area
                  ? { label: area.label, clearHref: `${basePath}?tab=publications#people` }
                  : null
              }
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

          {activeTab === "collaboration" && (
            <DepartmentCollaborationTab
              deptSlug={detail.dept.slug}
              deptName={deptDisplayName}
            />
          )}
        </div>
      </section>
    </main>
  );
}
