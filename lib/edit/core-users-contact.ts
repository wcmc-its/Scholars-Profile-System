/**
 * Report 11 "Core users" — "Email these users": the addresses of the CURRENTLY
 * FILTERED people a core owner may copy into an Outlook Bcc (decision of
 * 2026-10-29, which carves this one path out of `SCHOLAR_EXPORT_CAP`).
 *
 * Recipients: the report's own filtered people (`loadCoreUsersReport`, same
 * query string), narrowed to ACTIVE scholars — `deletedAt: null, status:
 * "active"`, the Scholar-row predicate `isPublicLeader` (`lib/eligibility.ts`)
 * and `ACTIVE_WHERE` (`lib/api/data-quality.ts`) use. A departed person is a
 * soft-deleted row (the ED ETL stamps `deletedAt`; `scholarStateOf` reads it
 * the same way) and a suppressed one is `status = 'suppressed'`. The address
 * itself goes through `exportEmailCell` (`lib/profile/email-visibility-flags.ts`),
 * the /edit unit-export email rule: the `SCHOLAR_LIST_EXPORT_EMAIL` kill switch
 * and the #536 hidden-role carve. Deduped case-insensitively.
 *
 * Cap: `CORE_CONTACT_CAP` recipients. Above it the copy is REFUSED whole —
 * never truncated.
 *
 * Gate: report 11's per-core gate (`authorizeCoreClaim`) evaluated on the
 * person's OWN roles — the observer's and content editor's synthetic steward
 * view stripped, and a content editor not admitted — so read-only viewers
 * never get it. One core only: never the all-cores roll-up.
 *
 * Server-only (`@/lib/db`); the predicates above the loader are pure.
 */
import { CORE_CONTACT_CAP } from "@/lib/api/export-scholars";
import { stripContentEditorView, stripObserverView } from "@/lib/auth/observer-view";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { authorizeCoreClaim, type EffectiveUnitRole } from "@/lib/edit/authz";
import { chunk, isAllCores } from "@/lib/edit/core-report-common";
import { exportEmailCell } from "@/lib/profile/email-visibility-flags";

export type ContactCandidate = {
  email: string | null;
  roleCategory: string | null;
  deletedAt: Date | null;
  status: string | null;
};

/** The deduped, sorted addresses of the active candidates. Pure. */
export function selectCoreContactRecipients(rows: readonly ContactCandidate[]): string[] {
  const byKey = new Map<string, string>();
  for (const r of rows) {
    if (r.deletedAt !== null || r.status !== "active") continue;
    const email = exportEmailCell({ email: r.email?.trim() || null, roleCategory: r.roleCategory });
    if (email && !byKey.has(email.toLowerCase())) byKey.set(email.toLowerCase(), email);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export function coreContactAllowed(recipients: number, cap: number = CORE_CONTACT_CAP): boolean {
  return recipients <= cap;
}

export function coreContactOverCapMessage(
  recipients: number,
  cap: number = CORE_CONTACT_CAP,
): string {
  return `${recipients.toLocaleString()} people here have a current address. Addresses can only be copied for ${cap} or fewer, so there is no email option for this selection. Narrow the filters to email them.`;
}

/**
 * May this session copy a core's user addresses? Pure given the looked-up core
 * role. Works on a READ session (the page) or a WRITE session (the route): the
 * synthetic steward views are stripped here either way.
 */
export function canContactCoreUsers(
  session: EditSession,
  coreId: string,
  coreRole: EffectiveUnitRole,
): boolean {
  if (isAllCores(coreId)) return false;
  const own = stripContentEditorView(stripObserverView(session));
  return authorizeCoreClaim({ ...own, isObserver: false, isContentEditor: false }, coreRole).ok;
}

/** The recipients among `cwids` (the report's filtered people). */
export async function loadCoreContactRecipients(cwids: readonly string[]): Promise<string[]> {
  const rows: ContactCandidate[] = [];
  for (const batch of chunk([...new Set(cwids)])) {
    rows.push(
      ...(await db.read.scholar.findMany({
        where: { cwid: { in: batch }, deletedAt: null, status: "active" },
        select: { email: true, roleCategory: true, deletedAt: true, status: true },
      })),
    );
  }
  return selectCoreContactRecipients(rows);
}
