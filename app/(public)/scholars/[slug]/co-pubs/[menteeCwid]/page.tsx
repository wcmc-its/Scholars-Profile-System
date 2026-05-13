/**
 * Co-authored publications page — full list of publications a mentor and
 * a single mentee co-authored. Replaces the popover form factor from #181
 * with a bookmarkable, exportable surface. See issue #184.
 *
 * Route: /scholars/<mentor-slug>/co-pubs/<menteeCwid>
 *  - Mentor resolved by slug (must be an active Scholar row).
 *  - Mentee identified by CWID — `reporting_students_mentors` carries
 *    student CWIDs even for unlinked alumni, so this URL works for both
 *    linked and unlinked mentees.
 *  - 404 when the slug doesn't resolve OR when the (mentor, mentee) pair
 *    isn't recorded in the mentoring source.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  getCoPublications,
  getMentorMenteePair,
  type CoPublicationFull,
} from "@/lib/api/mentoring";
import { AuthorChipRow, type AuthorChip } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { sanitizePubTitle } from "@/lib/utils";

export const revalidate = 86400;
export const dynamicParams = true;

type Params = { slug: string; menteeCwid: string };

async function resolveMentor(slug: string) {
  return prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: { cwid: true, slug: true, preferredName: true, postnominal: true },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug, menteeCwid } = await params;
  const mentor = await resolveMentor(slug);
  if (!mentor) return { title: "Not found" };
  const pair = await getMentorMenteePair(mentor.cwid, menteeCwid);
  if (!pair) return { title: "Not found" };
  return {
    title: `Co-authored publications — ${pair.mentorName} and ${pair.menteeName}`,
    description: `Publications co-authored by ${pair.mentorName} and ${pair.menteeName}.`,
  };
}

export default async function CoPubsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug, menteeCwid } = await params;

  const mentor = await resolveMentor(slug);
  if (!mentor) notFound();

  const pair = await getMentorMenteePair(mentor.cwid, menteeCwid);
  if (!pair) notFound();

  const pubs = await getCoPublications(mentor.cwid, menteeCwid);

  // Resolve every WCM-affiliated CWID in the author lists to a Scholar row
  // (slug + preferredName) in a single query so the citation rows can
  // render anchor author chips for linked authors. Unlinked CWIDs (alumni
  // not in Scholar) pass through with slug=null and a fallback name from
  // the analysis_summary_author_list row — AuthorChipRow renders them as
  // a static (non-anchor) chip per #186.
  const authorCwids = new Set<string>();
  for (const p of pubs) {
    for (const a of p.authors) {
      if (a.personIdentifier) authorCwids.add(a.personIdentifier);
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

  // Mentor + mentee are the load-bearing context for this page; AuthorChipRow
  // pins their chips to the front of the visible slice so the truncation cap
  // can never hide them.
  const pinnedCwids = [mentor.cwid, menteeCwid];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <nav aria-label="Breadcrumb" className="text-muted-foreground mb-4 text-xs">
        <Link href="/scholars" className="hover:underline">
          Scholars
        </Link>
        <span className="mx-1.5">/</span>
        <Link href={`/scholars/${mentor.slug}`} className="hover:underline">
          {pair.mentorName}
        </Link>
        <span className="mx-1.5">/</span>
        <span>Co-authored with {pair.menteeName}</span>
      </nav>

      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title text-2xl font-semibold">Co-authored publications</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {pair.mentorName} and {pair.menteeName} ·{" "}
            {pubs.length} publication{pubs.length === 1 ? "" : "s"}
          </p>
        </div>
        {pubs.length > 0 && (
          <div className="flex gap-2">
            <a
              href={`/scholars/${mentor.slug}/co-pubs/${menteeCwid}/export?format=csv`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
            >
              CSV
            </a>
            <a
              href={`/scholars/${mentor.slug}/co-pubs/${menteeCwid}/export?format=docx`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
            >
              Word
            </a>
          </div>
        )}
      </header>

      {pubs.length === 0 ? (
        <div className="rounded-md border border-border bg-zinc-50 px-4 py-6 text-sm dark:bg-zinc-900/40">
          <p>No co-authored publications found.</p>
          <p className="mt-2">
            <Link
              href={`/scholars/${mentor.slug}`}
              className="text-foreground underline-offset-2 hover:underline"
            >
              ← Back to {pair.mentorName}
            </Link>
          </p>
        </div>
      ) : (
        <ul className="space-y-5">
          {pubs.map((p) => (
            <li key={p.pmid} className="border-b border-border pb-5 last:border-b-0">
              <CoPubCitation
                pub={p}
                scholarByCwid={scholarByCwid}
                pinnedCwids={pinnedCwids}
                currentProfileCwid={mentor.cwid}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Single citation row using the standard publication-row layout:
 *  title → journal · year → author chips → meta (citations, PMID,
 *  PMCID, DOI with copy buttons). Mirrors `components/profile/publication-row.tsx`
 *  visually but takes the CoPublicationFull shape directly instead of
 *  the profile-page ProfilePublication shape. */
function CoPubCitation({
  pub,
  scholarByCwid,
  pinnedCwids,
  currentProfileCwid,
}: {
  pub: CoPublicationFull;
  scholarByCwid: Map<string, { slug: string; preferredName: string }>;
  pinnedCwids: ReadonlyArray<string>;
  currentProfileCwid: string;
}) {
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
        currentProfileCwid={currentProfileCwid}
      />
      <PublicationMeta
        citationCount={pub.citationCount}
        pmid={String(pub.pmid)}
        pmcid={pub.pmcid}
        doi={pub.doi}
      />
    </div>
  );
}
