/**
 * External unit leaders — a deliberate carve-out from the "leader CWID must
 * resolve to a displayable WCM scholar" rule.
 *
 * Some unit leaders hold a WCM leadership role but are NOT WCM scholars (e.g. a
 * primary faculty appointment at Columbia), so no `scholar` row exists to link
 * to. They are rendered as name + Directory-API photo (keyed by CWID) + role,
 * with NO profile link. Keyed by unit `code` (department or center).
 *
 * When such a leader later becomes a WCM scholar, delete the entry — the normal
 * scholar-backed leader path (with a profile link) takes over automatically.
 *
 * The CWID is still written to `Department.chairCwid` / the `leaderCwid`
 * override by the backfill so the data says "this unit has a chair"; the photo
 * resolves via `identityImageEndpoint(cwid)` against the Directory API even
 * though there is no scholar row.
 */
export type ExternalLeader = {
  cwid: string;
  /** Display name (no scholar row to source `preferredName` from). */
  name: string;
  /** Optional secondary line under the name; null = omit (do not fabricate). */
  primaryTitle: string | null;
};

export const EXTERNAL_LEADERS: Record<string, ExternalLeader> = {
  // Joel Stein — Chair of Rehabilitation Medicine (N1540). Primary appointment
  // at Columbia, so not a WCM scholar and has no profile to link. Photo is
  // available through the Directory API by CWID. (comms 2026-06-12)
  N1540: { cwid: "jos7021", name: "Joel Stein", primaryTitle: null },
};
