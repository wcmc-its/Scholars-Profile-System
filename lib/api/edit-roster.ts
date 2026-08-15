/**
 * The org-unit filter shape shared by the Profiles roster
 * (`lib/api/data-quality.ts`, `/edit/scholars`) — one department, division, or
 * center.
 *
 * The roster query this type originally belonged to (`loadEditRoster`) was
 * retired when the Profiles page merged with the former Data Quality dashboard
 * and switched to `loadDataQualityRoster` for its data; this type is the one
 * piece still shared (`lib/api/data-quality.ts` re-exports it), so the file
 * stays rather than folding it directly into that module.
 */
export type EditRosterUnitFilter =
  | { kind: "department"; code: string }
  | { kind: "division"; code: string }
  | { kind: "center"; code: string };
