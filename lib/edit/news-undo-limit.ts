/**
 * Most decision ids one POST /api/edit/news-mention/undo accepts. A dependency-
 * free module so the client queues can size a bulk action to what one Undo can
 * take back (lib/edit/news-decision.ts is server-only). The media highlights
 * bulk bar caps a selection at this, so its Undo is always one all-or-nothing
 * call.
 */
export const NEWS_UNDO_MAX_DECISIONS = 100;
