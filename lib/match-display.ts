/**
 * Display formatters for the reverse funding matcher ("Researchers for this
 * opportunity"). Pure and client-safe (no db / no server imports) so the row
 * component can call them directly.
 *
 * The calibration constants are best-guess defaults read off the target mockup.
 * They're the most tunable thing here — revisit once we've eyeballed real score
 * ranges on staging (we now have 237 live opportunities to sample).
 */
import type { CareerStage } from "@/lib/career-stage";

/**
 * Topic fit as a 0–100 score for display. Raw topicFit (Σ topicWeight·variantB)
 * is unbounded and corpus-dependent, so scale relative to the strongest match
 * in the current result set.
 * ponytail: relative-to-max (top → 100). The mockup tops at 94, i.e. an absolute
 * curve — swap this for a fixed saturating curve once real scores show whether
 * "everyone's a 90+" reads as inflated. Knob lives here, callers don't change.
 */
export function topicFitScores(rawTopicFits: number[]): number[] {
  const max = Math.max(0, ...rawTopicFits);
  if (max <= 0) return rawTopicFits.map(() => 0);
  return rawTopicFits.map((v) => Math.round((100 * v) / max));
}

export type StageTone = "strong" | "moderate" | "weak" | "none";
export type StageFit = { label: string; tone: StageTone };

// ponytail: thirds; tune cutoffs once curators eyeball the badges.
const STAGE_STRONG = 0.66;
const STAGE_MODERATE = 0.33;

/**
 * Bucket the opportunity's appeal-for-this-stage (appeal_by_stage value, 0–1)
 * into a row badge. `stageKnown` is false when we couldn't date the scholar.
 */
export function stageFit(stageAppeal: number, stageKnown: boolean): StageFit {
  if (!stageKnown) return { label: "Unknown", tone: "none" };
  if (stageAppeal >= STAGE_STRONG) return { label: "Strong", tone: "strong" };
  if (stageAppeal >= STAGE_MODERATE) return { label: "Moderate", tone: "moderate" };
  if (stageAppeal > 0) return { label: "Some", tone: "weak" };
  return { label: "Limited", tone: "none" };
}

const STAGE_PHRASE: Record<CareerStage, string> = {
  grad: "graduate trainee",
  postdoc: "postdoctoral researcher",
  early: "early-career",
  mid: "mid-career",
  senior: "senior",
};

/**
 * One-line, fact-only blurb for a researcher row — built from the matcher's own
 * evidence, no LLM. `topicLabel` is the human name of the strongest contributing
 * topic (resolved by the caller from the topic table).
 * ESI eligibility + funding status are a later slice (need grant history); they
 * append as further clauses here when available.
 */
export function researcherBlurb(input: {
  pubCount: number;
  minYear: number | null;
  topicLabel: string;
  careerStage: CareerStage | null;
}): string {
  const parts: string[] = [];
  if (input.pubCount > 0) {
    const noun = input.pubCount === 1 ? "publication" : "publications";
    const since = input.minYear ? ` since ${input.minYear}` : "";
    parts.push(`${input.pubCount} ${noun} on ${input.topicLabel}${since}`);
  }
  if (input.careerStage) parts.push(STAGE_PHRASE[input.careerStage]);
  return parts.length ? `${parts.join("; ")}.` : "";
}
