/**
 * Display formatters for the funding-matcher surfaces (the opportunity browse /
 * Grant Matcha console pages and the scholar-facing "Grants for me" card). Pure
 * and client-safe (no db / no server imports) so the row components can call
 * them directly.
 *
 * The calibration constants are best-guess defaults read off the target mockup.
 * They're the most tunable thing here — revisit once we've eyeballed real score
 * ranges on staging (we now have 237 live opportunities to sample).
 */
import type { CareerStage } from "@/lib/career-stage";

// Relative-fit tier cutoffs (share of the strongest defaultScore in the set).
// ponytail: eyeballed thirds-ish; tune once curators review real blends.
const FIT_STRONG = 0.75;
const FIT_GOOD = 0.45;

export type FitTierLabel = "Strong match" | "Good match" | "Possible match";

/**
 * Qualitative fit tier for the scholar card. `defaultScore` is an unbounded
 * internal blend (house rule: ranking math never renders), so — like
 * `topicFitScores` above — bucket RELATIVE to the strongest match in the
 * returned set instead of surfacing the raw number.
 */
export function fitTier(score: number, maxScore: number): FitTierLabel {
  if (maxScore <= 0 || !(score > 0)) return "Possible match";
  const rel = score / maxScore;
  if (rel >= FIT_STRONG) return "Strong match";
  if (rel >= FIT_GOOD) return "Good match";
  return "Possible match";
}

// Short labels for the career-stage filter dropdown + CSV (prose stage phrases
// — "graduate trainee" — are too clunky for a control).
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

// Same order matcha-panel.tsx uses for its own local copy of this array — this
// file doesn't import from it, so it keeps its own.
const CAREER_STAGE_ORDER: readonly CareerStage[] = ["grad", "postdoc", "early", "mid", "senior"];

// A flat spread doesn't single out any one stage as the target.
const APPEAL_FLAT_SPREAD = 0.3;
// Stages within this of the max are "tied for best" (usually one, occasionally two neighbors).
const APPEAL_NEAR_MAX = 0.15;

/**
 * DISPLAY ONLY (a badge), not a scoring input. Reduces `Opportunity.appealByStage`
 * (ReciterAI's {grad, postdoc, early, mid, senior} spread, each 0–1) to one short line,
 * or null when there's nothing to show.
 *
 * The 0.3 / 0.15 thresholds are a lazy first cut calibrated on 3 anecdotal opportunities
 * (Harry Weaver: early 0.9 / senior 0.1 → skewed; A-T Children's Project → broad), not a
 * validated model — tune if a real case reads wrong.
 */
export function appealByStageSummary(appeal: Partial<Record<CareerStage, number>>): string | null {
  const entries = CAREER_STAGE_ORDER.filter((stage) => Number.isFinite(appeal[stage])).map(
    (stage) => [stage, appeal[stage] as number] as const,
  );
  if (entries.length === 0) return null;

  const values = entries.map(([, v]) => v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max - min <= APPEAL_FLAT_SPREAD) return "Appeals broadly across career stages";

  const label = entries
    .filter(([, v]) => max - v <= APPEAL_NEAR_MAX)
    .map(([stage]) => careerStageLabel(stage))
    .join(", ");
  return `Best fit: ${label}`;
}

// ED's `role_category` codes, as the person-type facet renders them. The vocabulary is the
// one `careerStageBucket` switches on (lib/career-stage.ts) — this is a display map for it,
// not a second source of truth about what roles exist.
//
// `doctoral_student_*` is a PREFIX FAMILY, so it is matched, not looked up.
const ROLE_CATEGORY_LABELS: Record<string, string> = {
  full_time_faculty: "Full-time faculty",
  affiliated_faculty: "Affiliated faculty",
  non_faculty_academic: "Non-faculty academic",
  instructor: "Instructor",
  lecturer: "Lecturer",
  postdoc: "Postdoc",
  fellow: "Fellow",
  emeritus: "Emeritus",
  doctoral_student_md: "Doctoral student (MD)",
  doctoral_student_phd: "Doctoral student (PhD)",
  doctoral_student_mdphd: "Doctoral student (MD-PhD)",
  affiliate_alumni: "Alumni",
  non_academic: "Non-academic staff",
};

/**
 * Human label for an ED person-type code. Empty string for absent — the caller decides what
 * absence means, and it is never "unknown person type": a candidate with no Scholar row is
 * left OUT of the facet rather than bucketed into a made-up one.
 *
 * An unrecognised code is HUMANISED (`some_new_role` → "Some new role"), not dropped. ED owns
 * this vocabulary and can extend it without asking us; a hard-coded map that silently hid
 * every scholar carrying a new code would be a worse failure than an imperfect label.
 */
export function roleCategoryLabel(role: string | null | undefined): string {
  if (!role) return "";
  const known = ROLE_CATEGORY_LABELS[role];
  if (known) return known;
  const humanized = role.replace(/_/g, " ").trim();
  return humanized ? humanized.charAt(0).toUpperCase() + humanized.slice(1) : "";
}

const DAY_MS = 86_400_000;
/** Due dates inside this window get the "soon" urgency tone. */
const DUE_SOON_MS = 30 * DAY_MS;

/**
 * "Jun 12, 2026" from an ISO due-date stamp; null when absent/unparseable.
 * Date-only DB columns arrive as midnight UTC; format in UTC so the day
 * doesn't shift back one in US-Eastern.
 */
export function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

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

/**
 * The at-a-glance deadline phrase for an opportunity. `status` is nullable
 * because a Matcha `GrantCandidate` carries an unknown status (unlike the
 * forward matcher's non-null `Opportunity.status`); an unknown status is just
 * "not continuous / not forecasted", so it falls through to the dated / rolling
 * branches. formatDue renders in UTC (#1608) — due dates are midnight-UTC.
 */
export function deadlineLabel(dueDate: string | null, status: string | null): string {
  if (status === "continuous") return "Rolling · continuous";
  // A forecasted item without a date yet is NOT rolling — it has a date TBD.
  if (dueDate === null)
    return status === "forecasted" ? "Forecasted · date TBD" : "Rolling · continuous";
  const formatted = formatDue(dueDate);
  if (!formatted) return "—";
  return status === "forecasted" ? `Forecasted · ${formatted}` : `Due ${formatted}`;
}

/** Compact USD: 500000 → "$500K", 1_200_000 → "$1.2M". */
export function formatUsd(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}
