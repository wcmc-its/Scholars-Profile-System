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
/**
 * Nested children of a research-type facet value, split on the people doc's
 * `isPhysician`. URL values are `<kind>:physician` / `<kind>:other`; a bare
 * `<kind>` is the parent. Positive labels only.
 */
export type ResearchTypeChild = "physician" | "other";
export const RESEARCH_TYPE_CHILD_LABELS: Record<ResearchType, Record<ResearchTypeChild, string>> = {
  lab: { physician: "Physician-scientist", other: "Basic scientist" },
  clinical: { physician: "Physician-scientist", other: "Clinical or population researcher" },
};

/** Split a facet value into kind and optional child. Null for anything else. */
export function parseResearchTypeValue(
  v: string,
): { kind: ResearchType; child?: ResearchTypeChild } | null {
  const [kind, child, ...rest] = v.split(":");
  if (rest.length > 0 || !Object.hasOwn(RESEARCH_TYPE_LABELS, kind)) return null;
  if (child === undefined) return { kind: kind as ResearchType };
  if (child !== "physician" && child !== "other") return null;
  return { kind: kind as ResearchType, child };
}

/** Display label for a facet value; unknown values pass through. A child reads
 *  "Laboratory research: Physician-scientist". */
export function researchTypeLabel(v: string): string {
  const p = parseResearchTypeValue(v);
  if (!p) return v;
  const parent = RESEARCH_TYPE_LABELS[p.kind];
  return p.child ? `${parent}: ${RESEARCH_TYPE_CHILD_LABELS[p.kind][p.child]}` : parent;
}

/** Child values collapse to their parent kind (nested flag off). Deduped,
 *  order kept; unknown values pass through. */
export function collapseResearchTypeChildren(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const p = parseResearchTypeValue(v);
    const next = p ? p.kind : v;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** Whether a facet row reads as ticked. A ticked parent ticks its children too:
 *  "Laboratory research" is every laboratory researcher, both kinds. */
export function isResearchTypeChecked(active: readonly string[], value: string): boolean {
  if (active.includes(value)) return true;
  const p = parseResearchTypeValue(value);
  return !!p?.child && active.includes(p.kind);
}

/** Toggle one facet value, keeping the URL in its shortest form:
 *  - unticking a child of a ticked parent leaves the sibling child;
 *  - ticking the second child of a parent is the parent;
 *  - ticking a child drops its parent, ticking a parent drops its children. */
export function toggleResearchTypeValue(current: readonly string[], value: string): string[] {
  const p = parseResearchTypeValue(value);
  if (p?.child) {
    const sibling = `${p.kind}:${p.child === "physician" ? "other" : "physician"}`;
    if (current.includes(p.kind)) return [...current.filter((v) => v !== p.kind), sibling];
    if (!current.includes(value) && current.includes(sibling))
      return [...current.filter((v) => v !== sibling), p.kind];
  }
  if (current.includes(value)) return current.filter((v) => v !== value);
  const kept = current.filter((v) => {
    const q = parseResearchTypeValue(v);
    if (!p || !q || q.kind !== p.kind) return true;
    // Same kind: a child replaces the parent, a parent replaces the children.
    return p.child ? q.child !== undefined : q.child === undefined;
  });
  return [...kept, value];
}

/** Research type child rows for one parent facet bucket: physician first,
 *  then other. Empty when the nested flag is off (no child counts) or before
 *  the reindex (both 0). A zero-count child is shown only while it is ticked. */
export function researchTypeChildRows(
  b: { value: string; physician?: number; other?: number },
  active: readonly string[],
): { value: string; label: string; count: number; isActive: boolean }[] {
  const p = parseResearchTypeValue(b.value);
  if (!p || p.child || b.physician === undefined || b.other === undefined) return [];
  if (b.physician + b.other === 0) return [];
  const kind = p.kind;
  const counts = { physician: b.physician, other: b.other };
  return (["physician", "other"] as const)
    .map((child) => ({
      value: `${kind}:${child}`,
      label: RESEARCH_TYPE_CHILD_LABELS[kind][child],
      count: counts[child],
      isActive: isResearchTypeChecked(active, `${kind}:${child}`),
    }))
    .filter((c) => c.count > 0 || c.isActive);
}

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
