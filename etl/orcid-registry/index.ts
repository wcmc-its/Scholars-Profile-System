/**
 * ORCID public registry → `orcid_candidate`. Sweeps every public ORCID record
 * that names the institution (affiliation phrase, ROR, GRID, or a public email
 * on its domain) and ties each to a WCM scholar three ways:
 *
 *   - `orcid_email`  — a public email on the record equals `scholar.email`
 *                      (only emails that map to exactly ONE scholar count).
 *   - `orcid_works`  — a surname-key + `namesMatch` name match confirmed by
 *                      ≥3 DOIs/PMIDs shared between the record's `/works` and
 *                      the scholar's `publication_author` rows, and no other
 *                      name-matched scholar also shares ≥3 with that iD.
 *                      `articles_accepted` holds the shared-works count.
 *   - `orcid_name`   — every other name match (0–2 shared works, or an iD two
 *                      scholars both share ≥3 with). `articles_accepted` holds
 *                      the shared count so the dashboard can see near-misses.
 *
 * `source_updated_at` is the record's works `last-modified-date`. Same mirror
 * contract as `etl/orcid-candidates` — full replace per run for OUR source
 * values only, refuse to write an empty set, only cwids in `scholar`, one row
 * per (cwid, orcid) with orcid_email > orcid_works > orcid_name. Never writes
 * `scholar.orcid`; read by `/edit/orcid-coverage` only.
 *
 * Usage: `npm run etl:orcid-registry [-- --dry-run]` (weekly; base task
 * family — HTTPS to ORCID + Aurora only). Env: `ORCID_CLIENT_ID` /
 * `ORCID_CLIENT_SECRET` (optional), `ORCID_REGISTRY_DRY_RUN=1`,
 * `ORCID_REGISTRY_MAX_RECORDS=<n>` (local smoke: truncate the deduped union).
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { lastNameKey } from "@/lib/last-name-key";
import { namesMatch } from "@/etl/nih-profile/resolver";
import {
  expandedSearchAll,
  fetchWorks,
  initOrcidAuth,
  type ExpandedResult,
  type ExternalId,
  type WorksResponse,
} from "./orcid-api";

const BATCH = 500;
const MIN_SHARED_WORKS = 3;
export const ORCID_SOURCES = ["orcid_email", "orcid_works", "orcid_name"] as const;
export type OrcidSource = (typeof ORCID_SOURCES)[number];

export type SourceRow = {
  cwid: string;
  orcid: string;
  source: OrcidSource;
  articlesAccepted: number;
  articlesRejected: number;
  sourceUpdatedAt: Date | null;
};

export type Institution = {
  key: string;
  orgPhrase: string;
  ror: string;
  grid: string | null;
  emailDomain: string;
};

/** One active institution. Cornell-Ithaca, when SPS carries NetID scholars:
 *  { key: "cornell", orgPhrase: "Cornell University", ror: "https://ror.org/05bnh6r87",
 *    grid: null, emailDomain: "cornell.edu" } — 25k affiliated records, so the works
 *  step does most of the work there. */
export const INSTITUTIONS: Institution[] = [
  {
    key: "wcm",
    orgPhrase: "Weill Cornell",
    ror: "https://ror.org/02r109517",
    grid: "grid.5386.8",
    emailDomain: "med.cornell.edu",
  },
];

export function institutionQueries(inst: Institution): string[] {
  return [
    `affiliation-org-name:"${inst.orgPhrase}"`,
    `ror-org-id:"${inst.ror}"`,
    ...(inst.grid ? [`grid-org-id:${inst.grid}`] : []),
    `email:*@${inst.emailDomain}`,
  ];
}

/** Union of several result lists, one record per orcid-id (first occurrence wins). Pure. */
export function dedupeRecords(batches: ExpandedResult[][]): ExpandedResult[] {
  const byId = new Map<string, ExpandedResult>();
  for (const batch of batches)
    for (const r of batch) if (!byId.has(r["orcid-id"])) byId.set(r["orcid-id"], r);
  return [...byId.values()];
}

type ScholarRow = { cwid: string; email: string | null; fullName: string; preferredName: string };

/** lower(trim(email)) → cwid, only for emails held by exactly one scholar. Pure. */
export function emailToCwid(scholars: Array<Pick<ScholarRow, "cwid" | "email">>): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const s of scholars) {
    const e = s.email?.trim().toLowerCase();
    if (!e) continue;
    if (!owners.has(e)) owners.set(e, new Set());
    owners.get(e)!.add(s.cwid);
  }
  const out = new Map<string, string>();
  for (const [e, cwids] of owners) if (cwids.size === 1) out.set(e, [...cwids][0]!);
  return out;
}

/** Records with a public email on a scholar → orcid_email rows; returns the settled iDs too. Pure. */
export function matchEmails(
  records: ExpandedResult[],
  emailMap: Map<string, string>,
): { rows: SourceRow[]; matched: Set<string> } {
  const rows: SourceRow[] = [];
  const matched = new Set<string>();
  for (const r of records) {
    for (const raw of r.email ?? []) {
      const cwid = emailMap.get(raw.trim().toLowerCase());
      if (!cwid) continue;
      matched.add(r["orcid-id"]);
      rows.push({
        cwid,
        orcid: r["orcid-id"],
        source: "orcid_email",
        articlesAccepted: 0,
        articlesRejected: 0,
        sourceUpdatedAt: null,
      });
    }
  }
  return { rows, matched };
}

/** Name strings to try for a record: credit-name, "given family", each other-name. Pure. */
export function candidateNames(r: ExpandedResult): string[] {
  const names: string[] = [];
  if (r["credit-name"]?.trim()) names.push(r["credit-name"].trim());
  if (r["given-names"]?.trim() && r["family-names"]?.trim())
    names.push(`${r["given-names"].trim()} ${r["family-names"].trim()}`);
  for (const n of r["other-name"] ?? []) if (n?.trim()) names.push(n.trim());
  return names;
}

type NamedScholar = Pick<ScholarRow, "cwid" | "fullName" | "preferredName">;

/** Scholars indexed by the surname key of fullName and of preferredName. Pure. */
export function buildNameIndex(scholars: NamedScholar[]): Map<string, NamedScholar[]> {
  const idx = new Map<string, NamedScholar[]>();
  for (const s of scholars) {
    for (const k of new Set([lastNameKey(s.fullName), lastNameKey(s.preferredName)])) {
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k)!.push(s);
    }
  }
  return idx;
}

/** orcid → cwids whose fullName or preferredName `namesMatch` one of the record's names. Pure. */
export function matchNames(
  records: ExpandedResult[],
  index: Map<string, NamedScholar[]>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of records) {
    for (const name of candidateNames(r)) {
      for (const s of index.get(lastNameKey(name)) ?? []) {
        if (!namesMatch(name, s.fullName) && !namesMatch(name, s.preferredName)) continue;
        if (!out.has(r["orcid-id"])) out.set(r["orcid-id"], new Set());
        out.get(r["orcid-id"])!.add(s.cwid);
      }
    }
  }
  return out;
}

export const doiKey = (doi: string) => `doi:${doi.trim().toLowerCase()}`;
export const pmidKey = (pmid: string) => `pmid:${pmid.trim()}`;

/** Every DOI (normalized, lowercased) and PMID on the works response, group- and summary-level. Pure. */
export function extractWorkIds(works: WorksResponse): Set<string> {
  const ids = new Set<string>();
  const add = (xs: ExternalId[] | null | undefined) => {
    for (const x of xs ?? []) {
      const type = x["external-id-type"]?.toLowerCase();
      const value = x["external-id-normalized"]?.value ?? x["external-id-value"];
      if (!value) continue;
      if (type === "doi") ids.add(doiKey(value));
      else if (type === "pmid" && /^\d+$/.test(value.trim())) ids.add(pmidKey(value));
    }
  };
  for (const g of works.group ?? []) {
    add(g["external-ids"]?.["external-id"]);
    for (const w of g["work-summary"] ?? []) add(w["external-ids"]?.["external-id"]);
  }
  return ids;
}

/** Per-scholar shared-works counts for one iD → sources: exactly one cwid ≥3 → orcid_works, the rest orcid_name. Pure. */
export function decide(
  sharedByCwid: Map<string, number>,
): Array<{ cwid: string; source: "orcid_works" | "orcid_name"; shared: number }> {
  const confirmed = [...sharedByCwid].filter(([, n]) => n >= MIN_SHARED_WORKS);
  const winner = confirmed.length === 1 ? confirmed[0]![0] : null;
  return [...sharedByCwid].map(([cwid, shared]) => ({
    cwid,
    source: cwid === winner ? "orcid_works" : "orcid_name",
    shared,
  }));
}

/** Keeps rows for known scholars, one per (cwid, orcid): orcid_email > orcid_works > orcid_name. Pure. */
export function mergeForScholars(
  rows: SourceRow[],
  scholars: Set<string>,
): { keep: SourceRow[]; noScholar: number } {
  const byKey = new Map<string, SourceRow>();
  let noScholar = 0;
  for (const r of rows) {
    if (!scholars.has(r.cwid)) {
      noScholar++;
      continue;
    }
    const k = `${r.cwid}|${r.orcid}`;
    const cur = byKey.get(k);
    if (!cur || ORCID_SOURCES.indexOf(r.source) < ORCID_SOURCES.indexOf(cur.source)) byKey.set(k, r);
  }
  return { keep: [...byKey.values()], noScholar };
}

const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** cwid → set of doi:/pmid: keys from the scholar's matched publication_author rows. */
async function loadScholarWorkIds(cwids: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const part of chunk(cwids, BATCH)) {
    const rows = await db.write.publicationAuthor.findMany({
      where: { cwid: { in: part } },
      select: { cwid: true, publication: { select: { pmid: true, doi: true } } },
    });
    for (const r of rows) {
      if (!r.cwid) continue;
      if (!out.has(r.cwid)) out.set(r.cwid, new Set());
      const ids = out.get(r.cwid)!;
      ids.add(pmidKey(r.publication.pmid));
      if (r.publication.doi) ids.add(doiKey(r.publication.doi));
    }
  }
  return out;
}

const dryRun = process.argv.includes("--dry-run") || process.env.ORCID_REGISTRY_DRY_RUN === "1";

async function main(): Promise<number> {
  await initOrcidAuth();

  // 1. Collect: union of the per-institution queries, deduped by orcid-id.
  const batches: ExpandedResult[][] = [];
  for (const inst of INSTITUTIONS) {
    for (const q of institutionQueries(inst)) {
      const { numFound, results } = await expandedSearchAll(q);
      console.log(`[${inst.key}] ${q} → num-found ${numFound}, fetched ${results.length}`);
      batches.push(results);
    }
  }
  let records = dedupeRecords(batches);
  const maxRecords = Number(process.env.ORCID_REGISTRY_MAX_RECORDS);
  if (maxRecords > 0 && records.length > maxRecords) {
    console.log(`ORCID_REGISTRY_MAX_RECORDS=${maxRecords}: truncating ${records.length} records`);
    records = records.slice(0, maxRecords);
  }
  console.log(`Registry union: ${records.length} records`);
  if (records.length === 0) {
    throw new Error("0 records from the ORCID registry — an outage, not \"nobody\"; refusing to mirror");
  }

  const scholars: ScholarRow[] = await db.write.scholar.findMany({
    select: { cwid: true, email: true, fullName: true, preferredName: true },
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));

  // 2. Email match; those iDs are settled and skip the name step.
  const { rows: emailRows, matched: settled } = matchEmails(records, emailToCwid(scholars));

  // 3. Name match on the rest.
  const nameMatched = matchNames(
    records.filter((r) => !settled.has(r["orcid-id"])),
    buildNameIndex(scholars),
  );
  const unmatched = records.length - settled.size - nameMatched.size;

  // 4. Works confirmation, one /works call per name-matched iD.
  const scholarIds = await loadScholarWorkIds([...new Set([...nameMatched.values()].flatMap((s) => [...s]))]);
  const rows: SourceRow[] = [...emailRows];
  let worksFailed = 0;
  for (const [orcid, cwids] of nameMatched) {
    let ids = new Set<string>();
    let updatedAt: Date | null = null;
    try {
      const works = await fetchWorks(orcid);
      ids = extractWorkIds(works);
      updatedAt = works["last-modified-date"]?.value ? new Date(works["last-modified-date"].value) : null;
    } catch (err) {
      worksFailed++;
      if (worksFailed <= 3) console.warn(`works fetch failed for ${orcid}: ${(err as Error).message}`);
    }
    const shared = new Map<string, number>();
    for (const cwid of cwids) {
      const mine = scholarIds.get(cwid);
      let n = 0;
      if (mine) for (const id of ids) if (mine.has(id)) n++;
      shared.set(cwid, n);
    }
    for (const d of decide(shared)) {
      rows.push({
        cwid: d.cwid,
        orcid,
        source: d.source,
        articlesAccepted: d.shared,
        articlesRejected: 0,
        sourceUpdatedAt: updatedAt,
      });
    }
  }
  if (worksFailed) console.warn(`${worksFailed} /works fetches failed after retries → treated as orcid_name with 0 shared`);

  // 5. One row per (cwid, orcid), our sources only, known scholars only.
  const { keep, noScholar } = mergeForScholars(rows, new Set(byCwid.keys()));
  const bySource = keep.reduce<Record<string, number>>(
    (m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m),
    {},
  );
  console.log(
    `${keep.length} rows ${JSON.stringify(bySource)}; dropped: ${noScholar} no scholar, ${unmatched} unmatched records, ${worksFailed} works-fetch failures`,
  );
  if (keep.length === 0) throw new Error("0 rows to write — refusing to mirror an empty match set");

  if (dryRun) {
    const regName = new Map(records.map((r) => [r["orcid-id"], candidateNames(r).join(" / ")]));
    const table = (source: OrcidSource, n: number) =>
      keep
        .filter((r) => r.source === source)
        .sort((a, b) => b.articlesAccepted - a.articlesAccepted)
        .slice(0, n)
        .map((r) => ({
          cwid: r.cwid,
          orcid: r.orcid,
          shared: r.articlesAccepted,
          scholar: byCwid.get(r.cwid)?.fullName,
          registry: regName.get(r.orcid),
        }));
    console.log("--dry-run: nothing written. orcid_works sample:");
    console.table(table("orcid_works", 20));
    console.log("orcid_email sample:");
    console.table(table("orcid_email", 10));
    return keep.length;
  }

  // Mirror: upsert everything, then delete what THIS step's sources no longer have.
  const now = new Date();
  for (const batch of chunk(keep, BATCH)) {
    await db.write.$transaction(
      batch.map((r) =>
        db.write.orcidCandidate.upsert({
          where: { cwid_orcid: { cwid: r.cwid, orcid: r.orcid } },
          create: { ...r, syncedAt: now },
          update: {
            source: r.source,
            articlesAccepted: r.articlesAccepted,
            articlesRejected: r.articlesRejected,
            sourceUpdatedAt: r.sourceUpdatedAt,
            syncedAt: now,
          },
        }),
      ),
    );
  }
  const { count: removed } = await db.write.orcidCandidate.deleteMany({
    where: { source: { in: [...ORCID_SOURCES] }, syncedAt: { lt: now } },
  });
  console.log(`orcid_candidate (registry) mirrored: ${keep.length} rows, ${removed} stale rows removed.`);
  return keep.length;
}

// Run only when invoked directly (`npm run etl:orcid-registry` / the weekly task) — the
// module is also imported by its unit test for the pure transforms.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  // A dry run must not leave a green EtlRun row behind (freshness would read it as a real pass).
  (dryRun ? main().then(() => undefined) : withEtlRun("ORCID-registry", main))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
