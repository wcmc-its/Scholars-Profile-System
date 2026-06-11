/**
 * Pure ranking + CSV rendering for the MeSH family-anchor seed generator
 * (issue #879). Kept separate from seed-generate.ts (which runs DB queries and
 * has a top-level main()) so these can be unit-tested without a DB — mirrors the
 * etl/mesh-anchors derive.ts / index.ts split.
 */

export type DerivedCandidate = {
  descriptorUi: string;
  descriptorName: string | null;
  ratio: number;
  nBoth: number;
  nDesc: number;
};

export type NameMatch = {
  descriptorUi: string;
  descriptorName: string;
  confidence: "exact" | "entry-term";
  matchedForm: string;
};

export type FamilySignals = {
  supercategory: string;
  familyLabel: string;
  derived: DerivedCandidate[]; // pre-sorted desc by ratio
  nameMatch: NameMatch | null;
};

export type SeedRow = {
  supercategory: string;
  familyLabel: string;
  descriptorUi: string;
  confidence: "derived";
  sourceNote: string;
};

/**
 * Combine the two signals into at most `topN` reviewable candidate rows per
 * family. The name-match descriptor (when present) is emitted first and tagged
 * `both:` if it also co-occurs, else `name-match:`; remaining slots are filled
 * by the top co-occurring descriptors tagged `derived:`. Every row is
 * confidence=derived — a human promotes the right one to curated.
 */
export function buildSeedRows(families: FamilySignals[], topN: number): SeedRow[] {
  const out: SeedRow[] = [];
  for (const fam of families) {
    const seen = new Set<string>();
    const rows: SeedRow[] = [];

    const pushRow = (descriptorUi: string, note: string) => {
      if (seen.has(descriptorUi) || rows.length >= topN) return;
      seen.add(descriptorUi);
      rows.push({
        supercategory: fam.supercategory,
        familyLabel: fam.familyLabel,
        descriptorUi,
        confidence: "derived",
        sourceNote: note,
      });
    };

    if (fam.nameMatch) {
      const co = fam.derived.find((d) => d.descriptorUi === fam.nameMatch!.descriptorUi);
      const base = `name-match: label resolves to "${fam.nameMatch.descriptorName}" (${fam.nameMatch.confidence}, via "${fam.nameMatch.matchedForm}")`;
      pushRow(
        fam.nameMatch.descriptorUi,
        co ? `both: ${base}; co-occurrence ratio=${co.ratio.toFixed(2)}` : base,
      );
    }
    for (const d of fam.derived) {
      pushRow(
        d.descriptorUi,
        `derived: co-occurrence ratio=${d.ratio.toFixed(2)} (n_both=${d.nBoth}/n_desc=${d.nDesc}) — "${d.descriptorName ?? d.descriptorUi}"; REVIEW: top co-occurring descriptor may be the disease, not the method`,
      );
    }
    out.push(...rows);
  }
  return out;
}

function csvEscape(value: string): string {
  // RFC 4180 — quote when the field contains a comma, quote, or newline; double
  // embedded quotes. family_label contains spaces and source_note contains
  // commas, so both are routinely quoted.
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: SeedRow[]): string {
  const header = "supercategory,family_label,descriptor_ui,confidence,source_note";
  const lines = rows.map((r) =>
    [r.supercategory, r.familyLabel, r.descriptorUi, r.confidence, r.sourceNote]
      .map(csvEscape)
      .join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
