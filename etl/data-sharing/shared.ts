/**
 * Data-sharing ETL — shared types + transform, used by all three entrypoints:
 *   - index.ts  (direct: reciterdb + Sps DB in one process; works once #443 lands)
 *   - export.ts (bridge half 1: reciterdb → S3 NDJSON, runs where reciterdb is reachable)
 *   - import.ts (bridge half 2: S3 NDJSON → Sps DB, runs in-VPC)
 *
 * Keeping the join/build/replace logic here means the direct path and the
 * bridge can't drift — they produce identical rows from identical source data.
 *
 * Re-verified against the real table (ReCiterDB#131, merged) after the first
 * live `DataSharingWeekly` run crashed on it 2026-08-10: `pmid` is `INT(11)`,
 * not the string `SourceRow.pmid` claims — `readSourceRows()`'s `as
 * SourceRow[]` cast is unchecked, so nothing caught the mismatch until
 * `nonEmpty()` threw on a real row. Fixed by casting `pmid` to CHAR in the
 * query (below) and by hardening `nonEmpty()` itself, since the unchecked
 * cast means a future column-type drift could hit any other field here too.
 * Every other column was checked against the DDL and does match.
 *
 * A second live run (same day, after the pmid fix) crashed differently: a
 * unique-constraint violation on insert. Root cause — confirmed on the real
 * data, not assumed — is `scan2.py`'s two extraction paths (databank vs.
 * full-text scan) capturing the same real DOI with different letter casing
 * (`10.5281/ZENODO.3576630` vs `10.5281/zenodo.3576630`). DOIs are
 * case-insensitive by spec, and `DatasetDeposit`'s unique index is
 * `utf8mb4_unicode_ci` (matches reciterdb's own collation), so the DB
 * correctly treats those as one row — but this file's in-memory dedup Map
 * used plain (case-sensitive) string equality, so it built two "distinct"
 * deposits that collided on insert. Fixed by lowercasing `accessionOrDoi`
 * at the point it's read (below), so the dedup key matches what the DB
 * already enforces.
 *
 * `title`/`description`/`creators`/`publisher`/`trial_phase`/`trial_status`/
 * `trial_conditions` (#2350 Phase 2, dataset title/metadata enrichment plan)
 * added 2026-08-11, ahead of the ReCiterDB migration that creates them —
 * unverified against a real row for the same reason `pmid` wasn't: no live
 * run has hit this SELECT with these columns present yet. One thing IS
 * knowable ahead of time, not just assumed: `creators`/`trial_conditions`
 * are declared `JSON`, but MariaDB implements `JSON` as a `LONGTEXT` alias
 * (not a native binary JSON type the way MySQL 5.7+/Aurora MySQL do), and
 * the `mariadb` driver has no server-side type signal to tell it to parse
 * text as JSON — so `readSourceRows()` gets these back as JSON-encoded TEXT,
 * same as every VARCHAR/TEXT column here, not as parsed arrays. `SourceRow`
 * types them `string | null` and `buildDepositsAndLinks()` runs them through
 * `parseJsonArray()` before they reach `DepositBuild`. A plain JS array
 * passes straight through to Prisma's `Json?` columns (same as `pmids` on
 * `LinkBuild` below, a required `Json`), but a plain `null` does not — Prisma
 * rejects bare `null` for a nullable `Json` field in `createMany` (it needs
 * `Prisma.DbNull` to mean "SQL NULL", to keep that distinct from a literal
 * JSON `null`, `Prisma.JsonNull`); this file's own `?? Prisma.DbNull` below
 * follows the same convention as `etl/reporter/index.ts`'s `keywords`/
 * `meshDescriptorUis`. Re-verify the MariaDB-JSON claim the same way the two
 * bugs above were found: watch the first live run, don't just trust this
 * comment.
 */
import { createHash } from "node:crypto";
import { db } from "../../lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { withReciterConnection } from "@/lib/sources/reciterdb";

export const INSERT_BATCH = 1000;

/** Deterministic DatasetDeposit.id, keyed on the same (repository,
 *  accessionOrDoi) pair every scheduled run full-replaces on. It MUST be
 *  deterministic, not random: a fresh crypto.randomUUID() per run would mint
 *  a new id for the same real-world deposit on every weekly pass, silently
 *  orphaning any /edit suppression or field-override that keys on this id
 *  (unlike ClinicalTrial, which has a natural-key @id and doesn't need this).
 *  sha256 hex is exactly 64 chars, matching DatasetDeposit.id's
 *  `@db.VarChar(64)` with no migration needed. */
export function depositId(repository: string, accessionOrDoi: string): string {
  return createHash("sha256").update(`${repository}|${accessionOrDoi}`).digest("hex");
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Raw `reciterdb.dataset_deposit` row — one per (cwid, dataset, citing pmid). */
export type SourceRow = {
  cwid: string | null;
  repository: string | null;
  accessionOrDoi: string | null;
  resourceType: string | null;
  dataType: string | null;
  sensitiveCats: string | null; // '|'-delimited coarse categories, taxonomy.py's tag()
  sensitiveSubtypes: string | null; // '|'-delimited "coarseCategory:label" pairs, same source
  accessModel: string | null;
  depositYear: number | string | null;
  provenance: string | null; // 'databank' | 'fulltext-scan'
  confidence: string | null; // 'high' | 'low' | 'unclear'
  authorPosition: string | null; // 'first' | 'last' | 'middle'
  pmid: string | null; // the citing publication for this (cwid, dataset) pair
  title: string | null;
  description: string | null;
  creators: string | null; // JSON-encoded string[] — see file header (MariaDB JSON-as-LONGTEXT)
  publisher: string | null;
  trialPhase: string | null;
  trialStatus: string | null;
  trialConditions: string | null; // JSON-encoded string[] — see file header
};

export function nonEmpty(s: unknown): string | null {
  const t = (s === null || s === undefined ? "" : String(s)).trim();
  return t.length > 0 ? t : null;
}

/** Parse a raw JSON-array column (see file header — MariaDB's `JSON` is a
 *  `LONGTEXT` alias, so the driver hands this back as text, not a parsed
 *  value). Defensive, not just a bare `JSON.parse`: `enrich_titles.py`
 *  always writes a valid array, but this is unverified against a real row
 *  until the first live run. */
export function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cleanYear(raw: number | string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export type DepositBuild = {
  id: string;
  repository: string;
  accessionOrDoi: string;
  resourceType: string | null;
  dataType: string | null;
  sensitiveCats: string | null;
  sensitiveSubtypes: string | null;
  accessModel: string | null;
  depositYear: number | null;
  provenance: string;
  confidence: string | null;
  title: string | null;
  description: string | null;
  creators: Prisma.InputJsonValue | typeof Prisma.DbNull;
  publisher: string | null;
  trialPhase: string | null;
  trialStatus: string | null;
  trialConditions: Prisma.InputJsonValue | typeof Prisma.DbNull;
  source: string;
  lastRefreshedAt: Date;
};

export type LinkBuild = {
  cwid: string;
  datasetId: string;
  authorPosition: string;
  pmids: string[];
  lastRefreshedAt: Date;
};

export type BuildStats = {
  deposits: number;
  links: number;
  skippedNoKey: number;
  skippedUnknownCwid: number;
};

/** Read the raw source table. Used by the direct ETL and the export half —
 *  the only step that needs reciterdb reachability. */
export async function readSourceRows(): Promise<SourceRow[]> {
  let rows: SourceRow[] = [];
  await withReciterConnection(async (conn) => {
    rows = (await conn.query(`
      SELECT cwid, repository,
             accession_or_doi AS accessionOrDoi,
             resource_type AS resourceType,
             data_type AS dataType,
             sensitive_cats AS sensitiveCats,
             sensitive_subtypes AS sensitiveSubtypes,
             access_model AS accessModel,
             deposit_year AS depositYear,
             provenance, confidence,
             author_position AS authorPosition,
             CAST(pmid AS CHAR) AS pmid,
             title, description, creators, publisher,
             trial_phase AS trialPhase,
             trial_status AS trialStatus,
             trial_conditions AS trialConditions
      FROM dataset_deposit
    `)) as SourceRow[];
  });
  return rows;
}

/** lowercased cwid → canonical scholar.cwid, for FK validity (only existing
 *  scholars get links). Same case-normalization clinical-trials needs (the
 *  institutional export's cwid case doesn't reliably match scholar.cwid).
 *  Used by the direct ETL and the import half. */
export async function loadScholars(): Promise<Map<string, string>> {
  const scholars = await db.write.scholar.findMany({ select: { cwid: true } });
  const m = new Map<string, string>();
  for (const s of scholars) m.set(s.cwid.toLowerCase(), s.cwid);
  return m;
}

/** Dedup source rows to one deposit per (repository, accessionOrDoi), derive
 *  the per-(cwid, deposit) link with its aggregated citing-pmid list. Pure
 *  function — identical output for the direct path and the bridge. */
export function buildDepositsAndLinks(
  rows: SourceRow[],
  scholars: Map<string, string>,
  now: Date,
): { deposits: DepositBuild[]; links: LinkBuild[]; stats: BuildStats } {
  const deposits = new Map<string, DepositBuild>(); // keyed "repository|accessionOrDoi"
  const links = new Map<string, LinkBuild>(); // keyed "cwid|repository|accessionOrDoi"
  let skippedNoKey = 0;
  let skippedUnknownCwid = 0;

  for (const r of rows) {
    const repository = nonEmpty(r.repository);
    // Lowercased: DOIs are case-insensitive by spec, and the DB's unique index
    // on (repository, accessionOrDoi) is case-insensitive too (utf8mb4_unicode_ci)
    // — this must match, or two case variants of the same real deposit build as
    // "distinct" here and collide on insert. See the file header for how that
    // was found.
    const accessionOrDoi = nonEmpty(r.accessionOrDoi)?.toLowerCase() ?? null;
    if (!repository || !accessionOrDoi) {
      skippedNoKey++;
      continue;
    }
    const cwidRaw = nonEmpty(r.cwid);
    const cwid = cwidRaw ? scholars.get(cwidRaw.toLowerCase()) : undefined;
    if (!cwid) {
      skippedUnknownCwid++;
      continue;
    }

    const depositKey = `${repository}|${accessionOrDoi}`;
    if (!deposits.has(depositKey)) {
      deposits.set(depositKey, {
        id: depositId(repository, accessionOrDoi),
        repository,
        accessionOrDoi,
        resourceType: nonEmpty(r.resourceType),
        dataType: nonEmpty(r.dataType),
        sensitiveCats: nonEmpty(r.sensitiveCats),
        sensitiveSubtypes: nonEmpty(r.sensitiveSubtypes),
        accessModel: nonEmpty(r.accessModel),
        depositYear: cleanYear(r.depositYear),
        provenance: nonEmpty(r.provenance) ?? "databank",
        confidence: nonEmpty(r.confidence),
        title: nonEmpty(r.title),
        description: nonEmpty(r.description),
        // JSON columns, not strings — parseJsonArray(), not nonEmpty(). See
        // file header (MariaDB JSON-as-LONGTEXT). `?? Prisma.DbNull`, not a
        // bare `null` — see file header on nullable `Json` columns.
        creators: parseJsonArray(r.creators) ?? Prisma.DbNull,
        publisher: nonEmpty(r.publisher),
        trialPhase: nonEmpty(r.trialPhase),
        trialStatus: nonEmpty(r.trialStatus),
        trialConditions: parseJsonArray(r.trialConditions) ?? Prisma.DbNull,
        source: "reciterdb.dataset_deposit",
        lastRefreshedAt: now,
      });
    }
    const datasetId = deposits.get(depositKey)!.id;

    const linkKey = `${cwid}|${depositKey}`;
    const pmid = nonEmpty(r.pmid);
    const existingLink = links.get(linkKey);
    if (existingLink) {
      if (pmid && !existingLink.pmids.includes(pmid)) existingLink.pmids.push(pmid);
    } else {
      links.set(linkKey, {
        cwid,
        datasetId,
        authorPosition: nonEmpty(r.authorPosition) ?? "middle",
        pmids: pmid ? [pmid] : [],
        lastRefreshedAt: now,
      });
    }
  }

  return {
    deposits: [...deposits.values()],
    links: [...links.values()],
    stats: {
      deposits: deposits.size,
      links: links.size,
      skippedNoKey,
      skippedUnknownCwid,
    },
  };
}

/** Full-replace the two tables (children first on delete, parents first on
 *  insert per FK). Caller MUST guard against an empty build before calling
 *  this — delete-all + insert-nothing would wipe good data. */
export async function replaceAll(
  deposits: DepositBuild[],
  links: LinkBuild[],
): Promise<{ insDeposits: number; insLinks: number; delLinks: number; delDeposits: number }> {
  let insDeposits = 0;
  let insLinks = 0;
  let delLinks = 0;
  let delDeposits = 0;
  await db.write.$transaction(
    async (tx) => {
      delLinks = (await tx.personDatasetDeposit.deleteMany({})).count;
      delDeposits = (await tx.datasetDeposit.deleteMany({})).count;
      for (const batch of chunks(deposits, INSERT_BATCH)) {
        await tx.datasetDeposit.createMany({ data: batch });
        insDeposits += batch.length;
      }
      for (const batch of chunks(links, INSERT_BATCH)) {
        await tx.personDatasetDeposit.createMany({ data: batch });
        insLinks += batch.length;
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return { insDeposits, insLinks, delLinks, delDeposits };
}
