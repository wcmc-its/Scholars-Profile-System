/**
 * Canonical WCM center + Meyer-program seed data (#540 Phase 9).
 *
 * Historically this lived inline in `prisma/seed-centers.ts`. The unit-curation
 * cutover retires that loader — the 8 centers become manually-owned rows
 * (`source='manual'`) curated through `/edit/center/*`. The data itself is still
 * needed in two places, so it lives here as the single source of truth:
 *
 *   1. `scripts/backfills/2026-06-10-import-unit-curation.ts` — the launch
 *      backfill, which also doubles as the dev/CI fixture loader (a fresh clone
 *      or CI run has no centers once `seed-centers.ts` is retired).
 *   2. `prisma/seed-centers.ts` — retained, scoped, and re-pointed at this
 *      module for historical reference.
 *
 * `directorCwid` and `scholarCount` are intentionally omitted here (null/0):
 *   - directorCwid: set through the curation UI once a real scholar match exists.
 *   - scholarCount: refreshed from CenterMembership as roster edits land.
 */

export type CenterSeed = {
  code: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  centerType: "center" | "institute";
};

export const CENTERS: CenterSeed[] = [
  {
    code: "englander_ipm",
    name: "Englander Institute for Precision Medicine",
    slug: "englander-precision-medicine",
    description:
      "Genomic medicine, precision diagnostics, and translational therapeutics across cancer, rare disease, and immunology.",
    sortOrder: 10,
    centerType: "institute",
  },
  {
    code: "meyer_cancer_center",
    name: "Sandra and Edward Meyer Cancer Center",
    slug: "meyer-cancer-center",
    description:
      "NCI-designated cancer center spanning basic, translational, and clinical oncology research at WCM and NewYork-Presbyterian.",
    sortOrder: 20,
    centerType: "center",
  },
  {
    code: "cardiovascular_ri",
    name: "Cardiovascular Research Institute",
    slug: "cardiovascular-research-institute",
    description:
      "Multidisciplinary cardiovascular science from molecular pathways to clinical trials, including the cardio-oncology consortium.",
    sortOrder: 40,
    centerType: "institute",
  },
  {
    code: "computational_biomed",
    name: "Institute for Computational Biomedicine",
    slug: "computational-biomedicine",
    description:
      "Computational genomics, biomedical informatics, machine learning in medicine, and clinical decision support research.",
    sortOrder: 50,
    centerType: "institute",
  },
  {
    code: "aging_research",
    name: "Center for Aging Research",
    slug: "aging-research",
    description:
      "Geroscience, late-life cognitive and physical decline, and the clinical care of older adults across WCM and partner sites.",
    sortOrder: 60,
    centerType: "center",
  },
  {
    code: "iris_cantor_womens_health",
    name: "Iris Cantor Women's Health Center",
    slug: "iris-cantor-womens-health",
    description:
      "Sex-specific medicine, reproductive endocrinology, and clinical research focused on women's cardiovascular and metabolic health.",
    sortOrder: 70,
    centerType: "center",
  },
  {
    code: "inflammation_research",
    name: "Center for Inflammation Research",
    slug: "inflammation-research",
    description:
      "Innate and adaptive immunity in chronic disease, autoimmune mechanisms, and immunotherapy development.",
    sortOrder: 80,
    centerType: "center",
  },
  {
    code: "health_equity",
    name: "Center for Health Equity Research",
    slug: "health-equity-research",
    description:
      "Population health, social determinants of health, and disparities research across NYC and national cohorts.",
    sortOrder: 90,
    centerType: "center",
  },
];

/**
 * Per-center program taxonomy (#552). Only the Meyer Cancer Center uses programs
 * in v1; membershipType + programCode are surfaced in the roster editor only for
 * centers that have rows here. Keyed on the Center.code @id (`meyer_cancer_center`),
 * NOT the slug. Idempotent — safe to re-upsert. (#584)
 */
export type CenterProgramSeed = {
  centerCode: string;
  code: string;
  label: string;
  sortOrder: number;
};

export const CENTER_PROGRAMS: CenterProgramSeed[] = [
  { centerCode: "meyer_cancer_center", code: "CB", label: "Cancer Biology", sortOrder: 10 },
  { centerCode: "meyer_cancer_center", code: "CGE", label: "Cancer Genetics & Epigenetics", sortOrder: 20 },
  { centerCode: "meyer_cancer_center", code: "CPC", label: "Cancer Prevention and Control", sortOrder: 30 },
  { centerCode: "meyer_cancer_center", code: "CT", label: "Cancer Therapeutics", sortOrder: 40 },
  { centerCode: "meyer_cancer_center", code: "ZY", label: "Non-aligned Clinical", sortOrder: 50 },
];
