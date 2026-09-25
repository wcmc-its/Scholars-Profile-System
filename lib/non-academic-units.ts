/**
 * Org units LDAP returns as a scholar's level1 unit that are NOT academic
 * departments. The ED ETL gives their members no department (so they never
 * appear under a fake department on /browse) and prunes the empty Department
 * rows; the title ladder never treats a "chair" of one as a department chair.
 *
 * Graduate School and MD-PhD Program are student-only units — the level1 for
 * doctoral and MD-PhD students — not academic departments (Paul, 2026-09-25;
 * #2795 removed them from /browse). Their curated `leaderCwid` overrides
 * outlive the prune, which is why the title code checks this list too.
 *
 * Import-free on purpose: read by the ETL and by server title code alike.
 */
export const NON_ACADEMIC_DEPT_NAMES: ReadonlySet<string> = new Set([
  "Information Technologies and Services",
  "Administration & Finance",
  "Graduate School",
  "Weill Cornell Graduate School",
  "MD-PhD Program",
]);
