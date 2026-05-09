/**
 * Hand-curated category for each WCM department, used by the Browse hub
 * to render a per-row type badge and to drive the type filter.
 *
 *   "clinical"       — patient-facing clinical depts
 *   "basic"          — basic-science depts (no patient care)
 *   "mixed"          — interdisciplinary; rendered as "Basic & Clinical"
 *   "administrative" — admin units (Library, etc.)
 *
 * Loaded at boot by the ED ETL: when upserting a department, the seed value
 * is applied on CREATE only. Existing rows keep whatever category they have,
 * so manual reclassification (e.g. moving a dept between buckets via
 *   UPDATE department SET category = '...' WHERE code = '...';
 * ) survives the next ETL refresh.
 *
 * Add new entries by code when a dept appears in ED LDAP. Codes match the
 * `department.code` PK (e.g. "N1280" for Medicine).
 */

export type DepartmentCategory =
  | "clinical"
  | "basic"
  | "mixed"
  | "administrative";

export const DEPARTMENT_CATEGORIES: Record<string, DepartmentCategory> = {
  // Clinical departments
  N1140: "clinical", // Anesthesiology
  N1160: "clinical", // Cardiothoracic Surgery
  N1180: "clinical", // Reproductive Medicine
  N1220: "clinical", // Dermatology
  N1240: "clinical", // Emergency Medicine
  N1280: "mixed", // Medicine — clinical service + large research enterprise (issue #69)
  N1300: "clinical", // Neurology
  N1320: "clinical", // Neurological Surgery
  N1340: "clinical", // Obstetrics and Gynecology
  N1360: "clinical", // Ophthalmology
  N1400: "clinical", // Otolaryngology Head and Neck Surgery
  N1420: "mixed", // Pathology and Laboratory Medicine — diagnostic + research (issue #69)
  N1440: "clinical", // Pediatrics
  N1500: "clinical", // Psychiatry
  N1520: "clinical", // Radiology
  N1530: "clinical", // Radiation Oncology
  N1540: "clinical", // Rehabilitation Medicine
  N1560: "clinical", // Surgery
  N1580: "clinical", // Urology
  N8265: "clinical", // Orthopaedic Surgery

  // Basic-science departments
  N1700: "basic", // Biochemistry and Biophysics
  N1710: "basic", // Cell and Developmental Biology
  N1730: "basic", // Microbiology and Immunology
  N1750: "basic", // Pharmacology

  // Mixed / Basic & Clinical
  N1480: "mixed", // Population Health Sciences
  N1720: "basic", // Genetic Medicine — research-first per curator review (issue #69)
  N1740: "mixed", // Systems and Computational Biomedicine — spans basic + clinical
  N1760: "mixed", // Brain and Mind Research — basic neuroscience + translation

  // Administrative
  N1932: "administrative", // Library
};

