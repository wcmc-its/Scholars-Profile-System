/**
 * #2020 follow-up — a title-based safety net for confidential InfoEd records.
 *
 * InfoEd's own "Confidential" flag (prop_u.p_log_50, excluded at the
 * CONSOLIDATED_QUERY source in etl/infoed/index.ts) is a manual checkbox: it
 * only works if whoever entered the record remembered to set it. A live check
 * of the current gap/grant population (2026-07-31) found it wasn't set on
 * several CDAs and NDAs, including two then-active ones already rendering on
 * public profiles ("Winn CDA Contact for Dr. Rohit Jain"; a trial titled
 * "...(2024 Winn CDA)"). This is a second, independent signal: the title
 * itself.
 *
 * Deliberately narrow. A bare "CDA"/"NDA" substring is too noisy to trust —
 * "The LUCINDA Trial", "CDADC1" (a gene), "Rural Uganda", "NeuroVanda
 * Therapeutics", and "Linda Vahdat" all contain the letters, but none is a
 * confidentiality agreement. Matching on the acronym as a whole WORD (not a
 * substring — none of those five have a word boundary around "cda"/"nda")
 * eliminates all of them without a manual exclude-list. Same reasoning for
 * "Confidentiality Agreement" as a phrase, not the word "confidential" alone:
 * a title can legitimately be ABOUT confidentiality (e.g. a study on
 * telehealth privacy for domestic-violence survivors) without BEING a
 * confidentiality agreement.
 *
 * NDA is ambiguous — it can also mean "New Drug Application," an unrelated
 * (and non-confidential) FDA regulatory filing. CDA can mean "Career
 * Development Award," also unrelated. MTA (Material Transfer Agreement) and
 * DUA (Data Use Agreement) are noisier still — a wide sweep of prod titles
 * (2026-07-31) found 12 MTA and 4 DUA hits, and every one was routine
 * (academic mouse-strain sharing; CMS claims-data research), not a secrecy
 * agreement. Included anyway: the asymmetry holds regardless of hit rate — a
 * false suppression is a one-line revoke (Suppression is user-revocable,
 * ADR-005), a leaked confidential agreement is not undoable, so the bar for
 * flagging is "plausibly confidential," not "probably confidential." See the
 * SYSTEM_CONFIDENTIAL_TITLE suppression in etl/infoed/index.ts — every match
 * is revocable, never a silent drop.
 */

const CONFIDENTIAL_ACRONYM_RE = /\b(?:CDA|NDA|MTA|DUA)\b/i;
const CONFIDENTIAL_PHRASE_RE =
  /\bconfidential(?:ity)?\s+disclosure\s+agreement\b|\bnon-?disclosure\s+agreement\b|\bconfidentiality\s+agreement\b/i;

export function isConfidentialTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return CONFIDENTIAL_ACRONYM_RE.test(title) || CONFIDENTIAL_PHRASE_RE.test(title);
}
