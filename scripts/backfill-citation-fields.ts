/**
 * Backfill the Vancouver-citation columns (#89) from reciterdb without
 * re-running the full reciter ETL. Updates each publication's
 * fullAuthorsString, volume, issue, pages, and journalAbbrev.
 *
 *  - fullAuthorsString ← analysis_summary_author_list (rank+lastName+firstName,
 *      composed as "Lastname I, ...")
 *  - volume/issue/pages ← analysis_summary_article
 *  - journalAbbrev     ← person_article.journalTitleISOabbreviation
 *
 * Idempotent — safe to re-run after subsequent reciter refreshes.
 */
import { prisma } from "@/lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

const IN_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function deriveInitials(firstName: string | null | undefined): string {
  if (!firstName) return "";
  return firstName
    .replace(/\./g, "")
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function composeAuthorString(
  rows: Array<{ rank: number; authorLastName: string | null; authorFirstName: string | null }>,
): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const tokens: string[] = [];
  for (const r of sorted) {
    const last = (r.authorLastName ?? "").trim();
    const initials = deriveInitials(r.authorFirstName);
    if (!last) continue;
    tokens.push(initials ? `${last} ${initials}` : last);
  }
  return tokens.length > 0 ? tokens.join(", ") : null;
}

async function main() {
  console.log("Loading publication pmids from local DB...");
  const pubs = await prisma.publication.findMany({ select: { pmid: true } });
  const pmids = pubs.map((p) => Number(p.pmid)).filter((n) => Number.isFinite(n));
  console.log(`Got ${pmids.length} pmids.`);

  console.log("Fetching author lists...");
  const authorRowsByPmid = new Map<number, Array<{ rank: number; authorLastName: string | null; authorFirstName: string | null }>>();
  for (const batch of chunks(pmids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT pmid, rank, authorLastName, authorFirstName
           FROM analysis_summary_author_list
          WHERE pmid IN (?)`,
        [batch],
      )) as Array<{ pmid: number; rank: number; authorLastName: string | null; authorFirstName: string | null }>;
      for (const r of rows) {
        const list = authorRowsByPmid.get(r.pmid) ?? [];
        list.push(r);
        authorRowsByPmid.set(r.pmid, list);
      }
    });
  }
  const fullAuthorsByPmid = new Map<string, string>();
  for (const [pmid, rows] of authorRowsByPmid) {
    const composed = composeAuthorString(rows);
    if (composed) fullAuthorsByPmid.set(String(pmid), composed);
  }
  console.log(`Composed author strings for ${fullAuthorsByPmid.size} pmids.`);

  console.log("Fetching volume/issue/pages...");
  const articleByPmid = new Map<string, { volume: string | null; issue: string | null; pages: string | null }>();
  for (const batch of chunks(pmids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT pmid, volume, issue, pages FROM analysis_summary_article WHERE pmid IN (?)`,
        [batch],
      )) as Array<{ pmid: number; volume: string | null; issue: string | null; pages: string | null }>;
      for (const r of rows) {
        articleByPmid.set(String(r.pmid), { volume: r.volume, issue: r.issue, pages: r.pages });
      }
    });
  }
  console.log(`Got article fields for ${articleByPmid.size} pmids.`);

  console.log("Fetching journal abbreviations...");
  const abbrevByPmid = new Map<string, string>();
  for (const batch of chunks(pmids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT DISTINCT pmid, journalTitleISOabbreviation
           FROM person_article
          WHERE pmid IN (?) AND journalTitleISOabbreviation IS NOT NULL
                AND journalTitleISOabbreviation <> ''`,
        [batch],
      )) as Array<{ pmid: number; journalTitleISOabbreviation: string }>;
      for (const r of rows) {
        const key = String(r.pmid);
        if (abbrevByPmid.has(key)) continue;
        abbrevByPmid.set(key, r.journalTitleISOabbreviation);
      }
    });
  }
  console.log(`Got journal abbreviations for ${abbrevByPmid.size} pmids.`);

  console.log("Updating publication rows...");
  let updated = 0;
  for (const pub of pubs) {
    const fullAuthors = fullAuthorsByPmid.get(pub.pmid) ?? null;
    const article = articleByPmid.get(pub.pmid);
    const abbrev = abbrevByPmid.get(pub.pmid) ?? null;
    await prisma.publication.update({
      where: { pmid: pub.pmid },
      data: {
        ...(fullAuthors !== null ? { fullAuthorsString: fullAuthors } : {}),
        ...(article ? { volume: article.volume, issue: article.issue, pages: article.pages } : {}),
        ...(abbrev !== null ? { journalAbbrev: abbrev } : {}),
      },
    });
    updated += 1;
    if (updated % 1000 === 0) console.log(`  ...${updated}/${pubs.length}`);
  }
  console.log(`Done. Updated ${updated} rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await closeReciterPool();
  });
