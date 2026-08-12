/**
 * Golden-file equivalence: the TS port (`etl/cancer-taxonomy/generate.ts`)
 * must reproduce the REAL `build_cancer_taxonomy.py` output against the
 * REAL, checked-in `docs/cancer-taxonomy-ruleset.csv` — the whole point of
 * the golden-file requirement in the redesign plan is "I proved
 * equivalence", not "I reimplemented the algorithm". `testdata/golden-
 * expected.csv` was produced by running the actual Python script:
 *
 *   python3 build_cancer_taxonomy.py --mesh testdata/fixture-desc.xml \
 *     --rules docs/cancer-taxonomy-ruleset.csv --out golden-expected.csv
 *
 * `testdata/fixture-desc.xml` is a small, hand-built stand-in for a real
 * NLM desc<year>.xml — see its own doc comment for what each branch of the
 * closure it's designed to exercise. Running the real ruleset (154 rows)
 * against this ~18-descriptor fixture means most rules land in
 * `.unresolved` (asserted below as a fixed count) — expected, not a bug.
 *
 * The DB-shape divergence from the raw Python CSV is intentional and
 * asserted for, not hidden: Python's `topics`/`review` columns use the
 * literal string "unassigned"/"" for an empty set; `generateCancerTaxonomy`
 * stores a genuine empty array (see the Prisma model doc comment on
 * `CancerTaxonomyDescriptor.topics` for why).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, createReadStream } from "node:fs";
import path from "node:path";
import { parseMeshXmlStream } from "@/etl/mesh-descriptors/parser";
import { parseCsv } from "@/lib/csv";
import {
  generateCancerTaxonomy,
  parseRuleset,
  type DescriptorInput,
  type GeneratedRow,
} from "@/etl/cancer-taxonomy/generate";

const FIXTURE_DIR = path.join(process.cwd(), "etl/cancer-taxonomy/testdata");
const RULESET_PATH = path.join(process.cwd(), "docs/cancer-taxonomy-ruleset.csv");

async function loadFixtureDescriptors(): Promise<DescriptorInput[]> {
  const stream = createReadStream(path.join(FIXTURE_DIR, "fixture-desc.xml"));
  const out: DescriptorInput[] = [];
  for await (const d of parseMeshXmlStream(stream)) {
    out.push({ ui: d.descriptorUi, name: d.name, treeNumbers: d.treeNumbers });
  }
  return out;
}

/** "unassigned" / "" (Python's sentinel for empty) -> [] (this port's shape). */
function pipeField(v: string, emptySentinel?: string): string[] {
  if (v === "" || v === emptySentinel) return [];
  return v.split("|");
}

function loadGoldenRows(): Map<string, GeneratedRow> {
  const csv = readFileSync(path.join(FIXTURE_DIR, "golden-expected.csv"), "utf8");
  const rows = parseCsv(csv);
  const byUi = new Map<string, GeneratedRow>();
  for (const r of rows) {
    byUi.set(r.descriptor_ui, {
      descriptorUi: r.descriptor_ui,
      cancerRelevant: true,
      topics: pipeField(r.topics, "unassigned"),
      admittedBy: pipeField(r.admitted_by),
      reviewFlags: pipeField(r.review),
    });
  }
  return byUi;
}

describe("generateCancerTaxonomy — golden-file equivalence with build_cancer_taxonomy.py", () => {
  it("matches the real Python output row-for-row on the fixture MeSH slice", async () => {
    const descriptors = await loadFixtureDescriptors();
    expect(descriptors).toHaveLength(18); // sanity: fixture didn't silently lose a record

    const rules = parseRuleset(readFileSync(RULESET_PATH, "utf8"));
    const result = generateCancerTaxonomy(rules, descriptors);

    const golden = loadGoldenRows();
    expect(result.rows.map((r) => r.descriptorUi).sort()).toEqual([...golden.keys()].sort());
    for (const row of result.rows) {
      expect(row).toEqual(golden.get(row.descriptorUi));
    }
  });

  it("resolves exactly the ruleset rows that name a descriptor in the fixture (149 unresolved)", async () => {
    const descriptors = await loadFixtureDescriptors();
    const rules = parseRuleset(readFileSync(RULESET_PATH, "utf8"));
    const result = generateCancerTaxonomy(rules, descriptors);
    // Content-review gaps #1/#3/#4 (2026-08-11) added 10 rows naming
    // descriptors outside this tiny fixture (138 + 10 = 148), then a
    // precision-review pass (same day) dropped the Hepatitis B row
    // (sized at 90% no-neoplasm-co-tag, not worth the dilution) and added
    // two rel_exclude_term rows for Proto-Oncogene Proteins c-akt and Janus
    // Kinase 2 (46%/58% no-neoplasm-co-tag against a 20-35% baseline for
    // p53/myc/ras — real precision problems in the Neoplasm Proteins
    // subtree sweep). Net: 148 - 1 + 2 = 149. None of these touch the 16
    // rows that DO resolve against the fixture's 18 descriptors.
    expect(result.unresolved).toHaveLength(149);
  });

  it("flags the fixture's own leaf subtree anchors as empty (real rot-detector signal, fixture-scale noise)", async () => {
    // A ~18-descriptor fixture has no room to build out real children for
    // every _subtree rule — these three are genuinely leaf-only HERE. That's
    // the exact reason the ETL step treats an empty subtree as a WARN, not a
    // hard failure: on a real MeSH release some anchors are legitimately
    // childless by design, so an absolute zero-descendant check has expected
    // false positives. Only a fully `unresolved` name (the OTHER list) is
    // unambiguous enough to fail the run on.
    const descriptors = await loadFixtureDescriptors();
    const rules = parseRuleset(readFileSync(RULESET_PATH, "utf8"));
    const result = generateCancerTaxonomy(rules, descriptors);
    expect(result.emptySubtrees.map((e) => e.descriptor).sort()).toEqual([
      "Breast Neoplasms, Male",
      "Leukemia",
      "Mammary Neoplasms, Animal",
    ]);
  });
});

describe("generateCancerTaxonomy — synthetic edge cases", () => {
  it("flags ruleset rot when a subtree rule's anchor has zero descendants", () => {
    const rules = parseRuleset("rule,descriptor,topic,fallback,flag,note\ntopic_subtree,Leaf Concept,some-topic,,,\n");
    const descriptors: DescriptorInput[] = [{ ui: "D1", name: "Leaf Concept", treeNumbers: ["C99.100"] }];
    const result = generateCancerTaxonomy(rules, descriptors);
    expect(result.emptySubtrees).toEqual([{ rule: "topic_subtree", descriptor: "Leaf Concept" }]);
    // Still resolves and still admits itself as a topic match — rot is a
    // signal to investigate, not silent data loss.
    expect(result.rows).toHaveLength(0); // no rel_include_* rule in this ruleset, so nothing is cancer_relevant
  });

  it("throws on an unrecognized rule type, same as the Python script's sys.exit", () => {
    expect(() =>
      parseRuleset("rule,descriptor,topic,fallback,flag,note\nrel_bogus_rule,Foo,,,,\n"),
    ).toThrow(/Unknown rule types/);
  });

  it("records an unresolved rule without throwing when a descriptor name doesn't exist in this MeSH release", () => {
    const rules = parseRuleset("rule,descriptor,topic,fallback,flag,note\nrel_include_term,Nonexistent Heading,,,,\n");
    const result = generateCancerTaxonomy(rules, []);
    expect(result.unresolved).toEqual([{ rule: "rel_include_term", descriptor: "Nonexistent Heading" }]);
    expect(result.rows).toEqual([]);
  });
});

/**
 * #2370 — anchor nesting. Not covered by the golden file: the fixture MeSH
 * slice contains no descriptor that descends from two topic anchors, which is
 * exactly why the over-assignment shipped unnoticed. These cases use synthetic
 * descriptors so they pin the rule rather than the fixture.
 */
describe("topic anchor specificity (#2370)", () => {
  const descriptors: DescriptorInput[] = [
    { ui: "D_NET", name: "Neuroendocrine Tumors", treeNumbers: ["C04.557.465"] },
    { ui: "D_MEL", name: "Melanoma", treeNumbers: ["C04.557.465.625.650.510"] },
    { ui: "D_SKIN", name: "Skin Neoplasms", treeNumbers: ["C04.588.805"] },
    // Genuinely two-site: a descriptor sitting on two UNRELATED branches.
    { ui: "D_BOTH", name: "Ovarian Germ Cell Tumor", treeNumbers: ["C04.557.465.910", "C04.588.322.455"] },
    { ui: "D_GYN", name: "Ovarian Neoplasms", treeNumbers: ["C04.588.322"] },
  ];
  const rules = [
    { rule: "rel_include_subtree", descriptor: "Neuroendocrine Tumors", topic: "", fallback: "", flag: "", note: "" },
    { rule: "rel_include_subtree", descriptor: "Skin Neoplasms", topic: "", fallback: "", flag: "", note: "" },
    { rule: "rel_include_subtree", descriptor: "Ovarian Neoplasms", topic: "", fallback: "", flag: "", note: "" },
    { rule: "topic_subtree", descriptor: "Neuroendocrine Tumors", topic: "thyroid-neuroendocrine", fallback: "", flag: "", note: "" },
    { rule: "topic_subtree", descriptor: "Melanoma", topic: "melanoma-skin", fallback: "", flag: "", note: "" },
    { rule: "topic_subtree", descriptor: "Ovarian Neoplasms", topic: "gynecologic", fallback: "", flag: "", note: "" },
  ];
  const topicsOf = (ui: string): string[] => {
    const { rows } = generateCancerTaxonomy(rules, descriptors);
    return rows.find((r: GeneratedRow) => r.descriptorUi === ui)?.topics ?? [];
  };

  it("the deeper anchor wins: melanoma is not also neuroendocrine", () => {
    expect(topicsOf("D_MEL")).toEqual(["melanoma-skin"]);
  });

  it("the broad anchor still applies to descriptors the deep one does not cover", () => {
    expect(topicsOf("D_NET")).toEqual(["thyroid-neuroendocrine"]);
  });

  it("anchors on unrelated branches do NOT suppress each other", () => {
    // Neither C04.557.465 nor C04.588.322 is a prefix of the other, so a
    // descriptor genuinely under both keeps both buckets.
    expect(topicsOf("D_BOTH").sort()).toEqual(["gynecologic", "thyroid-neuroendocrine"]);
  });
});
