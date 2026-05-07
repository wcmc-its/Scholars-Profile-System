import { notFound } from "next/navigation";
import {
  getCenter,
  getCenterMembers,
  getCenterPublicationsList,
} from "@/lib/api/centers";
import { CenterMembersClient } from "@/components/center/center-members-client";
import { CenterTabs } from "@/components/center/center-tabs";
import { DeptPublicationsList } from "@/components/department/dept-publications-list";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { PubSort } from "@/lib/api/dept-lists";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Tab = "people" | "publications";

export async function CenterPage({
  centerSlug,
  page,
  tab = "people",
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

  // Always need the publications count for the tab label, but only fetch the
  // full paginated list when the Publications tab is active. The data layer
  // returns total === 0 fast when there are no member-authored pubs.
  const pubSort = (sort === "most_cited" ? "most_cited" : "newest") as PubSort;
  const pubsList =
    tab === "publications"
      ? await getCenterPublicationsList(detail.code, {
          page: Math.max(0, page - 1),
          sort: pubSort,
        })
      : await getCenterPublicationsList(detail.code, { page: 0, sort: "newest" });

  const members =
    tab === "people"
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

      <section className="mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          CENTER
        </div>
        <h1 className="mt-2 font-serif text-4xl font-semibold leading-tight">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="mt-4 max-w-prose text-base text-muted-foreground">
            {detail.description}
          </p>
        )}
      </section>

      {detail.director && (
        <section className="mt-8 flex items-center gap-4 rounded-lg border border-border bg-white p-4">
          <HeadshotAvatar
            size="md"
            cwid={detail.director.cwid}
            preferredName={detail.director.preferredName}
            identityImageEndpoint={detail.director.identityImageEndpoint}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Director
            </div>
            <a
              href={`/scholars/${detail.director.slug}`}
              className="text-base font-semibold hover:underline"
            >
              {detail.director.preferredName}
            </a>
            {detail.director.primaryTitle && (
              <div className="text-sm text-muted-foreground">
                {detail.director.primaryTitle}
              </div>
            )}
          </div>
        </section>
      )}

      <div className="mt-6 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
        {detail.scholarCount > 0
          ? `${detail.scholarCount.toLocaleString()} members · ${pubsList.total.toLocaleString()} publications`
          : "Membership data pending"}
      </div>

      <div className="mt-8">
        <CenterTabs
          active={tab}
          basePath={basePath}
          peopleCount={detail.scholarCount}
          publicationsCount={pubsList.total}
        />

        {tab === "people" && members && (
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
