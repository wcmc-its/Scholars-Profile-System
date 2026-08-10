/**
 * Email-visibility feature flag — governs whether the Web Directory release code
 * (`weillCornellEduReleaseCode;mail`, imported to `Scholar.emailVisibility`) is
 * respected across BOTH profile email display and the bulk-export row filter.
 * Server-only (read at request time in the profile data layer and the export
 * route), so a client component never needs the value.
 *
 *   off → current behavior (email shown to everyone; export email column gated
 *         only by viewer-context + hidden-role, not by the release code).
 *   on  → tables A and B of docs/email-visibility-spec.md apply, fail-closed.
 *
 * Defaults OFF, so the gate ships dark. Because `email_visibility` is NULL until
 * the ED ETL backfills it (NULL = 'none' = hide), flip the flag only AFTER the
 * backfill (reindex-then-flip discipline). To turn it on in a deployed env, set
 * the env var to "on" in BOTH `.env.local` (local) AND the per-env `environment:`
 * block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>` (CD only re-rolls
 * the image; it does not pick up new env keys) — the flag parity rule. Wiring the
 * flag in only one place is a silent shipping bug.
 */
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { isScholarListExportEmailEnabled } from "@/lib/export/scholar-export-flags";

export function isEmailReleaseGateEnabled(): boolean {
  return process.env.PROFILE_EMAIL_RELEASE_GATE === "on";
}

/**
 * Whether a scholar's email may be emitted in a CSV export under their Web
 * Directory release code (SPEC §B.2). When the release gate is OFF this is
 * always true (legacy behavior — email gated only by viewer-context +
 * hidden-role). When ON the email is exportable only for `public` /
 * `institution`; `none` and NULL (the fail-closed default until the ED ETL
 * backfills `email_visibility`) blank the cell. Any internal viewer who clears
 * the channel gate sees institution + public alike, so the looser display
 * audience is irrelevant here.
 *
 * Lives here — NOT in `lib/api/export-scholars.ts` — because the unit-roster
 * export (`lib/edit/unit-roster-export.ts`) reaches the CLIENT bundle via
 * `components/edit/unit-edit-page.tsx`, and `export-scholars.ts` constructs
 * `prisma` at module scope. This module is env-reads only, so both export
 * surfaces can share ONE definition of the release-code rule without dragging
 * the driver into the browser build. Two copies of a consent predicate is two
 * places for it to drift.
 */
export function isEmailExportableByReleaseCode(emailVisibility: string | null): boolean {
  if (!isEmailReleaseGateEnabled()) return true;
  return emailVisibility === "public" || emailVisibility === "institution";
}

/**
 * The `email` cell for one row of an /edit UNIT export — centers (roster shape,
 * `lib/edit/unit-roster-export.ts`) and departments/divisions (faculty shape,
 * `lib/edit/unit-faculty-export.ts`) alike. Returns "" (never undefined) so the
 * column count is identical on every row of every unit type.
 *
 * THE one place the three gates compose. Both unit-export modules call this
 * rather than keeping their own copy, because the failure mode of a duplicated
 * consent rule is that the copies drift and one surface quietly starts emitting
 * what the other withholds.
 *
 *   1. `SCHOLAR_LIST_EXPORT_EMAIL` — operator kill switch (#866), per-env.
 *   2. #536 — a hidden-display role never emits contact info.
 *   3. SPEC §B.2 — the scholar's Web Directory release code.
 *
 * Gate 1 is a policy lever and yours to pull. Gates 2 and 3 are not: `none`
 * records an individual's own "do not release my address".
 */
export function exportEmailCell(row: {
  email: string | null;
  emailVisibility: string | null;
  roleCategory: string | null;
}): string {
  if (!row.email) return "";
  if (!isScholarListExportEmailEnabled()) return "";
  if (!isPubliclyDisplayed(row.roleCategory)) return "";
  if (!isEmailExportableByReleaseCode(row.emailVisibility)) return "";
  return row.email;
}
