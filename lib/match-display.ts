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
import { toCsv } from "@/lib/csv";

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
  /** Grant-history clause (optional; appended when the matcher supplies it). */
  esiEligible?: boolean;
  yearsSinceDegree?: number | null;
}): string {
  const parts: string[] = [];
  if (input.pubCount > 0) {
    const noun = input.pubCount === 1 ? "publication" : "publications";
    const since = input.minYear ? ` since ${input.minYear}` : "";
    parts.push(`${input.pubCount} ${noun} on ${input.topicLabel}${since}`);
  }
  if (input.careerStage) parts.push(STAGE_PHRASE[input.careerStage]);
  if (input.esiEligible) {
    const yrs = input.yearsSinceDegree;
    parts.push(
      yrs != null ? `ESI-eligible (${yrs} yr${yrs === 1 ? "" : "s"} since terminal degree)` : "ESI-eligible",
    );
  }
  return parts.length ? `${parts.join("; ")}.` : "";
}

// Short labels for the career-stage filter dropdown + CSV (the blurb's STAGE_PHRASE
// is prose — "graduate trainee" — too clunky for a control).
const CAREER_STAGE_LABELS: Record<CareerStage, string> = {
  grad: "Graduate",
  postdoc: "Postdoc",
  early: "Early career",
  mid: "Mid career",
  senior: "Senior",
};

export function careerStageLabel(stage: CareerStage | null): string {
  return stage ? CAREER_STAGE_LABELS[stage] : "";
}

// Funding status (mirrors FundingStatus in lib/api/match-researchers; redeclared
// here so this client-safe module imports no server code).
export type FundingStatus = "funded" | "unfunded";
const FUNDING_STATUS_LABELS: Record<FundingStatus, string> = {
  funded: "Currently funded",
  unfunded: "Not currently funded",
};

export function fundingStatusLabel(status: FundingStatus | null | undefined): string {
  return status ? FUNDING_STATUS_LABELS[status] : "";
}

const DAY_MS = 86_400_000;
/** Due dates inside this window get the "soon" urgency tone. */
const DUE_SOON_MS = 30 * DAY_MS;

export type DueUrgency = "past" | "soon" | null;

/**
 * Urgency of an opportunity due date at `now` (epoch ms): "past" once behind
 * us, "soon" within 30 days, null otherwise (or when unparseable/absent).
 * Due dates are date-only (midnight UTC), so "past" starts a full day after
 * the stamp — an opportunity is never "(passed)" on its own due day.
 */
export function dueUrgency(iso: string | null, now: number): DueUrgency {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  if (t + DAY_MS < now) return "past";
  if (t - now <= DUE_SOON_MS) return "soon";
  return null;
}

/** One researcher's row for the CSV export (selected rows in the matcher). */
export type ResearcherCsvInput = {
  cwid: string;
  name: string;
  title: string | null;
  department: string | null;
  careerStage: CareerStage | null;
  topicFit: number;
  stageLabel: string;
  topTopicLabel: string;
  topPubCount: number;
  esiEligible?: boolean;
  fundingStatus?: FundingStatus | null;
};

/** Build the export CSV for the selected researchers (escaping via lib/csv). */
export function buildResearcherCsv(rows: readonly ResearcherCsvInput[]): string {
  return toCsv(
    [
      "CWID",
      "Name",
      "Title",
      "Department",
      "Career stage",
      "Topic fit",
      "Stage fit",
      "ESI eligible",
      "Funding status",
      "Top topic",
      "Papers on top topic",
    ],
    rows.map((r) => [
      r.cwid,
      r.name,
      r.title ?? "",
      r.department ?? "",
      careerStageLabel(r.careerStage),
      r.topicFit,
      r.stageLabel,
      r.esiEligible == null ? "" : r.esiEligible ? "Yes" : "No",
      fundingStatusLabel(r.fundingStatus),
      r.topTopicLabel,
      r.topPubCount,
    ]),
  );
}
