/**
 * Public-profile grouping for self-asserted `profile_appointment` rows (#1568).
 *
 * These render ONLY on the owner's own profile (never on a center / department /
 * division / search surface — that trust boundary is enforced structurally by
 * those serializers never reading the table). This module is the pure, DB-free
 * grouping the profile view applies to the payload rows: it drops the rows the
 * scholar has hidden (`showOnProfile === false`) and partitions the survivors
 * into the two profile headings by `category`, preserving the loader's order.
 */

/** The controlled category — mirrors the Prisma `ProfileAppointmentCategory`
 *  enum. Drives which profile heading a row renders under. */
export type ProfileAppointmentCategory = "WCM_LEADERSHIP" | "EXTERNAL";

/** One self-asserted appointment as carried in the profile payload. Dates are
 *  `YYYY-MM-DD` (or null); `showOnProfile` is the scholar's per-row display
 *  choice, applied here rather than at load so it stays unit-testable. */
export interface ProfileAppointmentEntry {
  category: ProfileAppointmentCategory;
  title: string;
  organization: string;
  unit: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  showOnProfile: boolean;
}

/** The two profile headings: WCM leadership/roles, and external appointments. */
export interface GroupedProfileAppointments {
  leadership: ProfileAppointmentEntry[];
  external: ProfileAppointmentEntry[];
}

/**
 * Filter to the visible rows (`showOnProfile`) and split by `category`. Order
 * within each group is the input order (the loader orders by `sortOrder`, then
 * `createdAt`). An empty input — or one with every row hidden — yields two empty
 * groups, so the caller's `length > 0` guards omit both cards.
 */
export function groupProfileAppointments(
  entries: ReadonlyArray<ProfileAppointmentEntry>,
): GroupedProfileAppointments {
  const visible = entries.filter((e) => e.showOnProfile);
  return {
    leadership: visible.filter((e) => e.category === "WCM_LEADERSHIP"),
    external: visible.filter((e) => e.category === "EXTERNAL"),
  };
}
