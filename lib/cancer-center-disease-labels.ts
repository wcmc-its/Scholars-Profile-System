/**
 * Cancer Center disease-code display labels — shared by the /edit roster
 * (`components/edit/center-roster-diseases.ts`) and the public center page
 * (`lib/api/centers.ts` attaches `label` to each published disease). Pure and
 * client-safe: no `@/lib/db`, nothing that builds prisma.
 *
 * `person_code` -> `display_label`, from `docs/cancer-center-person-rollup.csv`
 * (the same map `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`
 * builds at ETL time). Hardcoded rather than read at request time: the rollup
 * has no DB-backed lookup, and the app's runtime image never ships `docs/`
 * (`Dockerfile`'s runtime stage copies only `.next/standalone` +
 * `.next/static` + `prisma/`), so a `readFileSync` would ENOENT in every
 * deployed environment. On /edit, the `diseaseOptions` prop (the server's
 * `loadDiseaseCodeOptions`) carries the authoritative label for the
 * "+ Add a disease" picker; this map is the display label everywhere else.
 */
const DISEASE_LABELS: Record<string, string> = {
  BREAST: "Breast Cancer",
  LUNG: "Lung & Thoracic Cancer",
  GI_COLORECTAL: "Colorectal & Anal Cancer",
  GI_PANCREAS: "Pancreatic Cancer",
  GI_LIVER: "Liver & Bile Duct Cancer",
  GI_UPPER: "Esophageal & Stomach Cancer",
  GU_PROSTATE: "Prostate Cancer",
  GU_OTHER: "Kidney, Bladder & Testicular Cancer",
  GYN: "Gynecologic Cancer",
  HEME_LEUK: "Leukemia",
  HEME_LYMPH: "Lymphoma",
  HEME_MYELOMA: "Multiple Myeloma",
  HEME_MDS_MPN: "Blood Cancers (MDS, MPN & Other)",
  NEURO: "Brain & Nervous System Cancer",
  HEAD_NECK: "Head & Neck Cancer",
  SKIN: "Melanoma & Skin Cancer",
  SARCOMA: "Sarcoma & Bone Cancer",
  ENDO: "Thyroid & Endocrine Cancer",
  HEREDITARY: "Hereditary Cancer & Genetics",
};

export function diseaseLabel(code: string): string {
  const known = DISEASE_LABELS[code];
  if (known) return known;
  const spaced = code.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
