/**
 * Report 19 — Collaborative Publication Matrix (EVAL's report of the same
 * name): per center program, how many cancer-relevant publications were
 * inter-programmatic, intra-programmatic, both, collaborative,
 * inter-institutional or high impact. Types, the URL params and the pure
 * counting, shared by the server body and the xlsx route. DB-free.
 *
 * Definitions (Jackie, 2026-10-29; `computeCollabPubMatrix`):
 *   - Member authors and their programs come from the shared attribution
 *     (`attributeCenterPublications`): members of the chosen type active on
 *     the as-of date, each in their program on that date, on publications
 *     from their WCM tenure. A member in an excluded program is left out.
 *   - Universe: publications in the period marked cancer relevant that are
 *     NOT reviews (`matrixUniverse`). A program's row counts those with ≥1
 *     member author in that program.
 *   - Intra-programmatic: ≥2 member authors in the row's program; on the
 *     unique row, in any one program.
 *   - Inter-programmatic: ≥1 member author in the row's program and ≥1 in
 *     another program; on the unique row, member authors from ≥2 programs.
 *   - Inter + Intra: both. Collaborative: either (= inter + intra − both), the
 *     number MCC reports without double counting.
 *   - Inter-institutional: some author has no WCM affiliation
 *     (`externalAuthor`, from PubMed via `etl/center-pub-relevance`).
 *   - High impact: journal `impactScore1` ≥ the threshold the loader passes
 *     (report 3's HIGH_IMPACT_THRESHOLD; that module reads the DB, so it is
 *     not imported here).
 */
import type {
  AttributedPublication,
  AttributionMembershipType,
} from "@/lib/edit/center-pub-attribution";
import { pubRelevanceYears } from "@/lib/edit/pub-relevance-report";

export type MatrixMembershipType = AttributionMembershipType;
const MEMBERSHIP_TYPES: readonly MatrixMembershipType[] = ["research", "clinical"];

export type CollabPubMatrixParams = {
  from: number;
  to: number;
  /** The reporting date (YYYY-MM-DD) membership and program are read on; default today. */
  asOf: string;
  membershipType: MatrixMembershipType;
  /** Program codes left out: their rows, and their members as member authors. */
  excluded: string[];
  /** Only publications a reviewer confirmed relevant (EVAL's "without author reviews: No"). */
  confirmedOnly: boolean;
};

/** Default period: last calendar year, the one EVAL's annual matrix reports. */
export function parseCollabPubMatrixParams(
  sp: URLSearchParams,
  now = new Date(),
): CollabPubMatrixParams {
  const years = pubRelevanceYears(now);
  const year = (k: string, fallback: number) => {
    const y = Number(sp.get(k));
    return years.includes(y) ? y : fallback;
  };
  const from = year("from", years[1]);
  const to = Math.max(from, year("to", from));
  const type = sp.get("membership") as MatrixMembershipType | null;
  const asOf = sp.get("asOf") ?? "";
  return {
    from,
    to,
    asOf:
      /^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(asOf))
        ? asOf
        : now.toISOString().slice(0, 10),
    membershipType: type && MEMBERSHIP_TYPES.includes(type) ? type : "research",
    excluded: [...new Set(sp.getAll("exclude").filter(Boolean))].sort(),
    confirmedOnly: sp.get("confirmed") === "1",
  };
}

/** The period as EVAL's Report Details prints it. */
export function matrixPeriodLabel(p: Pick<CollabPubMatrixParams, "from" | "to">): string {
  return `01/01/${p.from} through 12/31/${p.to}`;
}

export function collabPubMatrixQuery(p: CollabPubMatrixParams): string {
  const q = new URLSearchParams({
    from: String(p.from),
    to: String(p.to),
    asOf: p.asOf,
    membership: p.membershipType,
  });
  for (const c of p.excluded) q.append("exclude", c);
  if (p.confirmedOnly) q.set("confirmed", "1");
  return q.toString();
}

export type MatrixPub = {
  pmid: string;
  /** The credited member authors (`AttributedPublication.members`). */
  members: ReadonlyArray<{ cwid: string; programCode: string | null; tenureUnknown: boolean }>;
  /** Null: PubMed lists no affiliations, or the ETL has not looked yet. */
  externalAuthor: boolean | null;
  impactScore1: number | null;
};

/** The matrix's publications: cancer relevant and not reviews (Jackie, Q4). */
export function matrixUniverse(
  pubs: ReadonlyArray<AttributedPublication>,
  confirmedOnly: boolean,
): AttributedPublication[] {
  return pubs.filter(
    (p) => p.relevant === true && !p.isReview && (!confirmedOnly || p.relevanceSource === "human"),
  );
}

export type MatrixCounts = {
  publications: number;
  inter: number;
  intra: number;
  interIntra: number;
  collaborative: number;
  interInstitutional: number;
  highImpact: number;
};

export type MatrixProgramRow = { code: string; label: string; counts: MatrixCounts };

export type CollabPubMatrix = {
  unique: MatrixCounts;
  programs: MatrixProgramRow[];
  /** Publications counted whose affiliations are unknown (never inter-institutional). */
  unknownAffiliation: number;
  /** Publications counted only through members of unknown WCM tenure. */
  unknownTenure: number;
};

const zero = (): MatrixCounts => ({
  publications: 0,
  inter: 0,
  intra: 0,
  interIntra: 0,
  collaborative: 0,
  interInstitutional: 0,
  highImpact: 0,
});

function tally(c: MatrixCounts, inter: boolean, intra: boolean, ext: boolean, high: boolean) {
  c.publications++;
  if (inter) c.inter++;
  if (intra) c.intra++;
  if (inter && intra) c.interIntra++;
  if (inter || intra) c.collaborative++;
  if (ext) c.interInstitutional++;
  if (high) c.highImpact++;
}

export function computeCollabPubMatrix(
  pubs: ReadonlyArray<MatrixPub>,
  programs: ReadonlyArray<{ code: string; label: string }>,
  excluded: ReadonlyArray<string>,
  highImpactThreshold: number,
): CollabPubMatrix {
  const out = new Set(excluded);
  const rows = programs
    .filter((p) => !out.has(p.code))
    .map((p) => ({ code: p.code, label: p.label, counts: zero() }));
  const rowByCode = new Map(rows.map((r) => [r.code, r.counts]));
  const unique = zero();
  let unknownAffiliation = 0;
  let unknownTenure = 0;

  for (const pub of pubs) {
    const authors = pub.members.filter((m) => !(m.programCode && out.has(m.programCode)));
    if (authors.length === 0) continue;
    const perProgram = new Map<string, number>();
    for (const m of authors)
      if (m.programCode) perProgram.set(m.programCode, (perProgram.get(m.programCode) ?? 0) + 1);

    const inter = perProgram.size >= 2;
    const ext = pub.externalAuthor === true;
    const high = pub.impactScore1 !== null && pub.impactScore1 >= highImpactThreshold;
    if (pub.externalAuthor === null) unknownAffiliation++;
    if (authors.every((m) => m.tenureUnknown)) unknownTenure++;
    tally(
      unique,
      inter,
      [...perProgram.values()].some((n) => n >= 2),
      ext,
      high,
    );
    for (const [code, n] of perProgram) {
      const c = rowByCode.get(code);
      if (c) tally(c, inter, n >= 2, ext, high);
    }
  }
  return { unique, programs: rows, unknownAffiliation, unknownTenure };
}

/** A count as a whole percent of its row's publications, as EVAL prints it. */
export function matrixPct(n: number, of: number): string {
  return `${of === 0 ? 0 : Math.round((100 * n) / of)}%`;
}

export const MATRIX_COLUMNS: ReadonlyArray<{
  key: Exclude<keyof MatrixCounts, "publications">;
  label: string;
}> = [
  { key: "inter", label: "Inter-Programmatic" },
  { key: "intra", label: "Intra-Programmatic" },
  { key: "interIntra", label: "Inter + Intra" },
  { key: "collaborative", label: "Collaborative" },
  { key: "interInstitutional", label: "Inter-Institutional" },
  { key: "highImpact", label: "High Impact" },
];

export const UNIQUE_ROW_LABEL = "Unique cancer-relevant publications";
