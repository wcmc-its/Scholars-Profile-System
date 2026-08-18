/**
 * Shared rules for filtering WOOFA data-entry artifacts out of a scholar's
 * public "Past Appointments" (#1323 follow-up). Used by BOTH the write-time
 * default (etl/ed/index.ts, on INSERT) and the read-time gate
 * (lib/api/profile.ts, on every profile render).
 *
 * Kept OUT of etl/ed/index.ts itself: importing that module outside vitest
 * runs a full ED sync as a side effect (`if (!process.env.VITEST) main()`),
 * which would be catastrophic if pulled into the app's profile-page render
 * path. This module has no side effects, so both sides can import it safely.
 */

/** A historical row this short is almost certainly a WOOFA effective-dating
 *  artifact (an "(Interim)" title swap), not a real appointment worth showing
 *  by default. Measured on prod 2026-08: 276 of 12,177 historical rows are
 *  <= 7 days, with a clean gap to the next bucket (35 at 2-7 days vs 484 at
 *  8-30) — every sampled row at or below this cutoff was an artifact shape.
 *  Also incidentally catches the rare end-before-start data bug (a negative
 *  "duration"). Does NOT apply to "Pre-Start Academic" rows — see below,
 *  those need a different rule regardless of duration. */
export const ARTIFACT_MAX_DAYS = 7;

export function looksLikeArtifactAppointment(startDate: Date | null, endDate: Date | null): boolean {
  if (!startDate || !endDate) return false;
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000;
  return days <= ARTIFACT_MAX_DAYS;
}

/** WOOFA's onboarding-placeholder title, not a real academic title. Exact
 *  match confirmed live on prod: it is the ONLY title matching `Pre-Start%`
 *  (1,808 scholars carry one), and durations range 2 to 1207 days — far too
 *  wide a spread for `looksLikeArtifactAppointment`'s duration cutoff to
 *  catch reliably, so it gets its own rule instead of that one. */
export const PRE_START_ACADEMIC_TITLE = "Pre-Start Academic";

/**
 * A Pre-Start row is informative only when it's the ONLY appointment on file
 * — an incoming hire with nothing else yet. Once any other appointment
 * exists (their real title started, or other history synced), it's a stale
 * placeholder sitting next to a real career: confirmed live on prod, only 20
 * of 1,808 Pre-Start scholars have it as their sole appointment. This can't
 * be a stored default (`Appointment.showOnProfile` is written once on INSERT
 * and never touched again, but "is this still the only appointment" changes
 * over the scholar's career) — so it's evaluated fresh every time, using
 * whatever appointment count the caller already has in hand.
 */
export function shouldSuppressPreStart(title: string, totalAppointmentCount: number): boolean {
  return title === PRE_START_ACADEMIC_TITLE && totalAppointmentCount > 1;
}
