/**
 * Who may see and change the internal program roster (trainees, some of them
 * minors). Every page, route and export of the roster goes through these two.
 *
 * Superusers and `program_roster_editor` only. Nothing else opens it: not the
 * synthetic steward grant observers and content editors carry, not a unit
 * grant, not a Reporting scope.
 *
 * "View as" opens it read-only, and only when a SUPERUSER started the overlay:
 * `getEffectiveEditSession` drops the role and sets `sensitiveDashboardsBlocked`
 * for anyone else.
 */
import { isProgramRosterEnabled } from "@/lib/auth/program-roster-editor";
import type { EditSession } from "@/lib/auth/superuser";

type Viewer = Pick<EditSession, "isSuperuser" | "isProgramRosterEditor" | "sensitiveDashboardsBlocked">;

export function canViewProgramRoster(s: Viewer): boolean {
  return (
    isProgramRosterEnabled() &&
    s.sensitiveDashboardsBlocked !== true &&
    (s.isSuperuser || s.isProgramRosterEditor === true)
  );
}

/** The write gate. `impersonatedCwid` is `EditRequestContext`'s: any live
 *  "View as" overlay, whoever started it, is refused. */
export function canEditProgramRoster(s: Viewer, impersonatedCwid: string | null): boolean {
  return impersonatedCwid === null && canViewProgramRoster(s);
}
