/**
 * Consent text + version for the feedback form Q9.
 *
 * **PR-1 scope**: expose the version constant + a stub current-consent
 * loader so PR-2 (form) and PR-3 (export + B03 audit) can import this
 * module without depending on the consent markdown landing first.
 *
 * **PR-3 lands `docs/feedback-consent-v1.md`** — the actual disclosure
 * the IRB will review. PR-3 wires `loadConsentMarkdown()` to read that
 * file at build time (a server-side fs.readFile) and the form renders
 * the markdown body inline; this stub returns the placeholder string
 * below in the meantime so internal smoke tests can exercise the
 * write-path end-to-end before the real text is finalized.
 *
 * **Versioning**: every word change to the disclosure bumps
 * `CURRENT_CONSENT_VERSION`. Submissions store the version they
 * accepted; analysts and IRB reviewers can therefore segment by the
 * disclosure version any given respondent saw. See SPEC §
 * "When the question set may change" — wording changes are an IRB
 * protocol amendment, not a code change.
 */

/** Bump on any consent-text change (IRB protocol amendment required). */
export const CURRENT_CONSENT_VERSION = "v1" as const;

const PLACEHOLDER_TEXT = `
I understand that my response may be analyzed in aggregate and used in
published reports about the Scholars Profile System. No personally
identifying information will be included without my explicit further
consent.

Your CWID or email (if provided) is used only to contact you for an
optional follow-up. It is never included in published reports.
`.trim();

/**
 * Returns the consent text the form should display alongside the Q9
 * checkbox. Stub in PR-1; PR-3 swaps in a `fs.readFile` of
 * `docs/feedback-consent-v1.md` plus the IRB determination number.
 */
export function loadConsentMarkdown(): string {
  return PLACEHOLDER_TEXT;
}
