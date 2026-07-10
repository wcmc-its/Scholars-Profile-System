import { notFound } from "next/navigation";
import { buildOrganizationJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import {
  centerHasPrograms,
  getCenter,
  getCenterMembers,
  getCenterPrograms,
  getCenterPublicationsList,
  getCenterTopResearchAreas,
} from "@/lib/api/centers";
import { getSpotlightCardsForCenter } from "@/lib/api/spotlight";
import { CenterMembersClient } from "@/components/center/center-members-client";
import { CenterCollaborationTab } from "@/components/center/center-collaboration-tab";
import { isCenterProgramPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { isCenterCollaborationNetworkEnabled } from "@/lib/center-collaboration/flags";
import { CenterTabs } from "@/components/center/center-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { Spotlight } from "@/components/shared/spotlight";
import { UnitWebsiteLink } from "@/components/shared/unit-website-link";
import { LeaderCard } from "@/components/scholar/leader-card";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import type { PubSort } from "@/lib/api/dept-lists";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications" | "collaboration";

export async function CenterPage({
  centerSlug,
  page,
  tab = "scholars",
  sort = null,
}: {
  centerSlug: string;
  page: number;
  tab?: Tab;
  sort?: string | null;
}) {
  const detail = await getCenter(centerSlug);
  if (!detail) notFound();

  const basePath = `/centers/${detail.slug}`;
  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
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
        })
      : Promise.resolve(null),
    tab === "scholars"
      ? getCenterMembers(detail.code, { page: Math.max(0, page - 1) })
      : Promise.resolve(null),
    programPagesEnabled ? getCenterPrograms(detail.code) : Promise.resolve([]),
    collaborationFlag ? centerHasPrograms(detail.code) : Promise.resolve(false),
  ]);

  const pubsList = pubsListMaybe ?? pubsCountResult;
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
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
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
            <BreadcrumbLink href="/browse#centers">
              Centers &amp; institutes
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="rounded-lg border border-border bg-background px-7 py-[26px]">
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          Center
        </div>
        <h1 className="page-title mb-[18px] text-[40px] font-medium leading-none tracking-[-0.01em]">
          {detail.name}
          <UnitWebsiteLink url={detail.url} unitName={detail.name} />
        </h1>
        {detail.description && (
          <p className="mb-[22px] max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {detail.description}
          </p>
        )}

        {detail.director && <LeaderCard leader={detail.director} role="Director" />}

        {topResearchAreas.length > 0 && (
          <div className="mt-6">
            <div className="mb-[11px] inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Top research areas
              <SectionInfoButton label="Top research areas" anchor="topResearchAreas">
                Research areas are aggregated from ReCiterAI publication scores
                for this center&apos;s members. The order reflects recent
                publication activity, not editorial judgment.
              </SectionInfoButton>
            </div>
            <div className="flex flex-wrap gap-[7px]">
              {topResearchAreas.map((t) => (
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

        <div className="mt-[22px] flex flex-wrap gap-[9px] border-t border-dashed border-border pt-4 text-[14px] text-muted-foreground">
          {(
            [
              detail.scholarCount > 0
                ? { value: detail.scholarCount, label: "scholars" }
                : null,
              pubsCountResult.total > 0
                ? { value: pubsCountResult.total, label: "publications" }
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
          {detail.scholarCount === 0 && pubsCountResult.total === 0 && (
            <span>Membership data pending</span>
          )}
        </div>
      </section>

      {programs.length > 0 && (
        <nav className="mt-8" aria-label="Programs">
          <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Programs
          </div>
          <div className="flex flex-wrap gap-[7px]">
            {programs.map((p) => (
              <a
                key={p.code}
                href={`/centers/${detail.slug}/programs/${p.code}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-[5px] text-[13px] text-foreground hover:bg-accent"
                style={{ textDecoration: "none" }}
              >
                {p.label}
                <span
                  aria-hidden
                  className="text-[12px] text-[var(--color-text-tertiary)]"
                >
                  →
                </span>
              </a>
            ))}
          </div>
        </nav>
      )}

      <Spotlight data={spotlightData} />

      <div id="tab-content" className="mt-12 scroll-mt-16">
        <CenterTabs
          active={tab}
          basePath={basePath}
          scholarsCount={detail.scholarCount}
          publicationsCount={pubsCountResult.total}
          showCollaboration={showCollaboration}
        />

        {tab === "scholars" && members && (
          <CenterMembersClient
            result={members}
            centerSlug={detail.slug}
            programPagesEnabled={programPagesEnabled}
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
          />
        )}

        {tab === "collaboration" && showCollaboration && (
          <CenterCollaborationTab centerSlug={detail.slug} />
        )}
      </div>
    </main>
  );
}
