/**
 * Synonym-file construction with cross-descriptor collision filtering.
 *
 * Spec §1.3 step 4: "Drop entry terms shared across multiple descriptors."
 * Common abbreviations (PCR, CRP, MS) are entry terms under several
 * descriptors. In OpenSearch's equivalent-form synonym graph (no `=>`), any
 * surface form shared across lines transitively connects those lines. A
 * search for "MS" otherwise expands into the union of "Multiple Sclerosis",
 * "Mass Spectrometry", "Magnesium Sulfate", etc., destroying precision.
 *
 * Collision rule (this file is the only place the rule is enforced):
 *   - Build a normalized surface-form → descriptorUi[] map across
 *     descriptor names AND entry terms.
 *   - For each descriptor, keep an entry term ONLY if its normalized form
 *     belongs to exactly that one descriptor's set.
 *   - The descriptor's own preferred `name` is always kept on its line —
 *     it's the canonical surface form. A collision between A's name and B's
 *     entry term drops B's entry term, never A's name.
 *
 * Disambiguation of dropped terms falls through to the resolution layer
 * (spec §1.5), which has explicit tiebreak rules.
 *
 * This module is pure — no I/O, no Prisma, no S3. Unit-tested in
 * tests/unit/mesh-synonyms.test.ts.
 */

export interface DescriptorSynonymInput {
  descriptorUi: string;
  name: string;
  entryTerms: string[];
}

export interface SynonymBuildResult {
  /** One line per descriptor that has ≥1 surviving entry term. Format:
   *  `name, entryTerm1, entryTerm2, ...` (equivalent-form). */
  lines: string[];
  /** Sorted list of normalized surface forms that were dropped because they
   *  mapped to >1 descriptor. Exposed for telemetry / debugging. */
  droppedSurfaceForms: string[];
  /** Count of descriptors that emitted no line (no surviving entry terms). */
  descriptorsWithoutSynonyms: number;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Build the synonyms.txt body from a descriptor list.
 *
 * Output is deterministic for a given input order: descriptors are emitted
 * in the order they appear in `descriptors`; entry terms preserve their
 * input order within each line.
 */
export function buildSynonyms(
  descriptors: readonly DescriptorSynonymInput[],
): SynonymBuildResult {
  // Pass 1: build surface form → descriptor-set map across names + entry terms.
  const surfaceToDescriptors = new Map<string, Set<string>>();
  for (const d of descriptors) {
    const all = [d.name, ...d.entryTerms];
    for (const t of all) {
      const key = normalize(t);
      if (!key) continue;
      let set = surfaceToDescriptors.get(key);
      if (!set) {
        set = new Set();
        surfaceToDescriptors.set(key, set);
      }
      set.add(d.descriptorUi);
    }
  }

  // Identify colliding surface forms (used by ≥2 distinct descriptors).
  const dropped = new Set<string>();
  for (const [key, set] of surfaceToDescriptors) {
    if (set.size > 1) dropped.add(key);
  }

  // Pass 2: build per-descriptor synonym lines.
  const lines: string[] = [];
  let withoutSynonyms = 0;
  for (const d of descriptors) {
    const kept: string[] = [];
    const seenNormalized = new Set<string>([normalize(d.name)]);
    for (const t of d.entryTerms) {
      const key = normalize(t);
      if (!key) continue;
      if (seenNormalized.has(key)) continue;
      seenNormalized.add(key);
      if (dropped.has(key)) continue;
      kept.push(t);
    }
    if (kept.length === 0) {
      withoutSynonyms++;
      continue;
    }
    // Equivalent form: `name, term1, term2` — no `=>`. Commas separate
    // surface forms; OpenSearch's synonym_graph parser treats `, ` and `,`
    // identically. We emit `, ` for human readability.
    lines.push([d.name, ...kept].join(", "));
  }

  return {
    lines,
    droppedSurfaceForms: Array.from(dropped).sort(),
    descriptorsWithoutSynonyms: withoutSynonyms,
  };
}
