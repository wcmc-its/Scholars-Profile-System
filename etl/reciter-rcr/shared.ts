/**
 * RCR bridge — shared types + NDJSON contract, used by both halves:
 *   - export.ts (bridge half 1: reciterdb.analysis_nih → S3 NDJSON, runs where reciterdb reachable)
 *   - import.ts (bridge half 2: S3 NDJSON → Sps DB Publication UPDATEs, runs in-VPC)
 *
 * Why a bridge: `reciterdb.analysis_nih` (NIH iCite RCR / percentile / citation count, keyed by
 * pmid) is reachable from a WCM-side / TGW-attached client but NOT from the in-VPC ETL task
 * (#443 — the in-VPC probe fails with "pool failed to retrieve a connection"); the Sps Aurora is
 * reachable only in-VPC. So the read+write can't happen in one place. This pair closes the gap
 * exactly like the clinical-trials + ED email-visibility bridges.
 *
 * NON-DESTRUCTIVE: unlike the clinical-trials bridge (full-replace), the import only UPDATEs the
 * three bibliometric columns on EXISTING `publication` rows (pmid match); it never deletes or
 * inserts, so an empty or partial export can only fail to enrich, never wipe data.
 *
 * NDJSON contract: one JSON object per line:
 *   { "pmid": "12045110", "rcr": 5.09, "percentile": 92.5, "citedBy": 339 }
 * Any of rcr / percentile / citedBy may be null.
 */

/** One pmid's NIH iCite bibliometrics, as carried over the bridge. */
export type RcrRow = {
  pmid: string;
  rcr: number | null;
  percentile: number | null;
  citedBy: number | null;
};

/** Batch size for the reciterdb `IN (...)` reads (export) and the DB updates (import). */
export const RCR_BATCH = 1000;

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Serialize rows to NDJSON (one object per line, trailing newline). */
export function serializeRcrNdjson(rows: RcrRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Parse NDJSON back to rows; blank + malformed lines are skipped and counted. */
export function parseRcrNdjson(text: string): { rows: RcrRow[]; skipped: number } {
  const rows: RcrRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const pmid = typeof o.pmid === "string" ? o.pmid : o.pmid != null ? String(o.pmid) : null;
      if (!pmid) {
        skipped++;
        continue;
      }
      const num = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
      rows.push({ pmid, rcr: num(o.rcr), percentile: num(o.percentile), citedBy: num(o.citedBy) });
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}
