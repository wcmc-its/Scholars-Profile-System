/**
 * Validation for a self-asserted `profile_appointment` (#1568) — the pure,
 * side-effect-free shape check shared by the create + update legs of
 * `POST /api/edit/appointment`. Kept out of the route so it is unit-testable
 * without a request / DB harness.
 *
 * Only `category` is controlled (WCM_LEADERSHIP | EXTERNAL) — it drives which
 * profile heading the row renders under. `title` / `organization` are REQUIRED
 * free text (trimmed, ≤255). `unit` / `location` are OPTIONAL free text
 * (trimmed, ≤255; blank → null). Dates are optional `YYYY-MM-DD`; when BOTH are
 * present, `start ≤ end`. `sortOrder` (0..9999 int) and `showOnProfile` (bool)
 * are optional and fall back to the column defaults (0 / true).
 */
import { isValidDateRange, validateRosterDate } from "@/lib/edit/validators";

export const PROFILE_APPOINTMENT_CATEGORIES = ["WCM_LEADERSHIP", "EXTERNAL"] as const;
export type ProfileAppointmentCategoryValue = (typeof PROFILE_APPOINTMENT_CATEGORIES)[number];

export function isProfileAppointmentCategory(
  value: unknown,
): value is ProfileAppointmentCategoryValue {
  return (
    typeof value === "string" &&
    (PROFILE_APPOINTMENT_CATEGORIES as readonly string[]).includes(value)
  );
}

/** VarChar(255) cap on the free-text fields (title / organization / unit / location). */
export const PROFILE_APPOINTMENT_TEXT_MAX = 255;
/** Upper bound on the manual `sortOrder` (mirrors the center-program editor). */
export const PROFILE_APPOINTMENT_SORT_ORDER_MAX = 9_999;

/** The normalized, storable shape a valid create/update body resolves to. */
export interface ProfileAppointmentInput {
  category: ProfileAppointmentCategoryValue;
  title: string;
  organization: string;
  unit: string | null;
  location: string | null;
  startDate: Date | null;
  endDate: Date | null;
  sortOrder: number;
  showOnProfile: boolean;
}

export type ProfileAppointmentInputResult =
  | { ok: true; value: ProfileAppointmentInput }
  | { ok: false; error: string; field: string };

/** A required free-text field: a string that is non-empty after trim and ≤255. */
function validateRequiredText(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string; field: string } {
  if (typeof value !== "string") return { ok: false, error: "invalid_value", field };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: "required", field };
  if (trimmed.length > PROFILE_APPOINTMENT_TEXT_MAX) {
    return { ok: false, error: "too_long", field };
  }
  return { ok: true, value: trimmed };
}

/** An optional free-text field: absent / null / blank → null; else trimmed ≤255. */
function validateOptionalText(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string; field: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "invalid_value", field };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > PROFILE_APPOINTMENT_TEXT_MAX) {
    return { ok: false, error: "too_long", field };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate + normalize a create/update payload for a `profile_appointment`. On
 * success the value is directly storable (dates parsed to UTC-midnight `Date`s,
 * free text trimmed, optionals nulled). The first failing field short-circuits.
 */
export function validateProfileAppointmentInput(
  body: Record<string, unknown>,
): ProfileAppointmentInputResult {
  if (!isProfileAppointmentCategory(body.category)) {
    return { ok: false, error: "invalid_category", field: "category" };
  }
  const category = body.category;

  const title = validateRequiredText(body.title, "title");
  if (!title.ok) return title;
  const organization = validateRequiredText(body.organization, "organization");
  if (!organization.ok) return organization;

  const unit = validateOptionalText(body.unit, "unit");
  if (!unit.ok) return unit;
  const location = validateOptionalText(body.location, "location");
  if (!location.ok) return location;

  // Dates: absent → null; else `YYYY-MM-DD` → UTC-midnight Date (shared parser).
  const startDate = validateRosterDate(body.startDate === undefined ? null : body.startDate);
  if (!startDate.ok) return { ok: false, error: "invalid_date", field: "startDate" };
  const endDate = validateRosterDate(body.endDate === undefined ? null : body.endDate);
  if (!endDate.ok) return { ok: false, error: "invalid_date", field: "endDate" };
  // When BOTH dates are present, the range must be ordered (start ≤ end).
  if (!isValidDateRange(startDate.value, endDate.value)) {
    return { ok: false, error: "invalid_date_range", field: "endDate" };
  }

  let sortOrder = 0;
  if (body.sortOrder !== undefined) {
    if (
      typeof body.sortOrder !== "number" ||
      !Number.isInteger(body.sortOrder) ||
      body.sortOrder < 0 ||
      body.sortOrder > PROFILE_APPOINTMENT_SORT_ORDER_MAX
    ) {
      return { ok: false, error: "invalid_value", field: "sortOrder" };
    }
    sortOrder = body.sortOrder;
  }

  let showOnProfile = true;
  if (body.showOnProfile !== undefined) {
    if (typeof body.showOnProfile !== "boolean") {
      return { ok: false, error: "invalid_value", field: "showOnProfile" };
    }
    showOnProfile = body.showOnProfile;
  }

  return {
    ok: true,
    value: {
      category,
      title: title.value,
      organization: organization.value,
      unit: unit.value,
      location: location.value,
      startDate: startDate.value,
      endDate: endDate.value,
      sortOrder,
      showOnProfile,
    },
  };
}
