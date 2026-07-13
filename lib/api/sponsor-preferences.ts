/**
 * #1654 — the preference PRODUCER: the sponsor's non-topical asks, read out of the paste.
 *
 * A sponsor's description says two things at once. Most of it is topical ("we fund work on
 * fibrosis"), and the spine already decomposes that into concepts. A smaller part is a
 * non-topical preference about the PERSON — "we especially want to support early-career
 * physician-scientists" — which no concept can express. That sentence is what this reads.
 *
 * DETERMINISTIC, NOT LLM, on purpose:
 *
 *  1. The vocabulary is CLOSED. A preference is only actionable if some `SponsorMeasures`
 *     field can answer it, and there are exactly two: career stage and clinician status.
 *     An open-ended LLM extraction would happily return "prefers collaborative teams" —
 *     which we cannot score, so it would render as a nudge that nudges nothing.
 *  2. The concept extractor's prompt was tuned against the ranking eval (nDCG@20 0.610).
 *     Bolting preference extraction onto that prompt risks perturbing concept extraction,
 *     which would move the ranking for reasons that have nothing to do with preferences.
 *     A separate deterministic pass cannot do that.
 *  3. It is testable without a model, and it never costs a Bedrock call.
 *
 * ponytail: phrase list, not a classifier. It matches the sponsor boilerplate this surface
 * actually sees. If officers hit real misses, the upgrade path is a scoped LLM pass whose
 * OUTPUT is still constrained to these measures — not a wider vocabulary.
 */
import type { CareerStage } from "@/lib/career-stage";
import type { SponsorPreference } from "@/lib/api/sponsor-match-contract";

/** Early-career phrasings. `ESI` is matched case-sensitively as a word — lowercase "esi"
 *  is a substring of nothing useful, but it is also not how a sponsor writes it. */
const EARLY_PHRASES = [
  "early career",
  "early-career",
  "early stage investigator",
  "early-stage investigator",
  "junior faculty",
  "junior investigator",
  "new investigator",
  "emerging investigator",
  "rising star",
];

const SENIOR_PHRASES = [
  "senior investigator",
  "senior faculty",
  "established investigator",
  "established faculty",
  "senior scientist",
];

const CLINICIAN_PHRASES = [
  "physician-scientist",
  "physician scientist",
  "clinician-scientist",
  "clinician scientist",
  "clinical investigator",
  "practicing physician",
  "practicing clinician",
];

/** The stages an "early-career" ask rewards. Postdocs are NOT included: a sponsor asking for
 *  early-career INVESTIGATORS means junior faculty, not trainees, and rewarding postdocs
 *  would surface people who cannot hold the award. */
const EARLY_STAGES: CareerStage[] = ["early"];
const SENIOR_STAGES: CareerStage[] = ["senior"];

/**
 * Default importance for a detected preference — the slider start, and the weight it carries
 * in `preferenceBoost`.
 *
 * 1.0, not a guess at "how much" the sponsor meant it. The sponsor either said it or did not;
 * inventing a confidence gradient from phrasing ("especially" = 0.8?) would be fabrication.
 * The officer tunes strength by DESELECTING a preference they disagree with, and the global
 * λ bounds how far any of this can move the ranking.
 */
const DETECTED_IMPORTANCE = 1;

/**
 * INCLUSION, NOT PREFERENCE — the false positive this guard exists for.
 *
 * Caught against the real eval gold set: the `cardiovascular-broad` sponsor paste says
 *
 *     "We welcome basic, translational, and clinical investigators alike…"
 *
 * which names a group my phrase list matches while saying the exact OPPOSITE of a
 * preference: everyone is welcome. Read as a preference, it boosted clinicians by up to λ on
 * a paste that had deliberately declined to prefer them — an inversion of the sponsor's own
 * words, which is worse than not reading the sentence at all.
 *
 * A sponsor expressing a preference SINGLES OUT a group. A sponsor being inclusive
 * ENUMERATES groups and waves them all through. These are the markers of the second, checked
 * against the SENTENCE the phrase sits in (a marker three sentences away says nothing about
 * this clause).
 *
 * ponytail: sentence-scoped marker list, not a parser. It kills the observed family —
 * "…and X alike", "X as well as Y", "at any career stage", "regardless of stage". If a real
 * paste slips through, add the marker; the officer can always uncheck the chip meanwhile.
 */
const INCLUSION_MARKERS = [
  "alike",
  "as well as",
  "regardless of",
  "any career stage",
  "any stage",
  "all career stages",
  "all stages",
  "at every stage",
  "of any kind",
  "whether ",
];

/** The sentence containing `at`. Sentence-scoped so a marker elsewhere in the email can't
 *  suppress a genuine ask (and vice versa). */
function sentenceAround(hay: string, at: number): string {
  const start = Math.max(0, hay.lastIndexOf(".", at) + 1);
  const dot = hay.indexOf(".", at);
  return hay.slice(start, dot === -1 ? hay.length : dot);
}

/** True when the matched phrase is the sponsor being INCLUSIVE, not stating a preference. */
function isInclusion(hay: string, at: number): boolean {
  const sentence = sentenceAround(hay, at);
  return INCLUSION_MARKERS.some((m) => sentence.includes(m));
}

/** The matched phrase in context, as the "from paste: …" provenance line. Trimmed to a
 *  readable window so the chip's tooltip shows the sentence, not the whole email. */
function quote(paste: string, at: number, phraseLen: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(paste.length, at + phraseLen + 40);
  const snippet = paste.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < paste.length ? "…" : ""}`;
}

/**
 * First hit among `phrases` that is an actual PREFERENCE, or null. A hit inside an inclusive
 * clause is skipped and the search continues — a paste can welcome everyone in one sentence
 * and still state a real preference in another.
 */
function findPhrase(haystack: string, phrases: readonly string[]): { at: number; len: number } | null {
  let best: { at: number; len: number } | null = null;
  for (const p of phrases) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(p, from);
      if (at === -1) break;
      if (!isInclusion(haystack, at) && (best === null || at < best.at)) {
        best = { at, len: p.length };
      }
      from = at + p.length;
    }
  }
  return best;
}

/**
 * Read the sponsor's non-topical asks out of the paste. Returns [] when it says nothing about
 * the person — which is the common case, and which leaves the preference term of the formula
 * inert exactly as before.
 *
 * Early-career and senior are mutually exclusive: a paste that somehow names both is
 * expressing no usable preference, so neither is emitted rather than having them fight.
 */
export function extractSponsorPreferences(paste: string): SponsorPreference[] {
  const hay = paste.toLowerCase();
  const out: SponsorPreference[] = [];

  const early = findPhrase(hay, EARLY_PHRASES);
  const senior = findPhrase(hay, SENIOR_PHRASES);
  if (early && !senior) {
    out.push({
      measure: "careerStage",
      stages: EARLY_STAGES,
      label: "Early-career",
      evidence: quote(paste, early.at, early.len),
      importance: DETECTED_IMPORTANCE,
    });
  } else if (senior && !early) {
    out.push({
      measure: "careerStage",
      stages: SENIOR_STAGES,
      label: "Senior / established",
      evidence: quote(paste, senior.at, senior.len),
      importance: DETECTED_IMPORTANCE,
    });
  }

  const clinician = findPhrase(hay, CLINICIAN_PHRASES);
  if (clinician) {
    out.push({
      measure: "isClinician",
      label: "Physician-scientist",
      evidence: quote(paste, clinician.at, clinician.len),
      importance: DETECTED_IMPORTANCE,
    });
  }

  return out;
}
