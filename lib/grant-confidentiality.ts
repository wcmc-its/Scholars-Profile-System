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
 * (and non-confidential) FDA regulatory filing. Given the asymmetry (a false
 * suppression is a one-line revoke; a leaked CDA is not undoable), this errs
 * toward flagging it anyway. See the SYSTEM_CONFIDENTIAL_TITLE suppression in
 * etl/infoed/index.ts — every match is revocable, never a silent drop.
 */

const CDA_NDA_ACRONYM_RE = /\b(?:CDA|NDA)\b/i;
const CONFIDENTIAL_PHRASE_RE =
  /\bconfidential(?:ity)?\s+disclosure\s+agreement\b|\bnon-?disclosure\s+agreement\b|\bconfidentiality\s+agreement\b/i;

export function isConfidentialTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return CDA_NDA_ACRONYM_RE.test(title) || CONFIDENTIAL_PHRASE_RE.test(title);
}
