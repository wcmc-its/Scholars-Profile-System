/**
 * Mentor-level co-authored publications rollup (issue #189). Every
 * publication this scholar has co-authored with any of their mentees,
 * grouped by mentee program. Sibling of the per-mentee page at
 * /scholars/<slug>/co-pubs/<menteeCwid> (#184).
 *
 * Surface intent: RPPRs, K/R renewals, mentorship-letter prep. Faculty
 * cite numbers from this page in promotion narratives, so grouping and
 * counting are intentional — see lib/api/mentoring.ts comments.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  formatProgramLabel,
  getAllMentorCoPublications,
  type MenteeCoPubEntry,
} from "@/lib/api/mentoring";
import { AuthorChipRow, type AuthorChip } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { sanitizePubTitle } from "@/lib/utils";
import { formatPublishedName } from "@/lib/postnominal";

export const revalidate = 86400;
export const dynamicParams = true;

type Params = { slug: string };

async function resolveMentor(slug: string) {
  return prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: { cwid: true, slug: true, preferredName: true, postnominal: true },
  });
}

function publishedName(s: {
  preferredName: string;
  postnominal: string | null;
}): string {
  return formatPublishedName(s.preferredName, s.postnominal);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const mentor = await resolveMentor(slug);
  if (!mentor) return { title: "Not found" };
  const mentorName = publishedName(mentor);
  return {
    title: `Co-authored publications with mentees — ${mentorName}`,
    description: `All publications co-authored by ${mentorName} with any of their mentees, grouped by program.`,
  };
}

export default async function MentorCoPubsRollupPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;

  const mentor = await resolveMentor(slug);
  if (!mentor) notFound();

  const mentorName = publishedName(mentor);
  const { groups, publicationCount, menteeCount } =
    await getAllMentorCoPublications(mentor.cwid);

  // Resolve every WCM-affiliated CWID across every author list in every
  // pub to a Scholar row for the inline author-chip row. Single query.
  const authorCwids = new Set<string>();
  for (const g of groups) {
    for (const e of g.entries) {
      for (const a of e.publication.authors) {
        if (a.personIdentifier) authorCwids.add(a.personIdentifier);
      }
    }
  }
  const wcmScholars =
    authorCwids.size === 0
      ? []
      : await prisma.scholar.findMany({
          where: { cwid: { in: [...authorCwids] }, deletedAt: null, status: "active" },
          select: { cwid: true, slug: true, preferredName: true },
        });
  const scholarByCwid = new Map(wcmScholars.map((s) => [s.cwid, s]));

  // Pin the mentor's chip and the per-entry mentee chip. Pinning is per
  // citation row (mentee changes by entry) so we compute it inline.

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <nav aria-label="Breadcrumb" className="text-muted-foreground mb-4 text-xs">
        <Link href="/scholars" className="hover:underline">
          Scholars
        </Link>
        <span className="mx-1.5">/</span>
        <Link href={`/scholars/${mentor.slug}`} className="hover:underline">
          {mentorName}
        </Link>
        <span className="mx-1.5">/</span>
        <span>Co-authored with mentees</span>
      </nav>

      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title text-2xl font-semibold">
            Co-authored publications with mentees
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {mentorName} · {publicationCount} publication
            {publicationCount === 1 ? "" : "s"} across {menteeCount} mentee
            {menteeCount === 1 ? "" : "s"}
          </p>
        </div>
        {publicationCount > 0 ? (
          <div className="flex gap-2">
            <a
              href={`/scholars/${mentor.slug}/co-pubs/export?format=csv`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
            >
              CSV
            </a>
            <a
              href={`/scholars/${mentor.slug}/co-pubs/export?format=docx`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
            >
              Word
            </a>
          </div>
        ) : null}
      </header>

      {publicationCount === 0 ? (
        <EmptyState mentor={mentor} />
      ) : (
        <div className="space-y-10">
          {groups.map((g) => (
            <section key={g.programLabel}>
              <h2 className="mb-3 text-lg font-semibold tracking-tight">
                {g.programLabel}
              </h2>
              <ul className="space-y-5">
                {g.entries.map((e, idx) => (
                  <li
                    key={`${e.mentee.cwid}-${e.publication.pmid}-${idx}`}
                    className="border-b border-border pb-5 last:border-b-0"
                  >
                    <CoPubCitation
                      entry={e}
                      mentorCwid={mentor.cwid}
                      mentorSlug={mentor.slug}
                      scholarByCwid={scholarByCwid}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function EmptyState({
  mentor,
}: {
  mentor: { slug: string; preferredName: string; postnominal: string | null };
}) {
  return (
    <div className="rounded-md border border-border bg-zinc-50 px-4 py-6 text-sm dark:bg-zinc-900/40">
      <p>No co-authored publications with mentees yet.</p>
      <p className="mt-2">
        <Link
          href={`/scholars/${mentor.slug}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          ← Back to {publishedName(mentor)}
        </Link>
      </p>
    </div>
  );
}

function CoPubCitation({
  entry,
  mentorCwid,
  mentorSlug,
  scholarByCwid,
}: {
  entry: MenteeCoPubEntry;
  mentorCwid: string;
  mentorSlug: string;
  scholarByCwid: Map<string, { slug: string; preferredName: string }>;
}) {
  const pub = entry.publication;
  const wcmRanks = pub.authors
    .filter((a) => a.personIdentifier)
    .map((a) => a.rank);
  const minWcmRank = wcmRanks.length > 0 ? Math.min(...wcmRanks) : null;
  const maxRank = pub.authors.reduce((m, a) => Math.max(m, a.rank), 0);

  const authorChips: AuthorChip[] = [];
  for (const a of pub.authors) {
    if (!a.personIdentifier) continue;
    const s = scholarByCwid.get(a.personIdentifier);
    const name = s
      ? s.preferredName
      : [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || a.lastName;
    authorChips.push({
      name,
      cwid: a.personIdentifier,
      slug: s?.slug ?? null,
      identityImageEndpoint: identityImageEndpoint(a.personIdentifier),
      isFirst: a.rank === minWcmRank,
      isLast: a.rank === maxRank,
    });
  }

  const titleHtml = sanitizePubTitle(pub.title);
  const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`;
  const pinnedCwids = [mentorCwid, entry.mentee.cwid];

  // Meta line: "With <Mentee Name> · <Program label> · Class of YYYY"
  // — class-year segment omitted when unknown, per acceptance spec.
  const menteeName = entry.mentee.scholar?.publishedName ?? entry.mentee.fullName;
  const yearSeg = entry.mentee.graduationYear
    ? ` · Class of ${entry.mentee.graduationYear}`
    : "";

  return (
    <div>
      <div className="text-base font-semibold leading-snug">
        <a
          href={pubmedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--color-accent-slate)] hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      </div>
      {(pub.journal || pub.year) && (
        <div className="mt-1 text-sm leading-snug text-zinc-700 dark:text-zinc-300">
          {pub.journal ? (
            <em
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(pub.journal) }}
            />
          ) : null}
          {pub.year ? ` · ${pub.year}` : ""}
        </div>
      )}
      <AuthorChipRow
        authors={authorChips}
        pinnedCwids={pinnedCwids}
        pmid={String(pub.pmid)}
        currentProfileCwid={mentorCwid}
      />
      <PublicationMeta
        citationCount={pub.citationCount}
        pmid={String(pub.pmid)}
        pmcid={pub.pmcid}
        doi={pub.doi}
      />
      <p className="text-muted-foreground mt-2 text-xs">
        With{" "}
        <Link
          href={`/scholars/${mentorSlug}/co-pubs/${entry.mentee.cwid}`}
          className="hover:underline"
        >
          {menteeName}
        </Link>
        {(() => {
          const label =
            formatProgramLabel(entry.mentee.programType) ?? "Other mentee";
          return ` · ${label}${yearSeg}`;
        })()}
      </p>
    </div>
  );
}
