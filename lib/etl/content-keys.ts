/**
 * Issue #352 — change-detection keys for the ETL reconcile (see
 * `lib/etl/reconcile.ts`). A content key serializes the fields an ETL owns into
 * a string; the reconcile updates a row only when its key changes.
 *
 * Only the appointment key is shared here — `appointment` rows are written by
 * three sources (ED faculty, ED-NYP affiliate, Jenzabar GS-faculty) across two
 * ETL files. The grant and education keys stay inline in their single ETL.
 */

/**
 * Appointment reconcile key. Covers every field the appointment ETLs write;
 * dates are reduced to YYYY-MM-DD (the columns are `@db.Date`). It reads only
 * appointment columns the ETLs themselves own.
 */
export function appointmentContentKey(a: {
  cwid: string;
  title: string;
  organization: string;
  startDate: Date | null;
  endDate: Date | null;
  isPrimary: boolean;
  isInterim: boolean;
  source: string;
}): string {
  return JSON.stringify([
    a.cwid,
    a.title,
    a.organization,
    a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
    a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
    a.isPrimary,
    a.isInterim,
    a.source,
  ]);
}
