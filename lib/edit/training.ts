/**
 * Postgraduate training — the shared type vocabulary and the input validator for
 * scholar-entered rows (`/api/edit/training`). Pure: imported by the client
 * Education panel, so it must never pull in `@/lib/db`.
 */

/** ASMS `fc_doctoral_training_type` titles we show ("Other" and untyped are
 *  left out). Also the only types a scholar may enter. */
export const TRAINING_TYPES = [
  "Residency",
  "Fellowship",
  "Internship",
  "Internship and Residency",
  "Postdoctoral",
] as const;
export type TrainingType = (typeof TRAINING_TYPES)[number];

export type TrainingInput = {
  type: TrainingType;
  institution: string;
  specialty: string | null;
  yearFrom: number | null;
  yearTo: number | null;
};

export type TrainingValidation =
  | { ok: true; value: TrainingInput }
  | { ok: false; error: string; field: string };

const MAX_TEXT = 255;
const MIN_YEAR = 1940;

function optionalYear(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) return undefined;
  if (n < MIN_YEAR || n > new Date().getFullYear() + 10) return undefined;
  return n;
}

export function validateTrainingInput(body: Record<string, unknown>): TrainingValidation {
  const type = body.type;
  if (typeof type !== "string" || !(TRAINING_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "invalid_type", field: "type" };
  }
  const institution = typeof body.institution === "string" ? body.institution.trim() : "";
  if (!institution || institution.length > MAX_TEXT) {
    return { ok: false, error: "invalid_institution", field: "institution" };
  }
  if (body.specialty != null && typeof body.specialty !== "string") {
    return { ok: false, error: "invalid_specialty", field: "specialty" };
  }
  const specialty = (body.specialty as string | null | undefined)?.trim() || null;
  if (specialty && specialty.length > MAX_TEXT) {
    return { ok: false, error: "invalid_specialty", field: "specialty" };
  }
  const yearFrom = optionalYear(body.yearFrom);
  if (yearFrom === undefined) return { ok: false, error: "invalid_year", field: "yearFrom" };
  const yearTo = optionalYear(body.yearTo);
  if (yearTo === undefined) return { ok: false, error: "invalid_year", field: "yearTo" };
  if (yearFrom !== null && yearTo !== null && yearTo < yearFrom) {
    return { ok: false, error: "year_order", field: "yearTo" };
  }
  return {
    ok: true,
    value: { type: type as TrainingType, institution, specialty, yearFrom, yearTo },
  };
}
