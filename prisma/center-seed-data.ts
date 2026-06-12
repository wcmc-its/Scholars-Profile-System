/**
 * Canonical WCM center + Meyer-program seed data (#540 Phase 9).
 *
 * Historically this lived inline in `prisma/seed-centers.ts`. The unit-curation
 * cutover retires that loader — the centers become manually-owned rows
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
 *   - directorCwid: leadership is curated through the UI / the comms backfill
 *     (`scripts/backfills/2026-06-12-org-unit-comms-update.ts`).
 *   - scholarCount: refreshed from CenterMembership as roster edits land.
 *
 * `compactName` is the short / common facet label (resolved by
 * lib/org-unit-names.ts:compactUnitName); `name` is the full / official name.
 *
 * Revised 2026-06-12 per Head of Communications: renamed Health Equity +
 * Inflammation Research, removed Computational Biomedicine + Iris Cantor
 * (clinical unit, not research), added Drukier / Weill Metabolic / Global Health
 * / Appel / Friedman. Slugs are kept stable across renames to preserve URLs.
 */

export type CenterSeed = {
  code: string;
  name: string;
  slug: string;
  /** Short / common facet label. Resolver falls back to `name` when omitted. */
  compactName: string;
  description: string;
  sortOrder: number;
  centerType: "center" | "institute";
};

export const CENTERS: CenterSeed[] = [
  {
    code: "englander_ipm",
    name: "Englander Institute for Precision Medicine",
    slug: "englander-precision-medicine",
    compactName: "Institute for Precision Medicine",
    description:
      "Genomic medicine, precision diagnostics, and translational therapeutics across cancer, rare disease, and immunology.",
    sortOrder: 10,
    centerType: "institute",
  },
  {
    code: "meyer_cancer_center",
    name: "Sandra and Edward Meyer Cancer Center",
    slug: "meyer-cancer-center",
    compactName: "Meyer Cancer Center",
    description:
      "NCI-designated cancer center spanning basic, translational, and clinical oncology research at WCM and NewYork-Presbyterian.",
    sortOrder: 20,
    centerType: "center",
  },
  {
    code: "cardiovascular_ri",
    name: "Cardiovascular Research Institute",
    slug: "cardiovascular-research-institute",
    compactName: "Cardiovascular Research",
    description:
      "Multidisciplinary cardiovascular science from molecular pathways to clinical trials, including the cardio-oncology consortium.",
    sortOrder: 40,
    centerType: "institute",
  },
  {
    code: "aging_research",
    name: "Center for Aging Research",
    slug: "aging-research",
    compactName: "Aging Research",
    description:
      "Geroscience, late-life cognitive and physical decline, and the clinical care of older adults across WCM and partner sites.",
    sortOrder: 60,
    centerType: "center",
  },
  {
    // Renamed from "Center for Health Equity Research" (comms 2026-06-12).
    // Cross-campus unit; membership coverage is expected to stay sparse.
    // Slug kept stable to preserve existing URLs.
    code: "health_equity",
    name: "Cornell Center for Health Equity",
    slug: "health-equity-research",
    compactName: "Center for Health Equity",
    description:
      "Population health, social determinants of health, and disparities research across NYC and national cohorts.",
    sortOrder: 90,
    centerType: "center",
  },
  {
    // Renamed from "Center for Inflammation Research" (comms 2026-06-12); now
    // institute-typed and IBD-focused. Slug kept stable to preserve URLs.
    code: "inflammation_research",
    name: "Jill Roberts Institute for Research in Inflammatory Bowel Disease",
    slug: "inflammation-research",
    compactName: "Jill Roberts Institute",
    description:
      "Basic and translational research into the causes, mechanisms, and treatment of inflammatory bowel disease and related immune-mediated disorders.",
    sortOrder: 80,
    centerType: "institute",
  },
  {
    code: "drukier_childrens_health",
    name: "Drukier Institute for Children's Health",
    slug: "drukier-childrens-health",
    compactName: "Drukier Institute",
    description:
      "Pediatric research spanning immunology, genomics, and the biological origins of childhood disease.",
    sortOrder: 100,
    centerType: "institute",
  },
  {
    code: "weill_metabolic_health",
    name: "Weill Center for Metabolic Health",
    slug: "weill-metabolic-health",
    compactName: "Metabolic Health",
    description:
      "Research on diabetes, obesity, and metabolic disease, from molecular mechanisms to clinical care.",
    sortOrder: 110,
    centerType: "center",
  },
  {
    code: "global_health",
    name: "Center for Global Health",
    slug: "global-health",
    compactName: "Global Health",
    description:
      "Global health research and training addressing infectious disease and health-system challenges in resource-limited settings.",
    sortOrder: 120,
    centerType: "center",
  },
  {
    code: "appel_alzheimers",
    name: "Appel Alzheimer's Disease Research Institute",
    slug: "appel-alzheimers",
    compactName: "Appel Alzheimers Institute",
    description:
      "Research on the mechanisms, early detection, and treatment of Alzheimer's disease and related neurodegenerative disorders.",
    sortOrder: 130,
    centerType: "institute",
  },
  {
    code: "friedman_nutrition",
    name: "Friedman Center for Nutrition",
    slug: "friedman-nutrition",
    compactName: "Nutrition",
    description:
      "Nutrition science and its role in metabolic health, disease prevention, and clinical practice.",
    sortOrder: 140,
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
