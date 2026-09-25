/**
 * Undo bookkeeping for the news / media highlights review queues.
 *
 * Every row a POST /api/edit/news-mention/decision writes (the decided row, its
 * clip copies, the contested siblings it sweeps, and the row a "wrong person"
 * reassign creates or approves) is stamped with the decision's request id and
 * the row's state from just before. POST /api/edit/news-mention/undo restores
 * those rows from the stamp, all or nothing.
 *
 * Why stamp the row instead of reading the audit log: `scholars_audit` is
 * INSERT-only for the app role by design (scripts/sql/audit-log.sql), so the
 * app cannot read its own before-values back. The stamp is the smallest thing
 * that makes undo server-authoritative: the client only ever sends a decision
 * id, never the state to restore.
 *
 * Why any later /edit write clears the stamp: undo must never overwrite a newer
 * human decision. POST /api/edit/news-mention (hide / show / "not me") spreads
 * {@link CLEARED_DECISION_STAMP}, and undo refuses a decision whose rows no
 * longer all carry its id.
 *
 * Server-only: it imports the revalidation helpers. Never import it from a
 * client component.
 */
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import type { NewsMentionStatus } from "@/lib/generated/prisma/enums";

/** How long after a decision its Undo still works. The queues offer Undo in a
 *  status bar right after the click; this window covers a reviewer who looks
 *  away for a while without letting a stale bar rewrite yesterday's work. */
export const NEWS_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** Most decision ids one undo call accepts ("Approve all" / a bulk bar). */
export const NEWS_UNDO_MAX_DECISIONS = 100;

/** The columns a decision stamps; see prisma/schema.prisma `NewsMention`. */
export type DecisionStamp = {
  decisionId: string | null;
  decisionAt: Date | null;
  prevStatus: NewsMentionStatus | null;
  prevShowOnProfile: boolean | null;
  prevEnteredByCwid: string | null;
};

export const CLEARED_DECISION_STAMP: DecisionStamp = {
  decisionId: null,
  decisionAt: null,
  prevStatus: null,
  prevShowOnProfile: null,
  prevEnteredByCwid: null,
};

/** The stamp for a row this decision UPDATES: remember what it was. */
export function stampFor(
  row: { status: string; showOnProfile: boolean; enteredByCwid?: string | null },
  decisionId: string,
  at: Date,
): DecisionStamp {
  return {
    decisionId,
    decisionAt: at,
    prevStatus: row.status as NewsMentionStatus,
    prevShowOnProfile: row.showOnProfile,
    prevEnteredByCwid: row.enteredByCwid ?? null,
  };
}

/** The stamp for a row this decision CREATES: undo deletes it. */
export function stampForCreated(decisionId: string, at: Date): DecisionStamp {
  return { ...CLEARED_DECISION_STAMP, decisionId, decisionAt: at };
}

/** Reflect each owner's profile page post-commit — the only surface these rows
 *  render on (no aggregate serializer reads `news_mention`). An approval that
 *  skips this simply doesn't appear on the profile. It runs after the commit, so
 *  a failure cannot roll the decision back: log and continue. Never throws. */
export async function reflectOwners(cwids: string[], requestId: string): Promise<void> {
  await Promise.all(
    cwids.map(async (cwid) => {
      try {
        const affected = await resolveAffectedProfiles("scholar", cwid, null);
        await reflectVisibilityChange(affected.map((a) => a.slug));
      } catch (error: unknown) {
        console.warn(
          JSON.stringify({
            event: "news_decision_reflect_failed",
            cwid,
            requestId,
            reason: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }),
  );
}
