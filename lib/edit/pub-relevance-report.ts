/**
 * Report 17 — Publication cancer relevance: the review queue for
 * `center_publication_relevance` (`etl/center-pub-relevance`). Types, the
 * status pill and the URL params, shared by the server body, the client table
 * and the PATCH route. DB-free, so the client table can import it.
 */

export type PubRelevanceSource = "rule" | "llm" | "human";

export type PubRelevanceMember = { cwid: string; name: string; programCode: string | null };

export type PubRelevanceRow = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  /** The publication's confirmed authors who are research members of the center. */
  members: PubRelevanceMember[];
  /** Null = the ETL has not decided it yet (new, or its model call failed). */
  relevant: boolean | null;
  source: PubRelevanceSource | null;
  reason: string | null;
};

export type PubRelevanceStatus = "rule" | "ai" | "confirmed" | "not-scored";

export function pubRelevanceStatus(r: Pick<PubRelevanceRow, "source">): PubRelevanceStatus {
  if (r.source === "rule") return "rule";
  if (r.source === "human") return "confirmed";
  if (r.source === "llm") return "ai";
  return "not-scored";
}

export const PUB_RELEVANCE_STATUS_LABEL: Record<PubRelevanceStatus, string> = {
  rule: "MCC rule",
  ai: "AI",
  confirmed: "Confirmed",
  "not-scored": "Not scored",
};

/** Cap on a reviewer's note (the `reason` column is TEXT; this keeps a paste bounded). */
export const PUB_RELEVANCE_REASON_MAX = 2000;

export type PubRelevanceStatusFilter = "all" | PubRelevanceStatus;
const STATUS_FILTERS: readonly PubRelevanceStatusFilter[] = [
  "all",
  "ai",
  "rule",
  "confirmed",
  "not-scored",
];

export type PubRelevanceParams = { year: number; status: PubRelevanceStatusFilter };

/** The years the year select offers, newest first: this one and the three before. */
export function pubRelevanceYears(now = new Date()): number[] {
  const y = now.getUTCFullYear();
  return [y, y - 1, y - 2, y - 3];
}

export function parsePubRelevanceParams(sp: URLSearchParams, now = new Date()): PubRelevanceParams {
  const years = pubRelevanceYears(now);
  const year = Number(sp.get("year"));
  const status = sp.get("status") as PubRelevanceStatusFilter | null;
  return {
    year: years.includes(year) ? year : years[0],
    status: status && STATUS_FILTERS.includes(status) ? status : "all",
  };
}

/** The rows a status filter selects, plus the per-status counts its segments show. */
export function filterPubRelevance(
  rows: ReadonlyArray<PubRelevanceRow>,
  status: PubRelevanceStatusFilter,
): { rows: PubRelevanceRow[]; counts: Record<PubRelevanceStatusFilter, number> } {
  const counts: Record<PubRelevanceStatusFilter, number> = {
    all: rows.length,
    ai: 0,
    rule: 0,
    confirmed: 0,
    "not-scored": 0,
  };
  for (const r of rows) counts[pubRelevanceStatus(r)]++;
  return {
    rows: status === "all" ? [...rows] : rows.filter((r) => pubRelevanceStatus(r) === status),
    counts,
  };
}
