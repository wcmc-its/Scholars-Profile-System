/**
 * "Research type" — what kind of research a scholar's OWN recent papers are,
 * from the NIH iCite translational triangle (`reciterdb.analysis_nih`:
 * `human` / `animal` / `molecular_cellular` fractions, `is_clinical`).
 *
 * Measured as VOLUME (a count of papers), never an average share: someone with
 * 12 lab papers and 30 clinical ones does both, and a mean would hide the lab.
 * Tags are therefore multi-valued — a scholar can hold both or neither.
 *
 * Counts land on `Scholar.labPubs5y` / `clinicalPubs5y` (reciter ETL); the
 * threshold is applied at index time, so it re-tunes with a reindex, no
 * reciter re-run. Pure and dependency-free (client-safe for the label map).
 */

/** Window: papers with an iCite `year` ≥ current year − 5. */
export const RESEARCH_TYPE_YEARS = 5;
/** Minimum first/last-author research articles in the window to earn a tag. */
export const RESEARCH_TYPE_MIN_PUBS = 3;

export const RESEARCH_TYPE_LABELS = {
  lab: "Laboratory research",
  clinical: "Clinical research",
} as const;
export type ResearchType = keyof typeof RESEARCH_TYPE_LABELS;
export const RESEARCH_TYPES = Object.keys(RESEARCH_TYPE_LABELS) as ResearchType[];

/** The `analysis_nih` columns this needs (mariadb returns the flags as 'True'/'False'). */
export type NihTriangleRow = {
  year: number | null;
  is_research_article: string | null;
  is_clinical: string | null;
  human: number | null;
  animal: number | null;
  molecular_cellular: number | null;
};

export function isLabPub(n: NihTriangleRow): boolean {
  return (
    n.is_research_article === "True" &&
    (Number(n.molecular_cellular) || 0) + (Number(n.animal) || 0) >= 0.5
  );
}

export function isClinicalPub(n: NihTriangleRow): boolean {
  return (
    n.is_research_article === "True" &&
    ((Number(n.human) || 0) >= 0.5 || n.is_clinical === "True")
  );
}

export type ResearchVolume = { lab: number; clinical: number };

/**
 * Per-cwid lab / clinical paper counts over first- or last-author rows whose
 * pmid has an iCite row in the window. Every cwid in `cwids` gets an entry
 * (0/0 when nothing qualifies) so a computed zero is distinguishable from a
 * never-computed NULL on Scholar.
 */
export function researchVolumeByCwid(
  authorships: ReadonlyArray<{ pmid: string; cwid: string; isFirst: boolean; isLast: boolean }>,
  nihByPmid: ReadonlyMap<number, NihTriangleRow>,
  cwids: Iterable<string>,
  minYear: number,
): Map<string, ResearchVolume> {
  const out = new Map<string, ResearchVolume>();
  for (const c of cwids) out.set(c, { lab: 0, clinical: 0 });
  const seen = new Set<string>();
  for (const a of authorships) {
    if (!a.isFirst && !a.isLast) continue;
    const n = nihByPmid.get(Number(a.pmid));
    if (!n || n.year == null || n.year < minYear) continue;
    const key = `${a.pmid}|${a.cwid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = out.get(a.cwid);
    if (!v) continue;
    if (isLabPub(n)) v.lab++;
    if (isClinicalPub(n)) v.clinical++;
  }
  return out;
}

/** Index-time tags. NULL counts (never computed) yield no tag. */
export function researchTypesFrom(
  labPubs5y: number | null | undefined,
  clinicalPubs5y: number | null | undefined,
): ResearchType[] {
  const out: ResearchType[] = [];
  if ((labPubs5y ?? 0) >= RESEARCH_TYPE_MIN_PUBS) out.push("lab");
  if ((clinicalPubs5y ?? 0) >= RESEARCH_TYPE_MIN_PUBS) out.push("clinical");
  return out;
}
