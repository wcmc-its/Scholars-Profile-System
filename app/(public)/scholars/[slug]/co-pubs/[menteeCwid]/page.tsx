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
import { PublicationCard } from "@/components/department/publication-card";
import type { DeptPublicationCard } from "@/lib/api/dept-highlights";
import type { AuthorChip } from "@/components/publication/author-chip-row";

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
  // (slug + preferredName) in a single query so the publication cards can
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
          <h1 className="text-2xl font-semibold">Co-authored publications</h1>
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
              <PublicationCard pub={toPublicationCard(p, scholarByCwid)} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Adapt the ReCiterDB-shaped publication row to the dept publication
 *  card shape. Marks first-author / last-author by rank (last author is
 *  the highest-ranked WCM-affiliated row in the list, per the existing
 *  AuthorChipRow convention). */
function toPublicationCard(
  p: CoPublicationFull,
  scholarByCwid: Map<string, { slug: string; preferredName: string }>,
): DeptPublicationCard {
  const wcmRanks = p.authors
    .filter((a) => a.personIdentifier)
    .map((a) => a.rank);
  const minWcmRank = wcmRanks.length > 0 ? Math.min(...wcmRanks) : null;
  const maxRank = p.authors.reduce((m, a) => Math.max(m, a.rank), 0);

  const authors: AuthorChip[] = [];
  for (const a of p.authors) {
    if (!a.personIdentifier) continue;
    const s = scholarByCwid.get(a.personIdentifier);
    // Unlinked WCM authors (alumni with no active Scholar row) fall back
    // to the analysis_summary_author_list name; AuthorChipRow renders
    // them as a static chip with no anchor (#186).
    const name = s
      ? s.preferredName
      : [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || a.lastName;
    authors.push({
      name,
      cwid: a.personIdentifier,
      slug: s?.slug ?? null,
      identityImageEndpoint: identityImageEndpoint(a.personIdentifier),
      isFirst: a.rank === minWcmRank,
      isLast: a.rank === maxRank,
    });
  }

  return {
    pmid: String(p.pmid),
    title: p.title,
    journal: p.journal,
    year: p.year,
    citationCount: p.citationCount,
    doi: p.doi,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
    authors,
  };
}
