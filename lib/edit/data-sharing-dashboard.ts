/**
 * S-Index Phase 1 admin/CTSA dashboard (`/edit/data-sharing`) — feature flag +
 * tab visibility. Global-only, no unit scoping: unlike Data Quality, there is
 * no natural "unit Owner sees their unit's rollup" cut here (department rollups
 * span the whole DatasetDeposit/PersonDatasetDeposit bridge, not a per-unit
 * roster), so this mirrors the Usage dashboard's audience shape (a fixed
 * role check) rather than Data Quality's scope resolver. Audience: superuser,
 * comms_steward, or data_sharing_viewer (2026-08-15 — the dedicated role added
 * for the standing audience this dashboard was reframed around: research
 * leadership, compliance/grant reporting, and the library/RDM team; see
 * `lib/auth/data-sharing-viewer.ts`).
 */
import type { EditSession } from "@/lib/auth/superuser";

/** Whether the dashboard is enabled (off by default). When off the route
 *  404s and the sub-nav tab is hidden — mirrors `isDataQualityDashboardEnabled`. */
export function isDataSharingDashboardEnabled(): boolean {
  return process.env.EDIT_DATA_SHARING_DASHBOARD === "on";
}

/** Whether to advertise the "Data sharing" tab for this viewer: the feature is
 *  enabled AND the viewer is a superuser, a comms_steward, or a
 *  data_sharing_viewer. */
export function isDataSharingDashboardTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward: boolean;
  isDataSharingViewer?: boolean;
}): boolean {
  return (
    isDataSharingDashboardEnabled() &&
    (session.isSuperuser || session.isCommsSteward || !!session.isDataSharingViewer)
  );
}

/** Same predicate, applied to a resolved `EditSession` — the page's own gate. */
export function canViewDataSharingDashboard(session: EditSession): boolean {
  return isDataSharingDashboardTabVisible(session);
}
