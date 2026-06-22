/**
 * Feature gate for the restructured self-edit attribute rail
 * (`SELF_EDIT_RAIL_RESTRUCTURE`). Off ⇒ the rail keeps the current two-group
 * layout ("Yours to edit" / "From WCM systems" / "Services"). On ⇒ the fuller
 * structure: Home floats to the top, "Yours to edit" holds only authored content
 * (Overview, Highlights), sourced records sit under "From WCM records" split into
 * "Identity · read-only" and "Records · hide, show, or flag" sub-headers,
 * generators move to "Tools", and the administrative controls (Visibility,
 * Profile editors, Profile URL) gather under a dedicated "Settings" group.
 *
 * Sync env read, mirroring the other edit-surface gates (`isGrantRecsEnabled`,
 * `isBiosketchGenerateEnabled`): the server page reads it and threads the boolean
 * into `EditPage`. Purely presentational — same rail items, regrouped — so it
 * changes layout only, never which attributes an actor can reach.
 */
export function isRailRestructureEnabled(): boolean {
  return process.env.SELF_EDIT_RAIL_RESTRUCTURE === "on";
}
