import Link from "next/link";
import { notFound } from "next/navigation";
import { buildPersonJsonLd } from "@/lib/seo/jsonld";
import { SidebarCard } from "@/components/profile/sidebar-card";
import { ContactEmailReveal } from "@/components/profile/contact-email-reveal";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { DisclosureInfoTooltip } from "@/components/scholar/disclosure-info-tooltip";
import { DisclosureGroupInfoTooltip } from "@/components/scholar/disclosure-group-info-tooltip";
import { MentoringSection } from "@/components/scholar/mentoring-section";
import { getMenteesForMentor } from "@/lib/api/mentoring";
import { formatMentoringDistribution } from "@/lib/mentoring-labels";
import { groupCoiDisclosures } from "@/lib/coi-groups";
import { filterHiddenMentees, hiddenMenteeCwids } from "@/lib/mentee-suppression";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { EditMyProfileButton } from "@/components/scholar/edit-my-profile-button";
import { Suspense } from "react";
import { GrantsSection } from "@/components/profile/grants-section";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { ProfilePubsCluster } from "@/components/profile/profile-pubs-cluster";
import { PublicationRow } from "@/components/profile/publication-row";
import { PublicationsSection } from "@/components/profile/publications-section";
import {
  getScholarFullProfileBySlug,
  isSparseProfile,
  type ProfilePayload,
  type ProfilePublication,
} from "@/lib/api/profile";
import { groupPublicationsByYear } from "@/lib/profile-pub-grouping";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import {
  isMethodPagesEnabled,
  isMethodsLensFamilyFilterOn,
  isMethodsLensSensitiveGateOn,
} from "@/lib/profile/methods-lens-flags";
import { isProfileFacetRedesignEnabled } from "@/lib/profile/facet-redesign-flag";
import { nihReporterPiUrl } from "@/lib/nih-reporter";
import { profilePath } from "@/lib/profile-url";

/**
 * Shared profile render body (#671). Rendered by both the canonical route and
 * the legacy/redirecting route. Slug resolution, redirects, and the route-level
 * `dynamic = "force-dynamic"` export live in the route files; this component
 * assumes `slug` is the current canonical slug and still 404s as a
 * belt-and-suspenders guard when the profile is missing or non-public.
 *
 * Issue #201 / #640 — the mentee sort is handled entirely client-side in
 * MentoringSection; nothing here reads searchParams.
 */
export async function ProfileView({ slug }: { slug: string }) {
  // email-visibility-spec § Cache-safety — this page is CloudFront PATH-cached,
  // so the loader bakes only the viewer-independent (public) email. An
  // `institution` email is revealed to internal viewers out-of-band by the
  // <ContactEmailReveal> island below (uncacheable /api/profile/[cwid]/contact-
  // email), never baked into the shared cache.
  // Call with just `slug` (the loader defaults `now` to a fresh Date inside its
  // body) so this render and generateMetadata's identical-arg call share one
  // React `cache()` entry per request instead of computing the payload twice.
  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile) notFound();

  // #536 — hidden identity classes (doctoral students) have no public profile
  // page. The route 404s rather than rendering a thin profile or leaving a
  // Google-indexable orphan; superusers manage these scholars via /edit instead.
  if (!isPubliclyDisplayed(profile.roleCategory)) notFound();

  // #356 / #640 — the owner-only "Edit my profile" affordance is rendered by a
  // client island (<EditMyProfileButton>) that probes /api/auth/session. Doing
  // the owner check server-side here both 500'd this statically-generated route
  // (cookies() → DYNAMIC_SERVER_USAGE) and was wrong on CloudFront-cached pages
  // (the edge strips the cookie). Keeping it client-side preserves ISR.

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
    primaryDepartment: profile.primaryDepartment ?? null,
    overview: profile.overview ?? null,
    identityImageEndpoint: profile.identityImageEndpoint,
    clinicalProfileUrl: profile.clinicalProfileUrl ?? null,
    orcid: profile.orcid ?? null,
    keywords: profile.keywords.keywords,
    // #684 — bare (postnominal-free) name drives givenName/familyName +
    // alternateName; the postnominal becomes honorificSuffix.
    nameParts: profile.preferredName,
    honorificSuffix: profile.postnominal ?? null,
  });

  const sparse = isSparseProfile(profile);
  const activeAppointments = profile.appointments.filter((a) => a.isActive);

  // v2b — Mentoring section. Fetches AOC mentees from reciterdb. Returns []
  // for scholars with no recorded mentor relationships, in which case the
  // section is omitted entirely by the component. Sort follows the URL
  // choice (issue #201 Slice B2); the data layer ordering is the final
  // word — the component does no global re-sort, only within-bucket
  // re-sort at the grouped tier when `menteeSort === "copubs"` (URL
  // can't request class-year at that tier because no selector renders).
  // #843 — `copubSourceAvailable` is false when the live ReciterDB co-pub
  // query threw; in that case every mentee's `copublicationCount` is a
  // fallback zero, NOT a real count, so we suppress the co-pub affordances
  // (rollup link + per-chip badges) and show a muted "temporarily unavailable"
  // note instead of presenting an outage as "no co-publications".
  const { mentees: menteesAll, copubSourceAvailable } =
    await getMenteesForMentor(profile.cwid, { sort: "copubs" });

  // #160 follow-up — a mentor may HIDE a mentee from their public profile. The
  // suppression layer is the SOR for that choice (ADR-005 immediacy: per-
  // request, never cached), keyed `entityType="mentee"`, `entityId` prefixed
  // `"{cwid}:"`. Drop hidden mentees BEFORE computing the count / distribution
  // so the header reflects only what's shown. `mentoring.ts` stays reporting-
  // only / pure; the suppression read lives here, where db access already is.
  // Skip the suppression read entirely when the scholar mentors no one (the
  // common case): no point querying for an empty filter, and it keeps a
  // no-mentee render from ever touching the pool (e.g. CI / a degraded DB).
  const menteeSuppressions =
    menteesAll.length > 0
      ? await db.read.suppression.findMany({
          where: {
            entityType: "mentee",
            entityId: { startsWith: `${profile.cwid}:` },
            contributorCwid: null,
            revokedAt: null,
          },
          select: { entityId: true },
        })
      : [];
  const mentees = filterHiddenMentees(
    menteesAll,
    hiddenMenteeCwids(profile.cwid, menteeSuppressions),
  );

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
        <aside className="md:sticky md:top-[calc(var(--header-h,60px)+24px)] md:self-start">
          <ScrollFade viewportClassName="md:max-h-[calc(100vh-var(--header-h,60px)-32px)] md:overflow-y-auto">
            <div className="mb-5 text-center">
              <div className="mb-3 flex justify-center">
                <HeadshotAvatar
                  size="lg"
                  cwid={profile.cwid}
                  preferredName={profile.preferredName}
                  identityImageEndpoint={profile.identityImageEndpoint}
                />
              </div>
              <h1 className="page-title text-[36px] font-bold leading-[1.05] tracking-tight">{profile.publishedName}</h1>
              {profile.primaryTitle ? (
                <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
                  {profile.primaryTitle}
                </div>
              ) : null}
              {profile.primaryDepartment ? (
                <div className="text-muted-foreground mt-2 text-sm">
                  {/* Issue #167 — render "<Division> (<Department>)" when the
                      scholar has a division; otherwise dept-only.
                      #684 — link the department label to its page when a
                      Department slug joins, building the on-site
                      profile↔department link graph. Subtle (color inherited,
                      hover-underline) per the division-page convention. */}
                  {(() => {
                    const deptLabel = profile.departmentSlug ? (
                      <Link
                        href={`/departments/${profile.departmentSlug}`}
                        className="hover:underline"
                      >
                        {profile.primaryDepartment}
                      </Link>
                    ) : (
                      profile.primaryDepartment
                    );
                    return profile.division ? (
                      <>
                        {profile.division} ({deptLabel})
                      </>
                    ) : (
                      deptLabel
                    );
                  })()}
                </div>
              ) : null}
              <EditMyProfileButton profileSlug={profile.slug} />
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
                  {/* email-visibility-spec § Cache-safety — an institution email
                      is revealed to internal viewers out-of-band (no cache leak). */}
                  {profile.contactEmailRevealable ? (
                    <ContactEmailReveal cwid={profile.cwid} mode="li" />
                  ) : null}
                  {profile.hasClinicalProfile ? (
                    <li>
                      <a
                        // Issue #165 — prefer the exact ED-sourced URL when
                        // present; fall back to a surname search so scholars
                        // whose ED record is missing labeledURI;pops still
                        // get a working link.
                        href={
                          profile.clinicalProfileUrl ??
                          `https://weillcornell.org/doctors-directory?searchVal=${encodeURIComponent(
                            profile.preferredName.split(/\s+/).pop() || profile.preferredName,
                          )}`
                        }
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
            ) : profile.contactEmailRevealable ? (
              // No server-baked contact content, but an institution email may be
              // revealable — the island renders its own Contact card iff it
              // resolves an email, so external viewers never see an empty card.
              <ContactEmailReveal cwid={profile.cwid} mode="card" />
            ) : null}

            {profile.postdoctoralMentor ? (
              <SidebarCard title="Postdoctoral Mentor">
                {(() => {
                  const mentor = profile.postdoctoralMentor;
                  // #536 — render the mentor card as a non-link when the mentor
                  // is a hidden identity class (the linked profile would 404).
                  const mentorLinkable = isPubliclyDisplayed(mentor.roleCategory);
                  const baseCls =
                    "flex items-center gap-3 rounded-md bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900/40";
                  const inner = (
                    <>
                      <HeadshotAvatar
                        size="sm"
                        cwid={mentor.cwid}
                        preferredName={mentor.publishedName}
                        identityImageEndpoint={mentor.identityImageEndpoint}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {mentor.publishedName}
                        </div>
                        {mentor.primaryTitle ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {mentor.primaryTitle}
                          </div>
                        ) : null}
                      </div>
                    </>
                  );
                  return mentorLinkable ? (
                    <a
                      href={profilePath(mentor.slug)}
                      className={`${baseCls} hover:bg-zinc-100 dark:hover:bg-zinc-900/60`}
                    >
                      {inner}
                    </a>
                  ) : (
                    <div className={baseCls}>{inner}</div>
                  );
                })()}
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
          </ScrollFade>
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
                  <SectionInfoButton
                    label="Highlights selection"
                    anchor="selectedHighlights"
                  >
                    Highlights are selected by ReCiterAI from the
                    scholar&apos;s first- or senior-author publications,
                    weighted by impact and recency.
                  </SectionInfoButton>
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
                    <PublicationRow pub={p} currentProfileCwid={profile.cwid} />
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
                fallback={
                  <PublicationsSection
                    publications={profile.publications}
                    scholarCwid={profile.cwid}
                  />
                }
              >
                <ProfilePubsCluster
                  publications={profile.publications}
                  keywords={profile.keywords.keywords}
                  families={profile.families}
                  sensitiveGateActive={isMethodsLensSensitiveGateOn()}
                  familyFilterEnabled={isMethodsLensFamilyFilterOn()}
                  methodPagesEnabled={isMethodPagesEnabled()}
                  facetRedesignEnabled={isProfileFacetRedesignEnabled()}
                  totalAcceptedPubs={profile.keywords.totalAcceptedPubs}
                  scholarCwid={profile.cwid}
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
              headerAction={
                profile.nihReporterProfileId !== null ? (
                  <a
                    href={nihReporterPiUrl({ cwid: profile.cwid })}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Opens NIH RePORTER (NIH funding only)"
                    className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline whitespace-nowrap"
                  >
                    View NIH portfolio on RePORTER ↗
                  </a>
                ) : null
              }
            >
              <GrantsSection grants={profile.grants} />
            </Section>
          ) : null}

          {mentees.length > 0 ? (() => {
            // Issue #189 — header link points to the all-mentees co-pubs
            // rollup. Hidden when no mentee has any co-pub (the rollup
            // page would render an empty state but the link wouldn't be
            // actionable in that case).
            // #843 — when the co-pub source is unavailable the counts are all
            // a fallback zero, so `totalCopubs` is a meaningless zero too;
            // gate the link on the source being available so we don't drop it
            // as if there were genuinely no co-pubs.
            const totalCopubs = mentees.reduce(
              (s, m) => s + m.copublicationCount,
              0,
            );
            // Issue #201 priority #5 — degree-bucket distribution
            // ("7 MD · 8 PhD · 6 MD-PhD") renders on its own row beneath
            // the count once the portfolio is large enough that the
            // breakdown carries shape the bare count doesn't. Helper
            // returns null below the threshold or when every mentee
            // falls in a single bucket — in that case `subtitle` is
            // omitted and only the count renders. Slice B1 moves this
            // from the inline `count` slot (Slice A) to the new
            // `subtitle` slot per SPEC §8.
            const distribution = formatMentoringDistribution(mentees);
            return (
              <Section
                title="Mentoring"
                headingLg
                count={`${mentees.length} ${mentees.length === 1 ? "mentee" : "mentees"}`}
                subtitle={distribution}
                headerAction={
                  !copubSourceAvailable ? (
                    // #843 — outage: counts are an artifact, not data. Surface
                    // a muted note in the existing right-aligned slot rather
                    // than a link the rollup page can't honestly back.
                    <span className="text-muted-foreground text-sm">
                      Co-publication counts are temporarily unavailable
                    </span>
                  ) : totalCopubs > 0 ? (
                    <a
                      href={`/scholars/${slug}/co-pubs`}
                      className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline whitespace-nowrap"
                    >
                      All publications with mentees →
                    </a>
                  ) : null
                }
              >
                <MentoringSection
                  mentees={mentees}
                  mentorCwid={profile.cwid}
                  mentorSlug={slug}
                  copubSourceAvailable={copubSourceAvailable}
                />
              </Section>
            );
          })() : null}

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
                // Grouping + ordering is shared with the /edit Conflicts of
                // Interest panel via `groupCoiDisclosures` so the two surfaces
                // can't drift on group order.
                const groups = groupCoiDisclosures(profile.disclosures);
                return (
                  <div className="flex flex-col gap-5">
                    {groups.map(({ group, entities }) => (
                      <div key={group}>
                        <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
                          {group}
                          <DisclosureGroupInfoTooltip group={group} />
                        </h3>
                        <p className="text-base leading-snug">{entities.join("; ")}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}
              <p className="text-muted-foreground mt-6 border-t border-border pt-4 text-sm">
                <Link
                  href="/about#disclosures"
                  className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                >
                  About these disclosures →
                </Link>
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
  subtitle,
  headerAction,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  headingLg?: boolean;
  count?: React.ReactNode;
  /** Optional second-row subhead beneath the title row. Issue #201 —
   *  Mentoring section uses this for the degree-bucket distribution so
   *  it gets its own line rather than appending onto `count`. Renders
   *  only in the `headingLg` branch; ignored by the small heading style. */
  subtitle?: React.ReactNode;
  /** Optional right-aligned action (e.g., outbound link). Issue #90 —
   *  Funding section uses this for the RePORTER PI portfolio link. */
  headerAction?: React.ReactNode;
}) {
  return (
    <section className="pt-12 first:pt-0">
      {headingLg ? (
        <div className="mb-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="flex items-baseline gap-3 text-2xl font-bold tracking-tight">
              {title}
              {count ? (
                <span className="text-muted-foreground text-sm font-normal tracking-normal">
                  {count}
                </span>
              ) : null}
            </h2>
            {headerAction}
          </div>
          {subtitle ? (
            <div className="text-muted-foreground mt-1 text-sm">
              {subtitle}
            </div>
          ) : null}
        </div>
      ) : (
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold uppercase tracking-wider">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

