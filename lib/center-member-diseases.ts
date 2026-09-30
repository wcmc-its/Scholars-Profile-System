/**
 * Public center page — a member's PUBLISHED curated diseases (D1: they sit
 * BESIDE topics, never replace `TopicAssignment` / the TOPICS row). Built
 * server-side by `lib/api/centers.ts` and read by the Scholars tab's "Disease
 * focus" facet and the card's DISEASES row.
 *
 * Pure and client-safe: no `@/lib/db`, no prisma. The publish rule is the ONE
 * shared predicate `isDiseasePublished` (`lib/cancer-center-disease-publish.ts`),
 * the same one the /edit roster uses.
 */
import { isDiseasePublished } from "@/lib/cancer-center-disease-publish";
import { diseaseLabel } from "@/lib/cancer-center-disease-labels";

export type CenterMemberDisease = {
  diseaseCode: string;
  label: string;
  /** The generator's focus tier (primary | secondary | peripheral), or null for
   *  a curator's manual add (a confirmed decision with no assignment row) —
   *  focus unknown, so it is treated as non-primary. */
  focus: string | null;
  /** The generator's rank (1 = strongest); null for a manual add. */
  rank: number | null;
};

/** The assignment fields the public merge reads. */
export type DiseaseAssignmentInput = {
  cwid: string;
  diseaseCode: string;
  rank: number;
  focus: string;
  confidence: string;
};

/** The decision fields the public merge reads. */
export type DiseaseDecisionInput = {
  cwid: string;
  diseaseCode: string;
  decision: string;
};

/** Primary focus first, then rank ascending (a manual add, rank null, last),
 *  then label — the order the card chips render in. */
export function compareMemberDiseases(a: CenterMemberDisease, b: CenterMemberDisease): number {
  const pa = a.focus === "primary" ? 0 : 1;
  const pb = b.focus === "primary" ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const ra = a.rank ?? Number.POSITIVE_INFINITY;
  const rb = b.rank ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  return a.label.localeCompare(b.label);
}

/**
 * Merge a roster's assignment and decision rows per (cwid, diseaseCode) and
 * keep only the published ones. Keys off BOTH tables independently (same as
 * `unit-edit-context.ts`), so a decision-only manual add is never dropped.
 * Returns cwid -> sorted diseases; a cwid with none published is absent.
 */
export function buildPublishedDiseasesByCwid(
  assignments: ReadonlyArray<DiseaseAssignmentInput>,
  decisions: ReadonlyArray<DiseaseDecisionInput>,
  autoPublish: boolean,
): Map<string, CenterMemberDisease[]> {
  type Pair = {
    cwid: string;
    diseaseCode: string;
    assignment: DiseaseAssignmentInput | null;
    decision: DiseaseDecisionInput | null;
  };
  const pairs = new Map<string, Pair>();
  const pairOf = (cwid: string, diseaseCode: string): Pair => {
    const key = `${cwid}\u0000${diseaseCode}`;
    let p = pairs.get(key);
    if (!p) {
      p = { cwid, diseaseCode, assignment: null, decision: null };
      pairs.set(key, p);
    }
    return p;
  };
  for (const a of assignments) pairOf(a.cwid, a.diseaseCode).assignment = a;
  for (const d of decisions) pairOf(d.cwid, d.diseaseCode).decision = d;

  const out = new Map<string, CenterMemberDisease[]>();
  for (const p of pairs.values()) {
    if (!isDiseasePublished(p, autoPublish)) continue;
    const list = out.get(p.cwid) ?? [];
    list.push({
      diseaseCode: p.diseaseCode,
      label: diseaseLabel(p.diseaseCode),
      focus: p.assignment?.focus ?? null,
      rank: p.assignment?.rank ?? null,
    });
    out.set(p.cwid, list);
  }
  for (const list of out.values()) list.sort(compareMemberDiseases);
  return out;
}
