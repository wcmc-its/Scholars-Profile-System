/**
 * Data-sharing ETL — shared types + transform, used by all three entrypoints:
 *   - index.ts  (direct: reciterdb + Sps DB in one process; works once #443 lands)
 *   - export.ts (bridge half 1: reciterdb → S3 NDJSON, runs where reciterdb is reachable)
 *   - import.ts (bridge half 2: S3 NDJSON → Sps DB, runs in-VPC)
 *
 * Keeping the join/build/replace logic here means the direct path and the
 * bridge can't drift — they produce identical rows from identical source data.
 *
 * ponytail: the upstream `reciterdb.dataset_deposit` table doesn't exist yet
 * — it's drafted in wcmc-its/ReCiterDB#131 (dev branch, unmerged), snake_case
 * per that repo's column-naming convention. readSourceRows() below aliases
 * each column back to this file's camelCase `SourceRow` shape. Re-verify
 * against the real table once #131 lands and the table is actually created,
 * before relying on this in a real run.
 */
import { db } from "../../lib/db";
import { withReciterConnection } from "@/lib/sources/reciterdb";

export const INSERT_BATCH = 1000;

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
  accessModel: string | null;
  depositYear: number | string | null;
  provenance: string | null; // 'databank' | 'fulltext-scan'
  confidence: string | null; // 'high' | 'low' | 'unclear'
  authorPosition: string | null; // 'first' | 'last' | 'middle'
  pmid: string | null; // the citing publication for this (cwid, dataset) pair
};

export function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
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
  accessModel: string | null;
  depositYear: number | null;
  provenance: string;
  confidence: string | null;
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
             access_model AS accessModel,
             deposit_year AS depositYear,
             provenance, confidence,
             author_position AS authorPosition,
             pmid
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
    const accessionOrDoi = nonEmpty(r.accessionOrDoi);
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
        id: crypto.randomUUID(),
        repository,
        accessionOrDoi,
        resourceType: nonEmpty(r.resourceType),
        dataType: nonEmpty(r.dataType),
        accessModel: nonEmpty(r.accessModel),
        depositYear: cleanYear(r.depositYear),
        provenance: nonEmpty(r.provenance) ?? "databank",
        confidence: nonEmpty(r.confidence),
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
