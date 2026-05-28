/**
 * Server-side sanitization for the feedback form's free-text fields
 * (`purpose_other`, `what_helped`, `one_change`, `role_other`).
 *
 * Plain-text only. No HTML interpretation downstream — values appear
 * only in CSV export and the digest email — so we strip control
 * characters and truncate to the column bound. A null byte is treated
 * as a hostile probe and surfaces an explicit error so the submission
 * server action can 400 the request.
 *
 * Returns `null` for empty / all-whitespace input — semantically "user
 * didn't answer", which is indistinguishable in the database from
 * "question wasn't shown" (see SPEC § NULL semantics). That's an
 * analytical limitation the SPEC documents, not a bug here.
 */

export type SanitizeResult =
  | { ok: true; value: string | null }
  | { ok: false; error: "null_byte" };

// Match a null byte before stripping it — a hostile client shouldn't be
// able to launder one into legitimate-looking text by relying on the
// strip pass below.
const NULL_BYTE = /\x00/;

// Strip ASCII control chars except \t (0x09) and \n (0x0a). \r (0x0d)
// is dropped — text is plain-text not CRLF-significant, and dropping
// \r normalizes Windows-style line endings.
const CONTROL_CHARS = /[\x01-\x08\x0b-\x1f\x7f]/g;

export function sanitizeFreeText(
  input: string | null | undefined,
  maxLen: number,
): SanitizeResult {
  if (input == null || typeof input !== "string") return { ok: true, value: null };
  if (NULL_BYTE.test(input)) return { ok: false, error: "null_byte" };
  const cleaned = input.replace(CONTROL_CHARS, "");
  const trimmed = cleaned.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return { ok: true, value: trimmed.slice(0, maxLen) };
}
