import { notFound } from "next/navigation";
import { buildOrganizationJsonLd } from "@/lib/seo/jsonld";
import {
  getCenter,
  getCenterMembers,
  getCenterPublicationsList,
  getCenterTopResearchAreas,
} from "@/lib/api/centers";
import { getSpotlightCardsForCenter } from "@/lib/api/spotlight";
import { CenterMembersClient } from "@/components/center/center-members-client";
import { CenterTabs } from "@/components/center/center-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { Spotlight } from "@/components/shared/spotlight";
import { LeaderCard } from "@/components/scholar/leader-card";
import type { PubSort } from "@/lib/api/dept-lists";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "scholars" | "publications";

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

  // §16: Spotlight + top research areas are page-level. Pubs count is needed
  // for the Spotlight view-all link and the tab label.
  const [topResearchAreas, spotlightCards] = await Promise.all([
    getCenterTopResearchAreas(detail.code),
    getSpotlightCardsForCenter(detail.code),
  ]);
  const pubsCountResult = await getCenterPublicationsList(detail.code, {
    page: 0,
    sort: "newest",
  });

  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
  const pubsList =
    tab === "publications"
      ? await getCenterPublicationsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: pubSort,
        })
      : pubsCountResult;

  const members =
    tab === "scholars"
      ? await getCenterMembers(detail.code, { page: Math.max(0, page - 1) })
      : null;

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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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
        <h1 className="mb-[18px] font-serif text-[40px] font-medium leading-none tracking-[-0.01em]">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="mb-[22px] max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {detail.description}
          </p>
        )}

        {detail.director && <LeaderCard leader={detail.director} role="Director" />}

        {topResearchAreas.length > 0 && (
          <div className="mt-6">
            <div className="mb-[11px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Top research areas
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

      <Spotlight data={spotlightData} />

      <div id="tab-content" className="mt-12 scroll-mt-16">
        <CenterTabs
          active={tab}
          basePath={basePath}
          scholarsCount={detail.scholarCount}
          publicationsCount={pubsCountResult.total}
        />

        {tab === "scholars" && members && (
          <CenterMembersClient
            members={members.hits}
            total={members.total}
            page={members.page + 1}
            pageSize={members.pageSize}
            centerSlug={detail.slug}
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
      </div>
    </main>
  );
}
