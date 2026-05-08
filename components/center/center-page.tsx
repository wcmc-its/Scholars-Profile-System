import { notFound } from "next/navigation";
import {
  getCenter,
  getCenterMembers,
  getCenterPublicationsList,
  getCenterGrantsList,
  getCenterHighlights,
  getCenterTopResearchAreas,
} from "@/lib/api/centers";
import { CenterMembersClient } from "@/components/center/center-members-client";
import { CenterTabs } from "@/components/center/center-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { DeptGrantsList } from "@/components/department/dept-grants-list";
import { HighlightsSection } from "@/components/department/highlights-section";
import { PublicationCard } from "@/components/department/publication-card";
import { GrantCard } from "@/components/department/grant-card";
import { LeaderCard } from "@/components/scholar/leader-card";
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

  // Counts needed for tab labels regardless of active tab. The publications
  // count comes from a lightweight first-page fetch; grants count from the
  // grants-list distinct enumeration. Highlights and top research areas only
  // render on the Scholars (default) tab — but we always compute them so the
  // hero shows top research areas no matter which tab is active.
  const [topResearchAreas, highlights] = await Promise.all([
    getCenterTopResearchAreas(detail.code),
    getCenterHighlights(detail.code),
  ]);

  // Tab counts: pull totals up-front for the tab labels.
  const pubsCountResult = await getCenterPublicationsList(detail.code, {
    page: 0,
    sort: "newest",
  });
  const grantsCountResult = await getCenterGrantsList(detail.code, {
    page: 0,
    sort: "most_recent",
  });

  // Tab-specific paginated data.
  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
  const grantSort = (sort === "end_date"
    ? "end_date"
    : "most_recent") as GrantSort;

  const pubsList =
    tab === "publications"
      ? await getCenterPublicationsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: pubSort,
        })
      : pubsCountResult;

  const grantsList =
    tab === "grants"
      ? await getCenterGrantsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: grantSort,
        })
      : grantsCountResult;

  const members =
    tab === "scholars"
      ? await getCenterMembers(detail.code, { page: Math.max(0, page - 1) })
      : null;

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
              grantsCountResult.total > 0
                ? { value: grantsCountResult.total, label: "active grants" }
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

      <HighlightsSection
        eyebrow="Recent publications"
        caveatItem="publications"
        cards={highlights.publications.map((p) => (
          <PublicationCard key={p.pmid} pub={p} />
        ))}
        totalCount={pubsCountResult.total}
        viewAllHref={`${basePath}?tab=publications#tab-content`}
        viewAllLabel="publications"
      />
      <HighlightsSection
        eyebrow="Active grants"
        caveatItem="grants"
        cards={highlights.grants.map((g, i) => (
          <GrantCard key={g.externalId ?? `g-${i}`} grant={g} />
        ))}
        totalCount={grantsCountResult.total}
        viewAllHref={`${basePath}?tab=grants#tab-content`}
        viewAllLabel="active grants"
      />

      <div id="tab-content" className="mt-12 scroll-mt-16">
        <CenterTabs
          active={tab}
          basePath={basePath}
          scholarsCount={detail.scholarCount}
          publicationsCount={pubsCountResult.total}
          grantsCount={grantsCountResult.total}
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
      </div>
    </main>
  );
}
