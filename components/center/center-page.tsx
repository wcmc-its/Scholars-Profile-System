import { notFound } from "next/navigation";
import { buildOrganizationJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import {
  centerHasPrograms,
  getCenter,
  getCenterGrantsList,
  getCenterMembers,
  getCenterPrograms,
  getCenterPublicationsList,
  getCenterTopResearchAreas,
} from "@/lib/api/centers";
import { getSpotlightCardsForCenter } from "@/lib/api/spotlight";
import { applyAreaPreviewCounts, getUnitAreaPreviews } from "@/lib/api/unit-area-previews";
import { CenterMembersClient } from "@/components/center/center-members-client";
import { parseRosterSort } from "@/lib/roster-sort";
import { CenterCollaborationTab } from "@/components/center/center-collaboration-tab";
import { isCenterProgramPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { isCenterCollaborationNetworkEnabled } from "@/lib/center-collaboration/flags";
import { CenterTabs } from "@/components/center/center-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { DeptGrantsList } from "@/components/department/dept-grants-list";
import { Spotlight } from "@/components/shared/spotlight";
import { UnitWebsiteLink } from "@/components/shared/unit-website-link";
import {
  UnitResearchAreas,
  UnitStatsLine,
  UnitSubunitChips,
  type UnitStat,
} from "@/components/shared/unit-hero";
import { LeaderCard } from "@/components/scholar/leader-card";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import type { GrantSort, PubSort } from "@/lib/api/dept-lists";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications" | "grants" | "collaboration";

export async function CenterPage({
  centerSlug,
  page,
  tab = "scholars",
  sort = null,
  area = null,
}: {
  centerSlug: string;
  page: number;
  tab?: Tab;
  sort?: string | null;
  /** Research-area filter for the Publications tab (the `/areas/{topic}` route). */
  area?: { id: string; label: string } | null;
}) {
  const detail = await getCenter(centerSlug);
  if (!detail) notFound();

  const basePath = `/centers/${detail.slug}`;
  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
  const grantSort: GrantSort = sort === "end_date" ? "end_date" : "most_recent";
  // Unit Page v2 roster toolbar — the Scholars tab's own `?sort=` values.
  const rosterSort = parseRosterSort(sort);
  // A 2-column leadership grid only earns its keep once the stacked column
  // would push the roster far down the page (#2542 follow-up) — 1-3 leaders
  // render exactly as before.
  const twoColumnLeadership = detail.leadership.length >= 4;
  // #1105 — program nav only when the flag is on (links never point at 404).
  const programPagesEnabled = isCenterProgramPagesEnabled();
  // #1137 — collaboration flag; the program-count query is skipped when off.
  const collaborationFlag = isCenterCollaborationNetworkEnabled();

  // All viewer-independent loaders are cached (lib/api/swr-cache) and mutually
  // independent once we have detail.code — fire them in one batch so their
  // (cold-miss) DB scans overlap instead of stacking latency. Conditional
  // loaders resolve to a cheap constant when their tab/flag is off. The page-0
  // pubs result doubles as the always-needed count (stat + tab label + Spotlight
  // view-all); the publications tab additionally loads the requested page/sort.
  const [
    topResearchAreas,
    spotlightCards,
    pubsCountResult,
    pubsListMaybe,
    grantsCountResult,
    grantsListMaybe,
    members,
    programs,
    hasPrograms,
  ] = await Promise.all([
    getCenterTopResearchAreas(detail.code),
    getSpotlightCardsForCenter(detail.code),
    getCenterPublicationsList(detail.code, { page: 0, sort: "newest" }),
    tab === "publications"
      ? getCenterPublicationsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: pubSort,
          area: area?.id ?? null,
        })
      : Promise.resolve(null),
    // Grants tab: page-0 doubles as the tab count (same pattern as pubs).
    getCenterGrantsList(detail.code, { page: 0, sort: "most_recent" }),
    tab === "grants"
      ? getCenterGrantsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: grantSort,
        })
      : Promise.resolve(null),
    tab === "scholars"
      ? getCenterMembers(detail.code, { page: Math.max(0, page - 1), sort: rosterSort })
      : Promise.resolve(null),
    programPagesEnabled ? getCenterPrograms(detail.code) : Promise.resolve([]),
    collaborationFlag ? centerHasPrograms(detail.code) : Promise.resolve(false),
  ]);

  const pubsList = pubsListMaybe ?? pubsCountResult;
  const grantsList = grantsListMaybe ?? grantsCountResult;

  // Hero research-area hover previews; the pill counts become each preview's
  // visible total (= its "See all" and the filtered tab), re-sorted by it.
  const areaPreviews = await getUnitAreaPreviews(
    "center",
    detail.code,
    topResearchAreas.map((t) => t.topicId),
  );
  const researchAreas = applyAreaPreviewCounts(topResearchAreas, areaPreviews);

  // Unit Page v2 — program chips carry a member count. The grouped roster
  // (cached; the same read the Scholars tab makes) is the source of truth, so a
  // chip's count always equals its roster section. Only loaded when the program
  // nav renders (flag on + page-eligible programs); off the Scholars tab this is
  // one extra cached read.
  const rosterForCounts =
    programs.length === 0
      ? null
      : members && page <= 1
        ? members
        : await getCenterMembers(detail.code, { page: 0 });
  const programMemberCount = new Map<string, number>(
    rosterForCounts?.mode === "grouped"
      ? rosterForCounts.groups
          .filter((g) => g.code !== null)
          .map((g) => [g.code as string, g.members.length])
      : [],
  );

  // Hero stats — each links into the page (Unit Page v2).
  const stats: UnitStat[] = [
    detail.scholarCount > 0
      ? {
          value: detail.scholarCount,
          label: detail.hasExternalMembers ? "members" : "scholars",
          href: `${basePath}#people`,
        }
      : null,
    programs.length > 0
      ? {
          value: programs.length,
          label: programs.length === 1 ? "program" : "programs",
          href: "#subunits",
        }
      : null,
    pubsCountResult.total > 0
      ? {
          value: pubsCountResult.total,
          label: "publications",
          href: `${basePath}?tab=publications#people`,
        }
      : null,
  ].filter((s): s is UnitStat => s !== null);
  // #1137 — Collaboration tab: flag on AND the center has a program taxonomy
  // (data-driven → today only the Meyer Cancer Center).
  const showCollaboration = collaborationFlag && hasPrograms;

  const spotlightData = spotlightCards
    ? {
        cards: spotlightCards,
        totalCount: pubsCountResult.total,
        viewAllHref: `${basePath}?tab=publications#tab-content`,
      }
    : null;

  const jsonLd = buildOrganizationJsonLd({
    slug: detail.slug,
    route: "centers",
    name: detail.name,
    description: detail.description ?? null,
  });

  return (
    <main className="unit-surface mx-auto max-w-[1100px] px-6 pb-24 pt-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {/* Unit Page v2: Home › Departments & Centers › {name}. /browse is itself
          titled "Departments & Centers". */}
      <Breadcrumb>
        <BreadcrumbList className="gap-2.5 text-[14px] sm:gap-2.5">
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-[12px]">›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse#centers">
              Departments &amp; Centers
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-[12px]">›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="mt-4 rounded-[10px] border border-apollo-border bg-background px-7 pb-[26px] pt-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-primary-cornell-red)]">
            Center
          </span>
          <UnitWebsiteLink
            url={detail.url}
            unitName={detail.name}
            variant="text"
            label="Center website"
          />
        </div>
        <h1 className="page-title mt-2 text-balance text-[40px] font-normal leading-[1.15]">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="mt-[14px] max-w-[600px] text-pretty text-[15px] leading-[25px] text-muted-foreground">
            {detail.description}
          </p>
        )}

        {/* #2542 Phase B — every leadership-group, profileTitle-eligible role
            holder (director, co-directors, associate directors, …), in
            vocabulary order. The noun comes from `leader.roleLabel`; the
            "Interim" modifier from `leader.isInterim` — nothing is hardcoded
            to "Director". A 2-column grid only kicks in at 4+ leaders — with
            1-3 the cards render stacked, each keeping its own default
            top margin / max-w-[460px]. */}
        {twoColumnLeadership ? (
          <div className="mt-[22px] grid gap-3 sm:grid-cols-2">
            {detail.leadership.map((leader) => (
              <LeaderCard
                key={`${leader.cwid}-${leader.roleLabel}`}
                leader={leader}
                role={leader.roleLabel}
                interim={leader.isInterim}
                className="mt-0 max-w-none"
              />
            ))}
          </div>
        ) : (
          detail.leadership.map((leader) => (
            <LeaderCard
              key={`${leader.cwid}-${leader.roleLabel}`}
              leader={leader}
              role={leader.roleLabel}
              interim={leader.isInterim}
            />
          ))
        )}

        {/* #1105 — program chips only when the flag is on (links never point at
            a 404). Unit Page v2 moves them into the hero, above research areas. */}
        <UnitSubunitChips
          noun={["program", "programs"]}
          ariaLabel="Programs"
          chips={programs.map((p) => ({
            key: p.code,
            label: p.label,
            href: `/centers/${detail.slug}/programs/${p.code}`,
            count: programMemberCount.get(p.code) ?? null,
          }))}
        />

        <UnitResearchAreas
          areas={researchAreas}
          previews={areaPreviews}
          basePath={basePath}
          unitShort={detail.name}
          membersNoun="members"
          infoButton={
            <SectionInfoButton label="Top research areas" anchor="topResearchAreas">
              Research areas are aggregated from ReCiterAI publication scores
              for this center&apos;s members. The order reflects recent
              publication activity, not editorial judgment.
            </SectionInfoButton>
          }
        />

        <UnitStatsLine
          stats={stats}
          fallback={
            detail.scholarCount === 0 && pubsCountResult.total === 0 ? (
              <span>Membership data pending</span>
            ) : null
          }
        />
      </section>

      <Spotlight data={spotlightData} variant="unit" />

      {/* #people is the Unit Page v2 anchor (hero stats); #tab-content stays for
          the existing tab / Spotlight / deep links. scroll-mt clears the
          sticky site header. */}
      <section id="people" className="mt-14 scroll-mt-16">
        <div id="tab-content" className="scroll-mt-16">
          <CenterTabs
            active={tab}
            basePath={basePath}
            scholarsCount={detail.scholarCount}
            publicationsCount={pubsCountResult.total}
            grantsCount={grantsCountResult.total}
            showCollaboration={showCollaboration}
            scholarsLabel={detail.hasExternalMembers ? "Members" : "Scholars"}
          />

          {tab === "scholars" && members && (
            <CenterMembersClient
              result={members}
              centerSlug={detail.slug}
              centerCode={detail.code}
              programPagesEnabled={programPagesEnabled}
              initialSort={rosterSort}
            />
          )}

          {tab === "publications" && (
            <DeptPublicationsList
              hits={pubsList.hits}
              total={pubsList.total}
              page={pubsList.page + 1}
              pageSize={pubsList.pageSize}
              sort={pubSort}
              basePath={basePath}
              listBasePath={area ? `${basePath}/areas/${encodeURIComponent(area.id)}` : undefined}
              activeArea={
                area
                  ? { label: area.label, clearHref: `${basePath}?tab=publications#people` }
                  : null
              }
            />
          )}

          {tab === "grants" && (
            <DeptGrantsList
              hits={grantsList.hits}
              total={grantsList.total}
              page={grantsList.page + 1}
              pageSize={grantsList.pageSize}
              sort={grantSort}
              basePath={basePath}
            />
          )}

          {tab === "collaboration" && showCollaboration && (
            <CenterCollaborationTab centerSlug={detail.slug} centerName={detail.name} />
          )}
        </div>
      </section>
    </main>
  );
}
