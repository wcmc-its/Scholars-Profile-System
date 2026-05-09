import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { buildPersonJsonLd } from "@/lib/seo/jsonld";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { DisclosureInfoTooltip } from "@/components/scholar/disclosure-info-tooltip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Suspense } from "react";
import { GrantsSection } from "@/components/profile/grants-section";
import { HighlightsInfoButton } from "@/components/profile/highlights-info-button";
import { ProfilePubsCluster } from "@/components/profile/profile-pubs-cluster";
import { PublicationRow } from "@/components/profile/publication-row";
import { PublicationsSection } from "@/components/profile/publications-section";
import {
  getActiveScholarSlugs,
  getScholarFullProfileBySlug,
  isSparseProfile,
  type ProfilePayload,
  type ProfilePublication,
} from "@/lib/api/profile";
import { groupPublicationsByYear } from "@/lib/profile-pub-grouping";
import { resolveBySlugOrHistory } from "@/lib/url-resolver";
import { redirect } from "next/navigation";

// ISR: regenerate every 24 hours by default; on-demand revalidation fires from
// `/api/edit` (Phase 7) and from ETL writes (Phase 4) per decision #8.
export const revalidate = 86400;
export const dynamicParams = true;

export async function generateStaticParams() {
  // Pre-render all active scholars at build when the DB is reachable. In
  // build environments without a DB (CI on a fresh checkout), gracefully
  // skip prerendering — `dynamicParams: true` means pages still render at
  // request time. This keeps `next build` green in CI.
  try {
    const slugs = await getActiveScholarSlugs();
    return slugs.map((slug) => ({ slug }));
  } catch (err) {
    console.warn("[generateStaticParams] Skipping prerender (no DB):", err);
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile) return { title: "Scholar not found" };

  const titleParts = [profile.publishedName];
  if (profile.primaryTitle) titleParts.push(profile.primaryTitle);
  const description = [profile.primaryTitle, profile.primaryDepartment].filter(Boolean).join(" — ");

  const nameParts = profile.preferredName.split(" ");
  const firstName = nameParts[0] ?? profile.preferredName;
  const lastName = nameParts.slice(1).join(" ") || "";

  return {
    title: titleParts.join(" — "),
    description: description || `Scholar profile for ${profile.publishedName}`,
    alternates: { canonical: `/scholars/${profile.slug}` },
    openGraph: {
      type: "profile",
      firstName,
      lastName,
      title: profile.publishedName,
      description: description || `Scholar profile for ${profile.publishedName}`,
      url: `/scholars/${profile.slug}`,
      images: [
        {
          url: `/og/scholars/${profile.slug}`,
          width: 1200,
          height: 630,
          alt: `${profile.publishedName}${profile.primaryTitle ? ` — ${profile.primaryTitle}` : ""} at Weill Cornell Medicine`,
        },
      ],
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function ScholarProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // First-pass redirect resolution for slug_history matches. Direct hits skip
  // the redirect cost; only renamed/old slugs incur a 301.
  const resolved = await resolveBySlugOrHistory(slug);
  if (resolved.type === "redirect") {
    redirect(`/scholars/${resolved.targetSlug}`);
  }

  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile) notFound();

  // ANALYTICS-01 (D-01): structured page-view log on each ISR render / cache miss.
  console.log(
    JSON.stringify({
      event: "profile_view",
      cwid: profile.cwid,
      slug: profile.slug,
      ts: new Date().toISOString(),
    }),
  );

  const jsonLd = buildPersonJsonLd({
    slug: profile.slug,
    preferredName: profile.publishedName,
    primaryTitle: profile.primaryTitle ?? null,
  });

  const sparse = isSparseProfile(profile);
  const activeAppointments = profile.appointments.filter((a) => a.isActive);

  const pubGroups = groupPublicationsByYear(profile.publications);
  const pubMinYear = pubGroups
    .flatMap((g) => g.pubs.map((p) => p.year ?? 0))
    .filter((y) => y > 0)
    .reduce<number | null>((acc, y) => (acc === null ? y : Math.min(acc, y)), null);
  const pubMaxYear = pubGroups
    .flatMap((g) => g.pubs.map((p) => p.year ?? 0))
    .reduce((acc, y) => Math.max(acc, y), 0);

  const activeGrantCount = profile.grants.filter((g) => g.isActive).length;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <main className="mx-auto grid max-w-[1100px] grid-cols-1 gap-10 px-6 py-10 md:grid-cols-[280px_1fr] md:py-12">
        {/* ============== Sidebar ============== */}
        <aside className="md:sticky md:top-[calc(var(--header-h,60px)+24px)] md:self-start md:max-h-[calc(100vh-var(--header-h,60px)-32px)] md:overflow-y-auto">
          <div className="mb-5 text-center">
            <div className="mb-3 flex justify-center">
              <HeadshotAvatar
                size="lg"
                cwid={profile.cwid}
                preferredName={profile.preferredName}
                identityImageEndpoint={profile.identityImageEndpoint}
              />
            </div>
            <h1 className="text-xl font-bold tracking-tight">{profile.publishedName}</h1>
            {profile.primaryTitle ? (
              <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
                {profile.primaryTitle}
              </div>
            ) : null}
            {profile.primaryDepartment ? (
              <div className="text-muted-foreground mt-2 text-sm">{profile.primaryDepartment}</div>
            ) : null}
          </div>

          {profile.email || profile.hasClinicalProfile ? (
            <SidebarCard title="Contact">
              <ul className="flex flex-col gap-2">
                {profile.email ? (
                  <li>
                    <a
                      href={`mailto:${profile.email}`}
                      className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                    >
                      {profile.email}
                    </a>
                  </li>
                ) : null}
                {profile.hasClinicalProfile ? (
                  <li>
                    <a
                      href={`https://weillcornell.org/doctors-directory?searchVal=${encodeURIComponent(
                        // Prefer the (likely) surname for a tighter directory hit;
                        // fall back to full preferred name if the split fails.
                        profile.preferredName.split(/\s+/).pop() || profile.preferredName,
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                    >
                      Clinical profile →
                    </a>
                  </li>
                ) : null}
              </ul>
            </SidebarCard>
          ) : null}

          {activeAppointments.length > 0 ? (
            <SidebarCard title="Appointments">
              <ul className="flex flex-col gap-3">
                {activeAppointments.map((a, i) => (
                  <li key={i} className="leading-snug">
                    <div className="font-semibold">
                      {a.title}
                      {a.isPrimary ? (
                        <Badge variant="secondary" className="ml-2 align-middle">Primary</Badge>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {a.organization}
                      {a.startDate ? ` · ${a.startDate.slice(0, 4)}–` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </SidebarCard>
          ) : null}

          {profile.educations.length > 0 ? (
            <SidebarCard title="Education">
              <ul className="flex flex-col gap-3">
                {profile.educations.map((e, i) => (
                  <li key={i} className="leading-snug">
                    <div className="font-semibold">
                      {e.degree}
                      {e.field ? `, ${e.field}` : ""}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {e.institution}
                      {e.year ? `, ${e.year}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </SidebarCard>
          ) : null}
        </aside>

        {/* ============== Main column ============== */}
        <div className="min-w-0">
          {sparse ? (
            <Card className="mb-6 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
              <CardContent className="py-4 text-sm">
                This profile is being populated. Some content may not yet be available.
                {profile.primaryDepartment ? (
                  <> See {profile.primaryDepartment} for additional information.</>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {profile.overview ? (
            <Section title="Overview">
              <div
                className="text-base leading-relaxed text-zinc-800 dark:text-zinc-200 [&_a]:text-[var(--color-accent-slate)] [&_a]:underline-offset-4 [&_a:hover]:underline [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1"
                dangerouslySetInnerHTML={{ __html: profile.overview }}
              />
            </Section>
          ) : null}

          {profile.highlights.length > 0 ? (
            <Section
              title={
                <span className="inline-flex items-center gap-2">
                  Highlights
                  <HighlightsInfoButton />
                </span>
              }
              headingLg
            >
              <ol className="flex flex-col">
                {profile.highlights.map((p, i) => (
                  <li
                    key={p.pmid}
                    className="grid grid-cols-[32px_1fr] gap-3 border-t border-border py-4 first:border-t-0 first:pt-0"
                  >
                    <div className="text-muted-foreground font-bold leading-none text-2xl tabular-nums">
                      {i + 1}
                    </div>
                    <PublicationRow pub={p} />
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {profile.publications.length > 0 ? (
            <Section
              title="Publications"
              headingLg
              count={
                <>
                  {profile.publications.length} total
                  {pubMaxYear > 0 && pubMinYear !== null
                    ? ` · ${pubMinYear}–${pubMaxYear}`
                    : ""}
                </>
              }
            >
              <Suspense
                fallback={<PublicationsSection publications={profile.publications} />}
              >
                <ProfilePubsCluster
                  publications={profile.publications}
                  keywords={profile.keywords.keywords}
                  totalAcceptedPubs={profile.keywords.totalAcceptedPubs}
                />
              </Suspense>
            </Section>
          ) : null}

          {profile.grants.length > 0 ? (
            <Section
              title="Funding"
              headingLg
              count={
                <>
                  {profile.grants.length} total
                  {activeGrantCount > 0 ? ` · ${activeGrantCount} active` : ""}
                </>
              }
            >
              <GrantsSection grants={profile.grants} />
            </Section>
          ) : null}

          {profile.disclosures.length > 0 ? (
            <Section
              title={
                <>
                  External relationships
                  <DisclosureInfoTooltip />
                </>
              }
              headingLg
            >
              {(() => {
                const grouped = new Map<string, Set<string>>();
                for (const d of profile.disclosures) {
                  if (!d.entity) continue;
                  const key = d.activityGroup ?? "Other";
                  const set = grouped.get(key) ?? new Set<string>();
                  set.add(d.entity);
                  grouped.set(key, set);
                }
                // Stable ordering: known groups first in mockup order, then any others alpha,
                // "Other" last.
                const KNOWN_ORDER = [
                  "Leadership Roles",
                  "Ownership",
                  "Advisory/Scientific Board Member",
                  "Professional Services",
                  "Speaker/Lecturer",
                  "Proprietary Interest",
                  "Other Interest",
                ];
                const keys = [...grouped.keys()];
                keys.sort((a, b) => {
                  if (a === "Other") return 1;
                  if (b === "Other") return -1;
                  const ia = KNOWN_ORDER.indexOf(a);
                  const ib = KNOWN_ORDER.indexOf(b);
                  if (ia === -1 && ib === -1) return a.localeCompare(b);
                  if (ia === -1) return 1;
                  if (ib === -1) return -1;
                  return ia - ib;
                });
                return (
                  <div className="flex flex-col gap-5">
                    {keys.map((group) => {
                      const entities = [...grouped.get(group)!].sort((a, b) =>
                        a.localeCompare(b),
                      );
                      return (
                        <div key={group}>
                          <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wider">
                            {group}
                          </h3>
                          <p className="text-base leading-snug">{entities.join("; ")}</p>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <p className="text-muted-foreground mt-6 border-t border-border pt-4 text-sm">
                <a
                  href="/about/methodology#disclosures"
                  className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                >
                  About these disclosures →
                </a>
              </p>
            </Section>
          ) : null}
        </div>
      </main>
    </>
  );
}

function Section({
  title,
  children,
  headingLg = false,
  count,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  headingLg?: boolean;
  count?: React.ReactNode;
}) {
  return (
    <section className="pt-12 first:pt-0">
      {headingLg ? (
        <h2 className="mb-5 flex items-baseline gap-3 text-2xl font-bold tracking-tight">
          {title}
          {count ? (
            <span className="text-muted-foreground text-sm font-normal tracking-normal">
              {count}
            </span>
          ) : null}
        </h2>
      ) : (
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold uppercase tracking-wider">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

function SidebarCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border py-4">
      <div className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
        {title}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
