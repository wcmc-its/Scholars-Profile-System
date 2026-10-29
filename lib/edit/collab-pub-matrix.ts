/**
 * Report 19 — Collaborative Publication Matrix (EVAL's report of the same
 * name): per center program, how many cancer-relevant publications were
 * inter-programmatic, intra-programmatic, both, inter-institutional or high
 * impact. Types, the URL params and the pure counting, shared by the server
 * body and the xlsx route. DB-free.
 *
 * Definitions (`computeCollabPubMatrix`):
 *   - A member author is a confirmed author holding a membership of the chosen
 *     type whose stint covers the publication date (`isCenterMembershipActive`),
 *     and who is not in an excluded program.
 *   - Universe: `relevant` publications in the period with ≥1 member author.
 *     A program's row counts those with ≥1 member author in that program.
 *   - Inter-programmatic: member authors from ≥2 distinct programs.
 *   - Intra-programmatic: ≥2 member authors in the row's program; on the
 *     unique row, in any one program.
 *   - Inter-institutional: some author lists only non-WCM affiliations
 *     (`externalAuthor`, from PubMed via `etl/center-pub-relevance`).
 *   - High impact: journal `impactScore1` ≥ the threshold the loader passes
 *     (report 3's HIGH_IMPACT_THRESHOLD; that module reads the DB, so it is
 *     not imported here).
 */
import { isCenterMembershipActive } from "@/lib/api/center-member-count";
import { pubRelevanceYears } from "@/lib/edit/pub-relevance-report";

export type MatrixMembershipType = "research" | "clinical" | "any";
const MEMBERSHIP_TYPES: readonly MatrixMembershipType[] = ["research", "clinical", "any"];

export type CollabPubMatrixParams = {
  from: number;
  to: number;
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
  const type = sp.get("type") as MatrixMembershipType | null;
  return {
    from,
    to,
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
  const q = new URLSearchParams({ from: String(p.from), to: String(p.to), type: p.membershipType });
  for (const c of p.excluded) q.append("exclude", c);
  if (p.confirmedOnly) q.set("confirmed", "1");
  return q.toString();
}

export type MatrixMember = {
  cwid: string;
  programCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
  membershipRoleKey: string | null;
};

export type MatrixPub = {
  pmid: string;
  /** YYYY-MM-DD, compared against each author's membership stint. */
  pubDate: string;
  /** Confirmed authors who hold a membership of the chosen type (any stint). */
  memberCwids: string[];
  /** Null: PubMed lists no affiliations, or the ETL has not looked yet. */
  externalAuthor: boolean | null;
  impactScore1: number | null;
};

export type MatrixCounts = {
  publications: number;
  inter: number;
  intra: number;
  interIntra: number;
  interInstitutional: number;
  highImpact: number;
};

export type MatrixProgramRow = { code: string; label: string; counts: MatrixCounts };

export type CollabPubMatrix = {
  unique: MatrixCounts;
  programs: MatrixProgramRow[];
  /** Publications counted whose affiliations are unknown (never inter-institutional). */
  unknownAffiliation: number;
};

const zero = (): MatrixCounts => ({
  publications: 0,
  inter: 0,
  intra: 0,
  interIntra: 0,
  interInstitutional: 0,
  highImpact: 0,
});

function tally(c: MatrixCounts, inter: boolean, intra: boolean, ext: boolean, high: boolean) {
  c.publications++;
  if (inter) c.inter++;
  if (intra) c.intra++;
  if (inter && intra) c.interIntra++;
  if (ext) c.interInstitutional++;
  if (high) c.highImpact++;
}

export function computeCollabPubMatrix(
  pubs: ReadonlyArray<MatrixPub>,
  members: ReadonlyArray<MatrixMember>,
  programs: ReadonlyArray<{ code: string; label: string }>,
  excluded: ReadonlyArray<string>,
  highImpactThreshold: number,
): CollabPubMatrix {
  const out = new Set(excluded);
  const byCwid = new Map(members.map((m) => [m.cwid, m]));
  const rows = programs
    .filter((p) => !out.has(p.code))
    .map((p) => ({ code: p.code, label: p.label, counts: zero() }));
  const rowByCode = new Map(rows.map((r) => [r.code, r.counts]));
  const unique = zero();
  let unknownAffiliation = 0;

  for (const pub of pubs) {
    const authors = [...new Set(pub.memberCwids)]
      .map((c) => byCwid.get(c))
      .filter(
        (m): m is MatrixMember =>
          !!m &&
          isCenterMembershipActive(m, pub.pubDate) &&
          !(m.programCode && out.has(m.programCode)),
      );
    if (authors.length === 0) continue;
    const perProgram = new Map<string, number>();
    for (const m of authors)
      if (m.programCode) perProgram.set(m.programCode, (perProgram.get(m.programCode) ?? 0) + 1);

    const inter = perProgram.size >= 2;
    const ext = pub.externalAuthor === true;
    const high = pub.impactScore1 !== null && pub.impactScore1 >= highImpactThreshold;
    if (pub.externalAuthor === null) unknownAffiliation++;
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
  return { unique, programs: rows, unknownAffiliation };
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
  { key: "interInstitutional", label: "Inter-Institutional" },
  { key: "highImpact", label: "High Impact" },
];

export const UNIQUE_ROW_LABEL = "Unique cancer-relevant publications";
