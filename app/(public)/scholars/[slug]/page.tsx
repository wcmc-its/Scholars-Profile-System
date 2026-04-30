import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ShowMoreList } from "@/components/profile/show-more-list";
import { PastAppointmentsExpander } from "@/components/profile/past-appointments";
import {
  getActiveScholarSlugs,
  getScholarFullProfileBySlug,
  isSparseProfile,
  type ProfilePayload,
  type ProfilePublication,
} from "@/lib/api/profile";
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

  const titleParts = [profile.preferredName];
  if (profile.primaryTitle) titleParts.push(profile.primaryTitle);
  const description = [profile.primaryTitle, profile.primaryDepartment].filter(Boolean).join(" — ");

  return {
    title: titleParts.join(" — "),
    description: description || `Scholar profile for ${profile.preferredName}`,
    alternates: { canonical: `/scholars/${profile.slug}` },
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

  const sparse = isSparseProfile(profile);
  const activeAppointments = profile.appointments.filter((a) => a.isActive);
  const pastAppointments = profile.appointments.filter((a) => !a.isActive);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      {/* Header */}
      <section className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Avatar className="h-24 w-24 sm:h-28 sm:w-28">
          <AvatarFallback className="text-xl">{initials(profile.preferredName)}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">{profile.preferredName}</h1>
          {profile.primaryTitle ? (
            <div className="text-lg text-zinc-700 dark:text-zinc-300">{profile.primaryTitle}</div>
          ) : null}
          {profile.primaryDepartment ? (
            <div className="text-muted-foreground">{profile.primaryDepartment}</div>
          ) : null}
        </div>
      </section>

      {sparse ? (
        <Card className="mt-6 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
          <CardContent className="py-4 text-sm">
            This profile is being populated. Some content may not yet be available.
            {profile.primaryDepartment ? (
              <>
                {" "}
                See {profile.primaryDepartment} for additional information.
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Separator className="my-8" />

      {profile.overview ? (
        <Section title="Overview">
          <p className="leading-relaxed text-zinc-800 dark:text-zinc-200">{profile.overview}</p>
        </Section>
      ) : null}

      {profile.email ? (
        <Section title="Contact">
          <a
            href={`mailto:${profile.email}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {profile.email}
          </a>
        </Section>
      ) : null}

      {activeAppointments.length > 0 ? (
        <Section title="Appointments">
          <ul className="flex flex-col gap-3">
            {activeAppointments.map((a, i) => (
              <li key={i}>
                <div className="font-medium">{a.title}</div>
                <div className="text-muted-foreground text-sm">{a.organization}</div>
                <div className="text-muted-foreground text-xs">
                  {a.startDate ? a.startDate.slice(0, 4) : ""} – Present
                  {a.isPrimary ? <Badge variant="secondary" className="ml-2">Primary</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
          <PastAppointmentsExpander items={pastAppointments} />
        </Section>
      ) : null}

      {profile.educations.length > 0 ? (
        <Section title="Education and training">
          <ul className="flex flex-col gap-3">
            {profile.educations.map((e, i) => (
              <li key={i}>
                <div className="font-medium">{e.degree}{e.field ? `, ${e.field}` : ""}</div>
                <div className="text-muted-foreground text-sm">
                  {e.institution}
                  {e.year ? ` · ${e.year}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {profile.areasOfInterest.length > 0 ? (
        <Section title="Areas of interest">
          <ul className="flex flex-wrap gap-2">
            {profile.areasOfInterest.map((t) => (
              <li key={t.topic}>
                <Badge variant="secondary" className="text-sm font-normal">
                  {t.topic}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {(profile.highlights.length > 0 || profile.recent.length > 0) ? (
        <Section title="Publications">
          {profile.highlights.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
                Selected highlights
              </h3>
              <ul className="flex flex-col gap-4">
                {profile.highlights.map((p) => (
                  <li key={p.pmid}>
                    <PublicationRow pub={p} ownerCwid={profile.cwid} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {profile.recent.length > 0 ? (
            <div className="mt-8">
              <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
                Recent publications
              </h3>
              <ShowMoreList
                defaultItems={profile.recent
                  .slice(0, 10)
                  .map((p) => (
                    <PublicationRow key={p.pmid} pub={p} ownerCwid={profile.cwid} />
                  ))}
                rest={profile.recent
                  .slice(10)
                  .map((p) => (
                    <PublicationRow key={p.pmid} pub={p} ownerCwid={profile.cwid} />
                  ))}
              />
            </div>
          ) : null}
        </Section>
      ) : null}

      {profile.grants.length > 0 ? (
        <Section title="Grants">
          {(() => {
            const sorted = [...profile.grants].sort((a, b) =>
              a.isActive === b.isActive
                ? b.endDate.localeCompare(a.endDate)
                : a.isActive
                  ? -1
                  : 1,
            );
            const renderGrant = (g: ProfilePayload["grants"][number], i: number) => (
              <div key={`${g.title}-${i}`}>
                <div className="font-medium">{g.title}</div>
                <div className="text-muted-foreground text-sm">
                  {g.role} · {g.funder}
                </div>
                <div className="text-muted-foreground text-xs">
                  {g.startDate.slice(0, 4)} – {g.endDate.slice(0, 4)}
                  {g.isActive ? (
                    <Badge variant="secondary" className="ml-2">
                      Active
                    </Badge>
                  ) : null}
                </div>
              </div>
            );
            return (
              <ShowMoreList
                defaultItems={sorted.slice(0, 10).map(renderGrant)}
                rest={sorted.slice(10).map((g, i) => renderGrant(g, i + 10))}
              />
            );
          })()}
        </Section>
      ) : null}

      {profile.disclosures.length > 0 ? (
        <Section title="Disclosures">
          {(() => {
            // Group by activityGroup so related entries cluster.
            const groups = new Map<string, typeof profile.disclosures>();
            for (const d of profile.disclosures) {
              const key = d.activityGroup ?? "Other";
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(d);
            }
            return (
              <div className="flex flex-col gap-6">
                {Array.from(groups.entries()).map(([group, entries]) => (
                  <div key={group}>
                    <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
                      {group}
                    </h3>
                    <ul className="flex flex-col gap-3">
                      {entries.map((d, i) => (
                        <li key={i}>
                          {d.entity ? <div className="font-medium">{d.entity}</div> : null}
                          <div className="text-muted-foreground text-sm">
                            {[d.activityType, d.value, d.activityRelatesTo]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      ) : null}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function PublicationRow({ pub }: { pub: ProfilePublication; ownerCwid: string }) {
  return (
    <div>
      <div className="font-medium leading-snug">
        {pub.pubmedUrl ? (
          <a
            href={pub.pubmedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {pub.title}
          </a>
        ) : (
          pub.title
        )}
      </div>
      {pub.authorsString ? (
        <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          {pub.authorsString}
        </div>
      ) : null}
      {pub.wcmCoauthors.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {pub.wcmCoauthors.map((a) => (
            <a
              key={a.cwid}
              href={`/scholars/${a.slug}`}
              className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              {a.preferredName}
            </a>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground mt-1 text-xs">
        {pub.journal} · {pub.year}
        {pub.publicationType ? ` · ${pub.publicationType}` : ""}
        {pub.citationCount > 0 ? ` · ${pub.citationCount} citations` : ""}
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
