/**
 * ORCID public registry → `orcid_candidate`. Sweeps every public ORCID record
 * that names the institution (affiliation phrase, ROR, GRID, or a public email
 * on its domain) and ties each to a WCM scholar three ways:
 *
 *   - `orcid_email`  — the record's public emails resolve to exactly ONE
 *                      scholar via `scholar.email` (an email held by several
 *                      scholars never maps; a record whose emails point at two
 *                      scholars is not settled and falls through to the name
 *                      step instead).
 *   - `orcid_works`  — a surname-key + `namesMatch` name match confirmed by
 *                      ≥3 DOIs/PMIDs shared between the record's `/works` and
 *                      the scholar's `publication_author` rows, a FULL given
 *                      name in common (an initial is not enough — "J Smith"
 *                      matches both John and Mary J. Smith, and a same-surname
 *                      co-author shares works with a departed owner's iD), and
 *                      no other such scholar with ≥3 works of its own that the
 *                      iD does not also share with this one (exclusive
 *                      overlap). `articles_accepted` holds the shared count.
 *   - `orcid_name`   — every other name match (0–2 shared works, initial-only
 *                      name agreement, or an ambiguous overlap). The shared
 *                      count is stored so the dashboard can see near-misses.
 *
 * `source_updated_at` is the record's works `last-modified-date`. Same mirror
 * contract as `etl/orcid-candidates` — full replace per run for OUR source
 * values only, refuse to write an empty set, only cwids in `scholar`. Within
 * this mirror one row per (cwid, orcid), orcid_email > orcid_works >
 * orcid_name; the table key is (cwid, orcid, source), so an `rpm_*` row for the
 * same person and iD sits beside ours — that is the "two sources agree" case
 * the dashboard grades strong. Never writes `scholar.orcid`; read by
 * `/edit/orcid-coverage` only.
 *
 * Fails loud instead of writing a degraded mirror: 0 registry records, a 401/403
 * from ORCID, or more than WORKS_FAIL_SHARE of the `/works` calls failing all
 * abort the run before the write (a single failed iD is orcid_name with 0
 * shared, and a re-run heals it).
 *
 * Usage: `npm run etl:orcid-registry [-- --dry-run]` (weekly; base task
 * family — HTTPS to ORCID + Aurora only). Env: `ORCID_CLIENT_ID` /
 * `ORCID_CLIENT_SECRET` (optional; the deployed task has neither today and runs
 * anonymously — see scripts/release/flag-parity-allowlist.txt),
 * `ORCID_REGISTRY_DRY_RUN=1`, `ORCID_REGISTRY_MAX_RECORDS=<n>` (local smoke:
 * truncates the deduped union and FORCES a dry run — a truncated set must never
 * reach the write path, where the delete pass would remove every other row).
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { lastNameKey } from "@/lib/last-name-key";
import { nameTokens, namesMatch } from "@/etl/nih-profile/resolver";
import {
  expandedSearchAll,
  fetchWorks,
  initOrcidAuth,
  OrcidHttpError,
  type ExpandedResult,
  type ExternalId,
  type WorksResponse,
} from "./orcid-api";

const BATCH = 500;
const MIN_SHARED_WORKS = 3;
/** More than this share of `/works` calls failing (after retries) is an ORCID
 *  outage, not a few odd records: abort rather than demote every affected
 *  scholar to orcid_name. Small runs tolerate a couple of failures outright. */
const WORKS_FAIL_SHARE = 0.02;
const WORKS_FAIL_FLOOR = 2;
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

/** Records whose public emails resolve to exactly ONE scholar → orcid_email rows; returns the
 *  settled iDs too. A record listing emails of two different scholars (a lab or shared
 *  address stored on someone else's row) is `ambiguous`: no row, not settled, so the
 *  name/works step still gets to look at it. Pure. */
export function matchEmails(
  records: ExpandedResult[],
  emailMap: Map<string, string>,
): { rows: SourceRow[]; matched: Set<string>; ambiguous: number } {
  const rows: SourceRow[] = [];
  const matched = new Set<string>();
  let ambiguous = 0;
  for (const r of records) {
    const cwids = new Set<string>();
    for (const raw of r.email ?? []) {
      const cwid = emailMap.get(raw.trim().toLowerCase());
      if (cwid) cwids.add(cwid);
    }
    if (cwids.size === 0) continue;
    if (cwids.size > 1) {
      ambiguous++;
      continue;
    }
    matched.add(r["orcid-id"]);
    rows.push({
      cwid: [...cwids][0]!,
      orcid: r["orcid-id"],
      source: "orcid_email",
      articlesAccepted: 0,
      articlesRejected: 0,
      sourceUpdatedAt: null,
    });
  }
  return { rows, matched, ambiguous };
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

/** The full given-name tokens of a name (everything before the surname, ≥2 letters,
 *  hyphens dropped) plus their concatenation, so "Xiao-Wei Wang", "Xiao Wei Wang" and
 *  "Xiaowei Wang" all carry `xiaowei`. Initials carry nothing: "J A Smith" → {}. Pure. */
export function givenNameKeys(name: string): Set<string> {
  const given = [...nameTokens(name)].slice(0, -1).map((t) => t.replace(/-/g, ""));
  const keys = new Set(given.filter((t) => t.length >= 2));
  // Glue "Xiao Wei" → "xiaowei"; never glue bare initials ("J A" is not a given name "ja").
  if (keys.size > 0 && given.length > 1) keys.add(given.join(""));
  return keys;
}

/** A FULL given name (not just an initial) shared between one of the record's names and
 *  the scholar's fullName or preferredName. `namesMatch` alone lets "J Smith" match
 *  "Mary J Smith" through the middle initial, which is how a same-surname co-author
 *  inherits a departed owner's iD; the works tier requires this on top. Pure. */
export function givenNamesAgree(recordNames: string[], scholar: NamedScholar): boolean {
  const mine = new Set<string>();
  for (const n of [scholar.fullName, scholar.preferredName]) for (const k of givenNameKeys(n)) mine.add(k);
  if (mine.size === 0) return false;
  return recordNames.some((n) => [...givenNameKeys(n)].some((k) => mine.has(k)));
}

export const doiKey = (doi: string) => `doi:${doi.trim().toLowerCase()}`;
export const pmidKey = (pmid: string) => `pmid:${pmid.trim()}`;

/** Every DOI (normalized, lowercased) and PMID on the works response, group- and summary-level.
 *  Container ids (`external-id-relationship` = part-of / version-of: the book or proceedings
 *  volume, not the work) are skipped; a missing relationship counts as `self`. Pure. */
export function extractWorkIds(works: WorksResponse): Set<string> {
  const ids = new Set<string>();
  const add = (xs: ExternalId[] | null | undefined) => {
    for (const x of xs ?? []) {
      const rel = x["external-id-relationship"]?.toLowerCase();
      if (rel && rel !== "self") continue;
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

/** What the works step knows about one (iD, name-matched scholar) pair. */
export type WorksEvidence = {
  /** doi:/pmid: keys on both the record's `/works` and the scholar's publications. */
  shared: Set<string>;
  /** `givenNamesAgree` for the pair. */
  givenNameAgrees: boolean;
};

/** Per-scholar works evidence for one iD → sources. A scholar is confirmed by ≥3 shared
 *  works AND a full given name in common; exactly one confirmed scholar → orcid_works.
 *  Several confirmed → the one with ≥3 works the iD shares with nobody else confirmed
 *  (exclusive overlap), so a genuine owner is not demoted beside a co-authoring homonym
 *  whose shared works are all joint papers; a tie or nobody exclusive → all orcid_name.
 *  Every name-matched scholar gets a row; `shared` is the count. Pure. */
export function decide(
  byCwid: Map<string, WorksEvidence>,
): Array<{ cwid: string; source: "orcid_works" | "orcid_name"; shared: number }> {
  const confirmed = [...byCwid].filter(
    ([, e]) => e.shared.size >= MIN_SHARED_WORKS && e.givenNameAgrees,
  );
  let winner: string | null = null;
  if (confirmed.length === 1) winner = confirmed[0]![0];
  else if (confirmed.length > 1) {
    const exclusive = confirmed.filter(([cwid, e]) => {
      let n = 0;
      for (const id of e.shared) {
        if (!confirmed.some(([o, oe]) => o !== cwid && oe.shared.has(id))) n++;
      }
      return n >= MIN_SHARED_WORKS;
    });
    if (exclusive.length === 1) winner = exclusive[0]![0];
  }
  return [...byCwid].map(([cwid, e]) => ({
    cwid,
    source: cwid === winner ? "orcid_works" : "orcid_name",
    shared: e.shared.size,
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

const maxRecords = Number(process.env.ORCID_REGISTRY_MAX_RECORDS);
// A truncated union is a local smoke only: on the write path the delete pass would
// remove every registry row the sample did not cover, so the knob forces a dry run.
const dryRun =
  process.argv.includes("--dry-run") || process.env.ORCID_REGISTRY_DRY_RUN === "1" || maxRecords > 0;

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
  if (maxRecords > 0 && records.length > maxRecords) {
    console.log(
      `ORCID_REGISTRY_MAX_RECORDS=${maxRecords}: truncating ${records.length} records (dry run forced)`,
    );
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

  // 2. Email match; iDs that resolve to exactly one scholar are settled and skip the
  //    name step. Ambiguous ones (emails of two scholars) fall through to it.
  const { rows: emailRows, matched: settled, ambiguous } = matchEmails(records, emailToCwid(scholars));
  if (ambiguous) console.log(`${ambiguous} records list emails of more than one scholar → left to the name step`);

  // 3. Name match on the rest.
  const nameMatched = matchNames(
    records.filter((r) => !settled.has(r["orcid-id"])),
    buildNameIndex(scholars),
  );
  const unmatched = records.length - settled.size - nameMatched.size;

  // 4. Works confirmation, one /works call per name-matched iD.
  const scholarIds = await loadScholarWorkIds([...new Set([...nameMatched.values()].flatMap((s) => [...s]))]);
  const recordById = new Map(records.map((r) => [r["orcid-id"], r]));
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
      // Auth/blocking: every further call fails the same way — stop before the write.
      if (err instanceof OrcidHttpError && (err.status === 401 || err.status === 403)) {
        throw new Error(`ORCID refused /works (HTTP ${err.status}) — aborting before the write`, { cause: err });
      }
      worksFailed++;
      if (worksFailed <= 3) console.warn(`works fetch failed for ${orcid}: ${(err as Error).message}`);
    }
    const names = candidateNames(recordById.get(orcid)!);
    const evidence = new Map<string, WorksEvidence>();
    for (const cwid of cwids) {
      const mine = scholarIds.get(cwid);
      const shared = new Set<string>();
      if (mine) for (const id of ids) if (mine.has(id)) shared.add(id);
      evidence.set(cwid, { shared, givenNameAgrees: givenNamesAgree(names, byCwid.get(cwid)!) });
    }
    for (const d of decide(evidence)) {
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
  const maxWorksFailed = Math.max(WORKS_FAIL_FLOOR, Math.ceil(WORKS_FAIL_SHARE * nameMatched.size));
  if (worksFailed > maxWorksFailed) {
    // Fail-soft on a path that WRITES is a wipe: every affected scholar would be demoted
    // to orcid_name with 0 shared and the run would still read green.
    throw new Error(
      `${worksFailed} of ${nameMatched.size} /works fetches failed after retries (> ${maxWorksFailed}) — an ORCID outage, refusing to mirror`,
    );
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
    // The weak tier is where a loose name hit lands — the near-misses (2 shared) and
    // the initial-only matches are the rows an eyeball has to be able to see.
    console.log("orcid_name sample (shared desc):");
    console.table(table("orcid_name", 20));
    return keep.length;
  }

  // Mirror: upsert everything, then delete what THIS step's sources no longer have.
  // `source` is part of the key, so an `rpm_*` row for the same (cwid, orcid) is a
  // different row and is never touched here; a pair that moved between our own
  // sources leaves its old row to the delete pass.
  const now = new Date();
  for (const batch of chunk(keep, BATCH)) {
    await db.write.$transaction(
      batch.map((r) =>
        db.write.orcidCandidate.upsert({
          where: { cwid_orcid_source: { cwid: r.cwid, orcid: r.orcid, source: r.source } },
          create: { ...r, syncedAt: now },
          update: {
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
