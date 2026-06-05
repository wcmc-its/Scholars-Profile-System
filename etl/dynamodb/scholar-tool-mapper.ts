/**
 * Pure mapper: ReciterAI `TOOL#` DynamoDB items → `scholar_tool` rollup rows
 * (#742 v3.1 C3). Kept side-effect-free + unit-tested, mirroring
 * `publication-topic-mapper.ts`, so the grouping/ranking is verifiable without a
 * DDB scan or a DB.
 *
 * Each `TOOL#` item is one (tool × pmid × cwid) observation:
 *   PK = `TOOL#<tool_id>`  (tool_id ≈ the tool name, `/` and `#` sanitized to `_`)
 *   SK = `SCORE#<conf>#ACTIVITY#pmid_<pmid>#cwid_<cwid>`
 *   attrs: faculty_uid = `cwid_<cwid>`, score (0–1 confidence), pmid, tool_category, context
 *
 * We fold those into one row per (cwid, tool): distinct-pmid count, max
 * confidence, a representative context, the contributing pmids (linkage), and
 * keep the top-N tools per scholar so the table stays bounded.
 */

/** The subset of a `TOOL#` item this mapper reads. */
export type ToolRecordLike = {
  PK: string; // TOOL#<tool_id>
  faculty_uid?: string | null; // "cwid_<cwid>"
  pmid?: string | number | null;
  tool_category?: string | null;
  context?: string | null;
  score?: number | null;
  [key: string]: unknown;
};

/** One `scholar_tool` row to upsert (the ETL converts `maxConfidence` to Decimal). */
export type ScholarToolWrite = {
  cwid: string;
  toolName: string;
  category: string | null;
  pmidCount: number;
  maxConfidence: number;
  sampleContext: string | null;
  pmids: string[];
};

export type BuildScholarToolResult = {
  writes: ScholarToolWrite[];
  skippedMissingCwid: number;
  skippedMissingFields: number;
};

/** `cwid_abc123` → `abc123`; null/blank/garbage → "". */
function parseCwid(facultyUid: string | null | undefined): string {
  if (typeof facultyUid !== "string") return "";
  const m = facultyUid.match(/^cwid_(.+)$/);
  return m ? m[1] : "";
}

/** `TOOL#AAV vectors` → `AAV vectors`. Returns "" for a non-TOOL# PK. */
function parseToolName(pk: string): string {
  if (typeof pk !== "string" || !pk.startsWith("TOOL#")) return "";
  return pk.slice("TOOL#".length).trim();
}

/** Coerce a pmid (number or numeric string) to a digit string, else "". */
function normPmid(pmid: string | number | null | undefined): string {
  if (typeof pmid === "number" && Number.isFinite(pmid)) return String(pmid);
  if (typeof pmid === "string" && /^\d+$/.test(pmid.trim())) return pmid.trim();
  return "";
}

type Accum = {
  cwid: string;
  toolName: string;
  category: string | null;
  pmids: Set<string>;
  maxConfidence: number;
  sampleContext: string | null;
};

/**
 * Build the `scholar_tool` rollup writes from a flat list of `TOOL#` items.
 *
 * - Skips items whose cwid is not in `ourCwidSet` (FK scope, like the other ETL
 *   blocks) and items missing a tool name or pmid.
 * - Groups by (cwid, tool), accumulating distinct pmids, the max confidence, the
 *   first non-empty category + context.
 * - Keeps the top `topNPerScholar` tools per scholar by (pmidCount, maxConfidence).
 */
export function buildScholarToolWrites(
  items: ToolRecordLike[],
  opts: { ourCwidSet: Set<string>; topNPerScholar?: number },
): BuildScholarToolResult {
  const topN = opts.topNPerScholar ?? 30;
  const byKey = new Map<string, Accum>();
  let skippedMissingCwid = 0;
  let skippedMissingFields = 0;

  for (const it of items) {
    const toolName = parseToolName(it.PK);
    const pmid = normPmid(it.pmid);
    if (!toolName || !pmid) {
      skippedMissingFields += 1;
      continue;
    }
    const cwid = parseCwid(it.faculty_uid);
    if (!cwid || !opts.ourCwidSet.has(cwid)) {
      skippedMissingCwid += 1;
      continue;
    }
    const key = `${cwid}\u0000${toolName}`;
    const entry: Accum = byKey.get(key) ?? {
      cwid,
      toolName,
      category: null,
      pmids: new Set<string>(),
      maxConfidence: 0,
      sampleContext: null,
    };
    entry.pmids.add(pmid);
    const score = typeof it.score === "number" && Number.isFinite(it.score) ? it.score : 0;
    if (score > entry.maxConfidence) entry.maxConfidence = score;
    if (entry.category === null && typeof it.tool_category === "string" && it.tool_category) {
      entry.category = it.tool_category;
    }
    if (entry.sampleContext === null && typeof it.context === "string" && it.context) {
      entry.sampleContext = it.context;
    }
    byKey.set(key, entry);
  }

  // Group by scholar, rank, keep the top N tools each.
  const byCwid = new Map<string, Accum[]>();
  for (const entry of byKey.values()) {
    const list = byCwid.get(entry.cwid) ?? [];
    list.push(entry);
    byCwid.set(entry.cwid, list);
  }

  const writes: ScholarToolWrite[] = [];
  for (const list of byCwid.values()) {
    list.sort((a, b) => b.pmids.size - a.pmids.size || b.maxConfidence - a.maxConfidence);
    for (const e of list.slice(0, topN)) {
      writes.push({
        cwid: e.cwid,
        toolName: e.toolName,
        category: e.category,
        pmidCount: e.pmids.size,
        maxConfidence: e.maxConfidence,
        sampleContext: e.sampleContext,
        pmids: Array.from(e.pmids),
      });
    }
  }

  return { writes, skippedMissingCwid, skippedMissingFields };
}
