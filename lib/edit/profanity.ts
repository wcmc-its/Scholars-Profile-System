/**
 * Best-effort profanity screen for a requested slug (#497 §6.3).
 *
 * EXPLICITLY best-effort — NOT a security control and NOT exhaustive. Every slug
 * request is reviewed by a superuser before it can take effect; this only keeps
 * the most obvious junk out of the queue.
 *
 * Matching is on **exact hyphen-delimited tokens**, never substrings. A slug is
 * `[a-z0-9-]`, so the tokens are its words. Substring matching would hit the
 * "Scunthorpe problem" and reject legitimate surnames that merely contain a
 * flagged sequence (e.g. `cockburn`, `bass`, `shitake`) — unacceptable for a
 * name-derived slug system where a scholar must be able to request their own
 * name. Token-exact matching catches `john-<word>-smith` while leaving real
 * names alone; a determined user gluing a word into one token is caught by the
 * human reviewer, which is the actual gate.
 *
 * The list is deliberately short and unambiguous. Extend it from review
 * experience, not speculatively.
 */

/** Unambiguous profane / slur tokens. Lowercase, no hyphens (they're whole tokens). */
const DENY_TOKENS: ReadonlySet<string> = new Set<string>([
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "bastard",
  "asshole",
  "dick",
  "piss",
  "slut",
  "whore",
  "nigger",
  "faggot",
  "retard",
  "spic",
  "kike",
  "chink",
]);

/**
 * True when any hyphen-delimited token of `slug` exactly matches a denylisted
 * term. `slug` is expected already lowercased + normalized (the format
 * validator runs first), but we lowercase defensively.
 */
export function containsProfanity(slug: string): boolean {
  return slug
    .toLowerCase()
    .split("-")
    .some((token) => DENY_TOKENS.has(token));
}
