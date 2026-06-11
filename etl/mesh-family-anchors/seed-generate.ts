/**
 * MeSH family-anchor SEED GENERATOR — issue #879 (read-only; proposes, never
 * writes the table).
 *
 * Run via `npm run etl:mesh-family-anchors:seed`. Emits a REVIEWABLE CSV of
 * candidate (supercategory, family_label, descriptor_ui) anchors with
 * `confidence=derived`, for a human to inspect, correct, promote to
 * `curated`, and paste into etl/mesh-family-anchors/curated.csv. It NEVER
 * touches `mesh_curated_family_anchor` — only `index.ts` writes the table, and
 * only from the human-reviewed curated.csv. The read path
 * (getFamilyMeshDefinition) surfaces ONLY confidence=curated rows, so a derived
 * seed is inert until promoted.
 *
 * Two signals per family, combined:
 *   (c) Derived co-occurrence — the descriptors that most often tag the family's
 *       member publications (scholar_family.pmids → publication.mesh_terms),
 *       ranked by n(descriptor AND family) / n(descriptor). NOTE the known (c)
 *       failure mode: the top co-occurring descriptor is frequently the DISEASE
 *       studied, not the METHOD — every derived row needs human review.
 *   Name-match — resolveMeshDescriptor(family_label): when the family label
 *       resolves to a descriptor by exact name / entry term / #642 alias, that is
 *       a strong promotion candidate.
 *
 * Env:
 *   MESH_FAMILY_ANCHOR_THRESHOLD    (default 0.30 — co-occurrence ratio floor)
 *   MESH_FAMILY_ANCHOR_MIN_SUPPORT  (default 5    — min n_desc per descriptor)
 *   MESH_FAMILY_ANCHOR_TOP_N        (default 3    — candidates emitted per family)
 *   MESH_FAMILY_ANCHOR_SEED_OUT     (default /tmp/mesh-family-anchor-seed.csv)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { resolveMeshDescriptor } from "@/lib/api/search-taxonomy";
import { buildSeedRows, toCsv, type FamilySignals } from "./seed-rank";

const THRESHOLD = parseFloat(process.env.MESH_FAMILY_ANCHOR_THRESHOLD ?? "0.30");
const MIN_SUPPORT = parseInt(process.env.MESH_FAMILY_ANCHOR_MIN_SUPPORT ?? "5", 10);
const TOP_N = parseInt(process.env.MESH_FAMILY_ANCHOR_TOP_N ?? "3", 10);
const OUT_PATH = process.env.MESH_FAMILY_ANCHOR_SEED_OUT ?? "/tmp/mesh-family-anchor-seed.csv";

// ---------------------------------------------------------------------------
// DB-backed signal collection (integration-shaped; needs a populated
// scholar_family + publication.mesh_terms).
// ---------------------------------------------------------------------------

type DerivedRaw = {
  supercategory: string;
  family_label: string;
  descriptor_ui: string;
  descriptor_name: string | null;
  ratio: unknown;
  n_both: unknown;
  n_desc: unknown;
};

/**
 * Co-occurrence over scholar_family.pmids × publication.mesh_terms, grouped by
 * (supercategory, family_label, descriptor_ui). Mirrors etl/mesh-anchors'
 * loadDerivedRaw, but the family side comes from the JSON pmid membership.
 *
 * The DISTINCT in pub_families is load-bearing: the same pmid appears in a
 * family via every scholar who is in it, so without DISTINCT n_both is
 * overcounted. Families with pmids IS NULL are silently excluded (JSON_TABLE on
 * NULL yields zero rows) — correct: an unbackfilled family contributes no
 * signal. Both pmid sides are CAST to CHAR so the JSON-string pmids join the
 * publication PK regardless of its native type.
 */
async function loadDerived(): Promise<DerivedRaw[]> {
  const raw = await db.write.$queryRaw<DerivedRaw[]>`
    WITH pub_descriptors AS (
      SELECT CAST(p.pmid AS CHAR) AS pmid, jt.ui AS descriptor_ui
      FROM publication p
      CROSS JOIN JSON_TABLE(p.mesh_terms, '$[*]' COLUMNS (ui VARCHAR(10) PATH '$.ui')) jt
      WHERE jt.ui IS NOT NULL
    ),
    descriptor_totals AS (
      SELECT descriptor_ui, COUNT(DISTINCT pmid) AS n_desc
      FROM pub_descriptors GROUP BY descriptor_ui
    ),
    family_pmids AS (
      SELECT sf.supercategory, sf.family_label, CAST(jt.pmid AS CHAR) AS pmid
      FROM scholar_family sf
      CROSS JOIN JSON_TABLE(sf.pmids, '$[*]' COLUMNS (pmid VARCHAR(32) PATH '$')) jt
      WHERE sf.pmids IS NOT NULL
    ),
    pub_families AS (
      SELECT DISTINCT supercategory, family_label, pmid FROM family_pmids
    ),
    co AS (
      SELECT pd.descriptor_ui, pf.supercategory, pf.family_label,
             COUNT(DISTINCT pd.pmid) AS n_both
      FROM pub_descriptors pd
      INNER JOIN pub_families pf USING (pmid)
      GROUP BY pd.descriptor_ui, pf.supercategory, pf.family_label
    )
    SELECT co.supercategory, co.family_label, co.descriptor_ui,
           md.name AS descriptor_name,
           co.n_both / dt.n_desc AS ratio, co.n_both, dt.n_desc
    FROM co
    INNER JOIN descriptor_totals dt USING (descriptor_ui)
    LEFT JOIN mesh_descriptor md ON md.descriptor_ui = co.descriptor_ui
    WHERE dt.n_desc >= ${MIN_SUPPORT} AND co.n_both / dt.n_desc >= ${THRESHOLD}
    ORDER BY co.supercategory, co.family_label, ratio DESC
  `;
  return raw;
}

function familyKey(supercategory: string, familyLabel: string): string {
  // Tab delimiter — family_label contains spaces, never tabs.
  return `${supercategory}\t${familyLabel}`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const derivedRaw = await loadDerived();

  // Group derived candidates per family.
  const byFamily = new Map<string, FamilySignals>();
  for (const r of derivedRaw) {
    const key = familyKey(r.supercategory, r.family_label);
    let fam = byFamily.get(key);
    if (!fam) {
      fam = { supercategory: r.supercategory, familyLabel: r.family_label, derived: [], nameMatch: null };
      byFamily.set(key, fam);
    }
    fam.derived.push({
      descriptorUi: r.descriptor_ui,
      descriptorName: r.descriptor_name,
      ratio: Number(r.ratio),
      nBoth: Number(r.n_both),
      nDesc: Number(r.n_desc),
    });
  }

  // Name-match signal: also surface families that the co-occurrence gate missed
  // entirely. Pull the full distinct family set so a label-only match still gets
  // a row even with zero qualifying co-occurrence.
  const allFamilies = await db.write.scholarFamily.groupBy({
    by: ["supercategory", "familyLabel"],
  });
  for (const f of allFamilies) {
    const key = familyKey(f.supercategory, f.familyLabel);
    if (!byFamily.has(key)) {
      byFamily.set(key, {
        supercategory: f.supercategory,
        familyLabel: f.familyLabel,
        derived: [],
        nameMatch: null,
      });
    }
  }
  for (const fam of byFamily.values()) {
    const res = await resolveMeshDescriptor(fam.familyLabel).catch(() => null);
    if (res) {
      fam.nameMatch = {
        descriptorUi: res.descriptorUi,
        descriptorName: res.name,
        confidence: res.confidence,
        matchedForm: res.matchedForm,
      };
    }
  }

  const families = [...byFamily.values()].sort((a, b) =>
    a.supercategory === b.supercategory
      ? a.familyLabel.localeCompare(b.familyLabel)
      : a.supercategory.localeCompare(b.supercategory),
  );
  const rows = buildSeedRows(families, TOP_N);

  const abs = resolve(process.cwd(), OUT_PATH);
  writeFileSync(abs, toCsv(rows), "utf-8");

  // Candidate-count distribution, so reviewers can tune the threshold before the
  // first curation pass (#879 OQ-7 — families are broad, defaults may over-produce).
  const perFamilyCounts = families.map(
    (f) => rows.filter((r) => r.familyLabel === f.familyLabel && r.supercategory === f.supercategory).length,
  );
  const withNameMatch = families.filter((f) => f.nameMatch).length;
  console.log(
    `[MeshFamilyAnchorSeed] ${JSON.stringify({
      event: "seed_generated",
      out: abs,
      families: families.length,
      familiesWithNameMatch: withNameMatch,
      rows: rows.length,
      avgCandidatesPerFamily:
        perFamilyCounts.length > 0
          ? Number((perFamilyCounts.reduce((a, b) => a + b, 0) / perFamilyCounts.length).toFixed(2))
          : 0,
      threshold: THRESHOLD,
      minSupport: MIN_SUPPORT,
      topN: TOP_N,
      durationMs: Date.now() - startedAt,
    })}`,
  );
  console.log(
    `[MeshFamilyAnchorSeed] Review ${abs}, correct + promote rows to confidence=curated, then paste into etl/mesh-family-anchors/curated.csv.`,
  );
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MeshFamilyAnchorSeed] ${JSON.stringify({ event: "fatal", error: message })}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
