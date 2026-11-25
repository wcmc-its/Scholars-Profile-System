/**
 * Systematic review rule for the method-family import (`METHOD_FAMILY_SR_RULE`).
 *
 * The A2 artifact only extracts methods from "Academic Article" papers with a
 * faculty first or last author, so the family "Systematic review and
 * meta-analysis" holds a fraction of the papers that belong in it. The weekly
 * job etl/pubmed-systematic-reviews records which corpus pmids PubMed's own
 * systematic review filter matches (`pubmed_systematic_review`). This module
 * merges that rule-based membership into the mapper's `scholar_family` writes
 * for that ONE family, before the volume guard and the table replace.
 *
 * Which papers: a flagged pmid qualifies only when at least one of its CONFIRMED
 * authors is an active scholar who is full-time faculty.
 * Who is credited: every active scholar who is a confirmed author of a
 * qualifying pmid, in any author position, faculty or not.
 *
 * Pure and client-free (no Prisma import): etl/tools/index.ts supplies the reads
 * through the loader callbacks, so the whole rule, including the flag-off path,
 * is unit-tested without a database.
 */
import { createHash } from "node:crypto";
import {
  compareFamilyRank,
  type FamilyDefinitionIndex,
  type ScholarFamilyWrite,
} from "./scholar-family-mapper-s3";

/** ETL-only flag. Exactly "on" enables the rule; anything else (or unset) is off. */
export const SR_RULE_FLAG = "METHOD_FAMILY_SR_RULE";
/** The A2 supercategory id the family sits under. */
export const SR_FAMILY_SUPERCATEGORY = "computational_statistical";
/** The family label looked for; compared after {@link normalizeFamilyLabel}. */
export const SR_FAMILY_LABEL = "systematic review and meta-analysis";

export function isSystematicReviewRuleOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Read by its literal name so scripts/release/flag-parity.mjs sees the key.
  return env.METHOD_FAMILY_SR_RULE === "on";
}

/**
 * The value etl:scholar-tool stores in `etl_run.manifestSha256` and compares on
 * the next run to decide whether to short-circuit. Flag off: the artifact
 * signature itself, unchanged. Flag on: a different 64-char hex digest of it.
 * So flipping the flag in either direction mismatches the last run's stored
 * value and forces exactly one rebuild, which is what applies the rule after it
 * is turned on and removes the rule's rows after it is turned off.
 */
export function toolsRunSignature(
  artifactSignature: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!isSystematicReviewRuleOn(env)) return artifactSignature;
  return createHash("sha256").update(`${artifactSignature}:sr=on`).digest("hex");
}

/** The slice of ADR-005 publication suppressions the rule honours (structurally
 *  the `PublicationSuppressions` the mappers take). */
export type RuleSuppressions = {
  /** pmids under a whole-publication takedown. */
  readonly darkPmids: ReadonlySet<string>;
  /** pmid -> cwids whose authorship of it is hidden. */
  readonly hiddenAuthorsByPmid: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Case-fold, turn hyphens/underscores into spaces, collapse whitespace. */
export function normalizeFamilyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[-_‐-―]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SR_FAMILY_LABEL_KEY = normalizeFamilyLabel(SR_FAMILY_LABEL);

/** Whether a family label is the systematic review family's, spelling aside. */
function isSystematicReviewLabel(label: string): boolean {
  return normalizeFamilyLabel(label) === SR_FAMILY_LABEL_KEY;
}

/** The identity a rule-created row carries: the same five fields the mapper
 *  stamps on an artifact row for this family. */
export type FamilyIdentity = {
  familyId: string;
  familyLabel: string;
  supercategory: string;
  definition: string | null;
  definitionSource: string | null;
};

/**
 * Find the systematic review family in the ARTIFACT's top-level `families[]`
 * registry. `family_id` is re-minted on A2 rebuilds, so the match is on
 * (supercategory, normalised label), never on an id. `label` and `supercategory`
 * are trimmed exactly as the mapper trims the per-scholar slice; the definition
 * comes from the same `familyDefById` join the mapper uses.
 *
 * If the registry holds more than one matching entry (duplicate ids for one
 * stable family, the #989 shape), the one most existing writes already use wins,
 * then the lowest `family_id`, so rule rows land on the id artifact rows carry.
 */
export function findSystematicReviewFamily(
  registry: unknown,
  opts: { familyDefById?: FamilyDefinitionIndex; writes?: readonly ScholarFamilyWrite[] } = {},
): { identity: FamilyIdentity; matches: number } | null {
  const candidates: { familyId: string; familyLabel: string; supercategory: string }[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(registry) ? registry : []) {
    const f = raw as { family_id?: unknown; label?: unknown; supercategory?: unknown } | null;
    const familyId = typeof f?.family_id === "string" ? f.family_id.trim() : "";
    const familyLabel = typeof f?.label === "string" ? f.label.trim() : "";
    const supercategory = typeof f?.supercategory === "string" ? f.supercategory.trim() : "";
    if (!familyId || !familyLabel || seen.has(familyId)) continue;
    if (supercategory !== SR_FAMILY_SUPERCATEGORY) continue;
    if (!isSystematicReviewLabel(familyLabel)) continue;
    seen.add(familyId);
    candidates.push({ familyId, familyLabel, supercategory });
  }
  if (candidates.length === 0) return null;

  const uses = new Map<string, number>();
  for (const w of opts.writes ?? []) {
    if (seen.has(w.familyId)) uses.set(w.familyId, (uses.get(w.familyId) ?? 0) + 1);
  }
  candidates.sort(
    (a, b) =>
      (uses.get(b.familyId) ?? 0) - (uses.get(a.familyId) ?? 0) ||
      a.familyId.localeCompare(b.familyId),
  );
  const best = candidates[0];
  const def = opts.familyDefById?.get(best.familyId);
  return {
    identity: {
      ...best,
      definition: def?.definition ?? null,
      definitionSource: def?.definitionSource ?? null,
    },
    matches: candidates.length,
  };
}

export type SystematicReviewRuleCounters = {
  /** Distinct usable pmids in `pubmed_systematic_review`. */
  flaggedPmids: number;
  /** Flagged pmids with at least one active full-time-faculty confirmed author. */
  qualifyingPmids: number;
  /** Active scholars who are a confirmed author of a qualifying pmid. */
  scholarsCredited: number;
  /** Credited scholars who had no row for the family and got one. */
  rowsCreated: number;
  /** Existing family rows that gained at least one pmid. */
  rowsExtended: number;
  /** Existing family rows that already held every one of the scholar's pmids. */
  rowsUnchanged: number;
  /** Confirmed authorships of flagged pmids ignored because the paper is taken
   *  down or the scholar hid their authorship of it (ADR-005). */
  suppressedAuthorships: number;
  /** Pmids added across created and extended rows. */
  pmidsAdded: number;
  /** Rows (any family) dropped when the per-scholar cap was re-applied. */
  rowsDroppedByCap: number;
  /** Existing rows for the family whose label is not byte-equal to the registry
   *  label. Public pages group on the exact label, so non-zero means rule-created
   *  rows would sit apart from those rows. Should be 0. */
  labelDriftRows: number;
};

function emptyCounters(): SystematicReviewRuleCounters {
  return {
    flaggedPmids: 0,
    qualifyingPmids: 0,
    scholarsCredited: 0,
    rowsCreated: 0,
    rowsExtended: 0,
    rowsUnchanged: 0,
    suppressedAuthorships: 0,
    pmidsAdded: 0,
    rowsDroppedByCap: 0,
    labelDriftRows: 0,
  };
}

/** Digit-string pmid, or "" when the value is not one (the mapper's rule). */
function toPmid(v: unknown): string {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  return "";
}

/** Distinct pmids in ascending numeric order (shorter digit strings first). */
function sortedDistinctPmids(pmids: Iterable<string>): string[] {
  return [...new Set(pmids)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

export type SystematicReviewRuleInput = {
  /** The mapper's writes. Never mutated. */
  writes: readonly ScholarFamilyWrite[];
  /** Every pmid in `pubmed_systematic_review`. */
  flaggedPmids: Iterable<string>;
  /** CONFIRMED (pmid, cwid) authorship pairs for the flagged pmids. */
  authorships: Iterable<{ pmid: string; cwid: string | null }>;
  /** Active scholars who are full-time faculty. */
  fullTimeFacultyCwids: ReadonlySet<string>;
  /** Active scholars: the mapper's `ourCwidSet` (also the FK scope of the table). */
  activeCwids: ReadonlySet<string>;
  family: FamilyIdentity;
  /** The mapper's per-scholar cap. */
  topN: number;
  /** Active ADR-005 publication suppressions. A taken-down paper qualifies for
   *  no one; a scholar who hid their authorship of a paper neither qualifies it
   *  nor is credited with it. Omit for no filter. */
  suppression?: RuleSuppressions;
};

/**
 * Merge rule-based membership into the family writes. Returns the SAME array
 * when there is nothing to merge; otherwise a new array in which scholars the
 * rule did not touch keep their rows and their order untouched.
 */
export function applySystematicReviewRule(input: SystematicReviewRuleInput): {
  writes: ScholarFamilyWrite[];
  counters: SystematicReviewRuleCounters;
} {
  const { family, activeCwids, fullTimeFacultyCwids, topN, suppression } = input;
  const counters = emptyCounters();
  const original = input.writes as ScholarFamilyWrite[];

  const flagged = new Set<string>();
  for (const p of input.flaggedPmids) {
    const pmid = toPmid(p);
    if (pmid) flagged.add(pmid);
  }
  counters.flaggedPmids = flagged.size;
  if (flagged.size === 0) return { writes: original, counters };

  // pmid -> its active confirmed authors, and whether one of them is full-time faculty.
  const authorsByPmid = new Map<string, Set<string>>();
  const qualifying = new Set<string>();
  for (const a of input.authorships) {
    const pmid = toPmid(a.pmid);
    const cwid = typeof a.cwid === "string" ? a.cwid : "";
    if (!pmid || !cwid || !flagged.has(pmid) || !activeCwids.has(cwid)) continue;
    // ADR-005: dropped before both the qualifying and the credit step, so a
    // hidden authorship never adds a pmid, raises a count or creates a row.
    if (
      suppression &&
      (suppression.darkPmids.has(pmid) ||
        (suppression.hiddenAuthorsByPmid.get(pmid)?.has(cwid) ?? false))
    ) {
      counters.suppressedAuthorships += 1;
      continue;
    }
    let set = authorsByPmid.get(pmid);
    if (!set) authorsByPmid.set(pmid, (set = new Set()));
    set.add(cwid);
    if (fullTimeFacultyCwids.has(cwid)) qualifying.add(pmid);
  }
  counters.qualifyingPmids = qualifying.size;
  if (qualifying.size === 0) return { writes: original, counters };

  const pmidsByCwid = new Map<string, string[]>();
  for (const pmid of qualifying) {
    for (const cwid of authorsByPmid.get(pmid) ?? []) {
      const list = pmidsByCwid.get(cwid);
      if (list) list.push(pmid);
      else pmidsByCwid.set(cwid, [pmid]);
    }
  }
  counters.scholarsCredited = pmidsByCwid.size;

  // Group the mapper's rows per scholar, keeping first-appearance order.
  const rowsByCwid = new Map<string, ScholarFamilyWrite[]>();
  for (const w of original) {
    const rows = rowsByCwid.get(w.cwid);
    if (rows) rows.push(w);
    else rowsByCwid.set(w.cwid, [w]);
    if (
      w.supercategory === family.supercategory &&
      w.familyLabel !== family.familyLabel &&
      (w.familyId === family.familyId || isSystematicReviewLabel(w.familyLabel))
    ) {
      counters.labelDriftRows += 1;
    }
  }

  const touched = new Set<string>();
  // Sorted so scholars the artifact did not carry are appended deterministically.
  for (const cwid of [...pmidsByCwid.keys()].sort()) {
    const rulePmids = pmidsByCwid.get(cwid)!;
    let rows = rowsByCwid.get(cwid);
    if (!rows) rowsByCwid.set(cwid, (rows = []));

    // The scholar's row for this family: by the registry id, else by the stable
    // (supercategory, label) identity, so a scholar never ends up with two rows.
    let at = rows.findIndex((r) => r.familyId === family.familyId);
    if (at === -1) {
      at = rows.findIndex(
        (r) =>
          r.supercategory === family.supercategory && isSystematicReviewLabel(r.familyLabel),
      );
    }

    if (at === -1) {
      const pmids = sortedDistinctPmids(rulePmids);
      // Same shape the mapper emits for a family with no exemplars.
      rows.push({
        cwid,
        familyId: family.familyId,
        familyLabel: family.familyLabel,
        supercategory: family.supercategory,
        pmidCount: pmids.length,
        exemplarTools: [],
        exemplarContexts: {},
        exemplarContextPmids: {},
        pmids,
        definition: family.definition,
        definitionSource: family.definitionSource,
      });
      counters.rowsCreated += 1;
      counters.pmidsAdded += pmids.length;
      touched.add(cwid);
      continue;
    }

    const existing = rows[at];
    const have = new Set(existing.pmids);
    const added = rulePmids.filter((p) => !have.has(p)).length;
    if (added === 0) {
      counters.rowsUnchanged += 1;
      continue;
    }
    const pmids = sortedDistinctPmids([...existing.pmids, ...rulePmids]);
    rows[at] = { ...existing, pmids, pmidCount: pmids.length };
    counters.rowsExtended += 1;
    counters.pmidsAdded += added;
    touched.add(cwid);
  }

  if (touched.size === 0) return { writes: original, counters };

  const out: ScholarFamilyWrite[] = [];
  for (const [cwid, rows] of rowsByCwid) {
    if (!touched.has(cwid)) {
      out.push(...rows);
      continue;
    }
    // Counts moved, so re-rank and re-apply the mapper's per-scholar cap.
    const ranked = [...rows].sort(compareFamilyRank);
    counters.rowsDroppedByCap += Math.max(0, ranked.length - topN);
    out.push(...ranked.slice(0, topN));
  }
  return { writes: out, counters };
}

export type SystematicReviewRuleOutcome =
  /** Flag off: `writes` is the caller's array, and nothing was read. */
  | { status: "off"; writes: ScholarFamilyWrite[] }
  /** Flag on but `pubmed_systematic_review` is empty (its job has not run yet). */
  | { status: "skipped_empty"; writes: ScholarFamilyWrite[]; family: FamilyIdentity }
  | {
      status: "applied";
      writes: ScholarFamilyWrite[];
      family: FamilyIdentity;
      /** Registry entries that matched; more than 1 is an upstream duplicate. */
      registryMatches: number;
      counters: SystematicReviewRuleCounters;
    };

/**
 * The rule end to end, with the reads injected. Order matters:
 *   1. flag off  -> return the caller's writes untouched, call no loader;
 *   2. no family in the registry -> THROW (before any read, and before the
 *      caller's volume guard or table replace, so the previous rows survive);
 *   3. no flagged pmids -> `skipped_empty` (the caller logs a warning);
 *   4. otherwise load authorships for the flagged pmids only and merge.
 */
export async function runSystematicReviewRule(opts: {
  env?: Record<string, string | undefined>;
  writes: ScholarFamilyWrite[];
  /** The artifact's top-level `families[]`. */
  registry: unknown;
  familyDefById?: FamilyDefinitionIndex;
  activeCwids: ReadonlySet<string>;
  topN: number;
  /** Active ADR-005 publication suppressions (see {@link RuleSuppressions}). */
  suppression?: RuleSuppressions;
  loadFlaggedPmids: () => Promise<string[]>;
  loadFullTimeFacultyCwids: () => Promise<ReadonlySet<string>>;
  /** Confirmed (pmid, cwid) pairs for exactly these pmids. */
  loadConfirmedAuthorships: (
    pmids: string[],
  ) => Promise<Array<{ pmid: string; cwid: string | null }>>;
}): Promise<SystematicReviewRuleOutcome> {
  if (!isSystematicReviewRuleOn(opts.env)) return { status: "off", writes: opts.writes };

  const found = findSystematicReviewFamily(opts.registry, {
    familyDefById: opts.familyDefById,
    writes: opts.writes,
  });
  if (!found) {
    throw new Error(
      `${SR_RULE_FLAG} is on but the artifact's families[] registry has no family ` +
        `"${SR_FAMILY_LABEL}" under supercategory "${SR_FAMILY_SUPERCATEGORY}"; ` +
        `nothing was written.`,
    );
  }

  const flaggedPmids = await opts.loadFlaggedPmids();
  if (flaggedPmids.length === 0) {
    return { status: "skipped_empty", writes: opts.writes, family: found.identity };
  }

  const [fullTimeFacultyCwids, authorships] = await Promise.all([
    opts.loadFullTimeFacultyCwids(),
    opts.loadConfirmedAuthorships(flaggedPmids),
  ]);
  const { writes, counters } = applySystematicReviewRule({
    writes: opts.writes,
    flaggedPmids,
    authorships,
    fullTimeFacultyCwids,
    activeCwids: opts.activeCwids,
    family: found.identity,
    topN: opts.topN,
    suppression: opts.suppression,
  });
  return {
    status: "applied",
    writes,
    family: found.identity,
    registryMatches: found.matches,
    counters,
  };
}
