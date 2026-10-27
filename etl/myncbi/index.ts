/**
 * Public MyNCBI bibliographies → `myncbi_bibliography` + `myncbi_citation`.
 *
 * The URLs come only from scholars' own NIH biosketches (`infoed_biosketch.myncbi_url`,
 * etl/infoed-biosketch) — never guessed or enumerated. NCBI's robots.txt disallows
 * /myncbi for crawlers; this fetches known pages for known people at low volume:
 * each scholar at most once per REFRESH_DAYS, one request every REQUEST_GAP_MS.
 *
 * Per scholar, the newest legacy-format biosketch's URL wins (the parser takes no
 * link from a Common Form sketch; the filter also covers rows stored before that).
 * A scholar with no URL left has their list dropped. A fetch that returns no citations
 * never replaces a list we already hold (the page or the account went away, or
 * NCBI is degraded — not "they have no papers").
 *
 * Usage: npm run etl:myncbi
 */
import { db, disconnect } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { parseMyncbiPage, type MyncbiCitation } from "./parse";

const REFRESH_DAYS = 30;
const REQUEST_GAP_MS = 2_000;
// A bibliography of 50 per page past this is not a person's own list.
const MAX_PAGES = 40;
const USER_AGENT = "WCM-Scholars-ETL/1.0 (+https://scholars.weill.cornell.edu)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url: string, page: number): Promise<string> {
  const u = new URL(url);
  u.searchParams.set("page", String(page));
  const res = await fetch(u, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchBibliography(url: string): Promise<MyncbiCitation[]> {
  const first = parseMyncbiPage(await fetchPage(url, 1));
  const out = [...first.citations];
  for (let p = 2; p <= Math.min(first.lastPage, MAX_PAGES); p++) {
    await sleep(REQUEST_GAP_MS);
    out.push(...parseMyncbiPage(await fetchPage(url, p)).citations);
  }
  return [...new Map(out.map((c) => [c.citationId, c])).values()];
}

async function main(): Promise<number> {
  // Newest biosketch URL per scholar.
  const rows = await db.read.infoedBiosketch.findMany({
    where: { myncbiUrl: { not: null }, format: "legacy" },
    orderBy: { uploadedAt: "desc" },
    select: { cwid: true, myncbiUrl: true },
  });
  const urlOf = new Map<string, string>();
  for (const r of rows) if (!urlOf.has(r.cwid)) urlOf.set(r.cwid, r.myncbiUrl!);

  const orphaned = (await db.read.myncbiBibliography.findMany({ select: { cwid: true } }))
    .map((b) => b.cwid)
    .filter((cwid) => !urlOf.has(cwid));
  if (orphaned.length) {
    await db.write.$transaction([
      db.write.myncbiCitation.deleteMany({ where: { cwid: { in: orphaned } } }),
      db.write.myncbiBibliography.deleteMany({ where: { cwid: { in: orphaned } } }),
    ]);
    console.log(`dropped ${orphaned.length} lists with no biosketch URL left`);
  }

  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86_400_000);
  const fresh = new Map(
    (await db.read.myncbiBibliography.findMany({ select: { cwid: true, url: true, fetchedAt: true } })).map((b) => [
      b.cwid,
      b,
    ]),
  );
  const due = [...urlOf].filter(([cwid, url]) => {
    const b = fresh.get(cwid);
    return !b || b.url !== url || b.fetchedAt < cutoff;
  });
  console.log(`${urlOf.size} scholars with a MyNCBI URL, ${due.length} due`);

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let citations = 0;
  for (const [i, [cwid, url]] of due.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    let list: MyncbiCitation[];
    try {
      list = await fetchBibliography(url);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${cwid}: ${msg}`);
      await db.write.myncbiBibliography.upsert({
        where: { cwid },
        create: { cwid, url, status: "error", error: msg.slice(0, 255), citationCount: 0, fetchedAt: new Date() },
        update: { status: "error", error: msg.slice(0, 255), fetchedAt: new Date() },
      });
      continue;
    }
    if (list.length === 0) {
      empty++;
      await db.write.myncbiBibliography.upsert({
        where: { cwid },
        create: { cwid, url, status: "empty", citationCount: 0, fetchedAt: new Date() },
        update: { status: "empty", fetchedAt: new Date() },
      });
      continue;
    }
    const now = new Date();
    await db.write.$transaction([
      db.write.myncbiCitation.deleteMany({ where: { cwid } }),
      db.write.myncbiCitation.createMany({ data: list.map((c) => ({ cwid, ...c })) }),
      db.write.myncbiBibliography.upsert({
        where: { cwid },
        create: { cwid, url, status: "ok", citationCount: list.length, fetchedAt: now },
        update: { url, status: "ok", error: null, citationCount: list.length, fetchedAt: now },
      }),
    ]);
    ok++;
    citations += list.length;
  }
  console.log(`myncbi: ${ok} fetched (${citations} citations), ${empty} empty, ${failed} failed`);
  // Every due fetch failing means NCBI or egress is down, not the lists — fail the run.
  if (due.length >= 5 && failed === due.length) throw new Error(`all ${failed} MyNCBI fetches failed`);
  return citations;
}

if (!process.env.VITEST) {
  withEtlRun("MyNCBI", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(disconnect);
}
