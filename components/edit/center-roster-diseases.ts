/**
 * Disease-assignment helpers shared by the center roster card and its review
 * sheet (`center-roster-card.tsx`, `center-disease-review-sheet.tsx`). Pure,
 * client-safe: no `@/lib/db`, nothing that builds prisma.
 */
import type { RosterDiseaseRow } from "@/lib/api/unit-edit-context";
import { diseaseRowStatus, isDiseasePublished } from "@/lib/cancer-center-disease-publish";

export type DiseaseDecisionKind = "confirmed" | "rejected" | "clear";

/**
 * `person_code` -> `display_label`, from `docs/cancer-center-person-rollup.csv`
 * (the same map `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`
 * builds at ETL time). Hardcoded rather than read at request time: the rollup
 * has no DB-backed lookup, and the app's runtime image never ships `docs/`
 * (`Dockerfile`'s runtime stage copies only `.next/standalone` +
 * `.next/static` + `prisma/`), so a `readFileSync` would ENOENT in every
 * deployed environment. The `diseaseOptions` prop (the server's
 * `loadDiseaseCodeOptions`) carries the authoritative label for the
 * "+ Add a disease" picker; this map is only a display fallback.
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

export const FOCUS_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  peripheral: "Peripheral",
};

/** A row's confidence for tinting/filtering — the current assignment's if one
 *  still exists, else the snapshot the decision was made against. */
export function confidenceOf(row: RosterDiseaseRow): string | null {
  return row.assignment?.confidence ?? row.decision?.confidenceAtDecision ?? null;
}

/** Non-rejected rows, in the server-sent (rank) order. What the Confidence and
 *  Disease filters match against. */
export function liveDiseaseRows(diseases: ReadonlyArray<RosterDiseaseRow> | undefined): RosterDiseaseRow[] {
  return (diseases ?? []).filter((d) => d.decision?.decision !== "rejected");
}

/** Assignment rows waiting for a curator — no decision yet, and not
 *  auto-published (`diseaseRowStatus`, `lib/cancer-center-disease-publish.ts`).
 *  The "N to review" count, the review queue, and "Confirm N high-confidence"
 *  all read this, so with `autoPublish` on, high-confidence rows drop out of
 *  every one of them together. */
export function pendingDiseaseRows(
  diseases: ReadonlyArray<RosterDiseaseRow> | undefined,
  autoPublish: boolean,
): RosterDiseaseRow[] {
  return (diseases ?? []).filter(
    (d) => d.assignment !== null && diseaseRowStatus(d, autoPublish) === "pending",
  );
}

/** Rows an editor has confirmed (manual adds included). */
export function confirmedDiseaseRows(diseases: ReadonlyArray<RosterDiseaseRow> | undefined): RosterDiseaseRow[] {
  return (diseases ?? []).filter((d) => d.decision?.decision === "confirmed");
}

/** Undecided high-confidence rows the center auto-publishes (none when
 *  `autoPublish` is off). */
export function autoPublishedDiseaseRows(
  diseases: ReadonlyArray<RosterDiseaseRow> | undefined,
  autoPublish: boolean,
): RosterDiseaseRow[] {
  return (diseases ?? []).filter((d) => diseaseRowStatus(d, autoPublish) === "auto");
}

/** Published rows — confirmed plus auto-published (`isDiseasePublished`). */
export function publishedDiseaseRows(
  diseases: ReadonlyArray<RosterDiseaseRow> | undefined,
  autoPublish: boolean,
): RosterDiseaseRow[] {
  return (diseases ?? []).filter((d) => isDiseasePublished(d, autoPublish));
}

/** The one-line evidence summary under a disease in the review sheet:
 *  "12 pubs (3 lead) · 1 trial led · 2 grants · 4 recent". Zero parts drop. */
export function evidenceSummary(a: NonNullable<RosterDiseaseRow["assignment"]>): string {
  const pubs = a.leadPubs + a.secondPubs + a.middlePubs;
  const grants = a.grantsLed + a.grantsSupport;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    `${plural(pubs, "pub", "pubs")}${a.leadPubs ? ` (${a.leadPubs} lead)` : ""}`,
    a.trialsLed ? `${plural(a.trialsLed, "trial", "trials")} led` : null,
    grants ? plural(grants, "grant", "grants") : null,
    a.recentPubs ? `${a.recentPubs} recent` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
