/**
 * RePORTER profile-candidate "Is this you?" reject reasons — the enum a scholar
 * (or a genuine superuser on their behalf) records when declining a K=2 match
 * (docs/reporter-grants-v2-matcher-spec.md §6.2). Mirror of
 * `lib/coi-gap/feedback.ts`: shared by the card (the "Not me ▾" dropdown labels)
 * and the reject route (the body-shape guard), so the two can't drift.
 *
 * PURE SIGNAL, enum-only (decision §14-B — no free-text "why"): a reject is
 * terminal (never re-proposed) and feeds matcher QA — a high `not_me` rate flags
 * a precision problem. The reason is NEVER an accusation and triggers no workflow.
 */
export const REJECT_REASONS = ["not_me", "name_only", "cant_tell"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Narrow an untrusted request value to a known reject reason. */
export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === "string" && (REJECT_REASONS as readonly string[]).includes(value);
}

/** Display labels for the "Not me ▾" choices (the card; first person — the
 *  scholar is answering about their own grants). */
export const REJECT_REASON_LABEL: Record<RejectReason, string> = {
  not_me: "These aren't mine",
  name_only: "Same name — a different person",
  cant_tell: "I can't tell",
};
