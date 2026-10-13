/**
 * Honor tiers — how important an honor is, 1 (highest) to 6. A CURATOR tool:
 * it drives the honors queue's sort, facet and filter so curators can move
 * between kinds of honor and make sure no pinnacle prize is missed. Faculty
 * never see it — not on the profile, not in self-edit, not in the CV.
 *
 * The tier belongs to the HONOR, the (organization, name) pair, not to the
 * conferring body alone: the National Science Foundation gives both the National
 * Medal of Science (tier 1) and CAREER awards (tier 4). It replaced the
 * organization-keyed `HONOR_PRESTIGE` weights, which sorted every CAREER award
 * to the top for exactly that reason.
 *
 * Effective tier = the curator's `tier_override` ?? the first matching rule
 * below ?? institutional/media body ⇒ 6 ?? 5. Rules live in code, so changing
 * one re-tiers every row at once with no backfill; a curator override always
 * wins. Plan: Projects/Scholars-Profile-System/honor-tiers-plan.md.
 */

export type HonorTier = 1 | 2 | 3 | 4 | 5 | 6;

export const HONOR_TIERS: readonly HonorTier[] = [1, 2, 3, 4, 5, 6];

export const HONOR_TIER_LABELS: Record<HonorTier, string> = {
  1: "Pinnacle prizes",
  2: "National academies & HHMI",
  3: "Elite societies & major national awards",
  4: "Career-development distinctions",
  5: "Society awards, lectures & service",
  6: "Institutional & media recognition",
};

export function isHonorTier(value: unknown): value is HonorTier {
  return typeof value === "number" && (HONOR_TIERS as readonly number[]).includes(value);
}

/** One rule: an organization test and/or an honor-name test, both must hold. */
type Rule = { org?: RegExp; name?: RegExp; tier: HonorTier };

/** Membership-grade names an academy or society elects to ("Member", "Fellow",
 *  "Foreign Member", "International Member"). */
const ELECTED = /^(foreign |international )?(member|fellow)\b/i;

/**
 * First match wins, so a specific honor sits above its body's general rule.
 * Org patterns run on the folded organization (see `fold`), so "(AACR)"-style
 * suffixes, "&" and case do not matter.
 */
const RULES: readonly Rule[] = [
  // 1 — pinnacle prizes. Name-only: the newsroom spells their bodies many ways.
  {
    name: /\b(nobel prize|lasker|national medal of science|shaw prize|breakthrough prize|horwitz prize|wolf prize|gairdner|kyoto prize|albany (medical center )?prize|japan prize|kavli prize|crafoord prize)\b/i,
    tier: 1,
  },
  { name: /\bmacarthur fellow/i, tier: 1 },
  { org: /\bmacarthur foundation\b/, tier: 1 },

  // 2 — national academies (on election) and HHMI investigators.
  {
    org: /^(national academy of (sciences|medicine|engineering)|american philosophical society|american academy of arts and sciences|royal society)$/,
    name: ELECTED,
    tier: 2,
  },
  { org: /^howard hughes medical institute$/, name: /\binvestigator\b/i, tier: 2 },

  // 3 — elite elected societies and major national awards.
  {
    org: /^(american society for clinical investigation|association of american physicians|national academy of inventors|american association for the advancement of science)$/,
    name: ELECTED,
    tier: 3,
  },
  { name: /\b(director'?s pioneer award|waterman award)\b/i, tier: 3 },

  // 4 — competitive career-development distinctions.
  { name: /\b(pecase|presidential early career award)\b/i, tier: 4 },
  { org: /^national science foundation$/, name: /\bcareer\b/i, tier: 4 },
  {
    org: /^(alfred p sloan foundation|david and lucile packard foundation|pew charitable trusts|searle scholars program|burroughs wellcome fund|damon runyon cancer research foundation|rita allen foundation)$/,
    tier: 4,
  },
  { org: /^howard hughes medical institute$/, tier: 4 }, // Gray Fellows, Faculty Scholars
  { org: /^american college of physicians$/, name: /\bmaster/i, tier: 4 },
];

/** Bodies whose honors are institutional or media recognition — tier 6
 *  whatever the honor's name. Checked AFTER the rules, so a Weill Cornell row
 *  can never outrank a curated rule but always sinks below external awards. */
const INSTITUTIONAL =
  /\b(cornell|newyork presbyterian|new york presbyterian|nyp|castle connolly|crain s|forbes|new york magazine|newsweek|u s news|becker s|modern healthcare|super doctors|top doctors)\b/;

/** Lowercase; "&" → "and"; parentheticals and punctuation dropped; spaces folded. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();
}

/** The rule-derived tier of an honor (no curator override). */
export function ruleTier(organization: string, name: string): HonorTier {
  const org = fold(organization);
  const nm = name.trim();
  for (const r of RULES) {
    if ((r.org === undefined || r.org.test(org)) && (r.name === undefined || r.name.test(nm)))
      return r.tier;
  }
  return INSTITUTIONAL.test(org) ? 6 : 5;
}

/** The effective tier: the curator's override when set, else the rules. */
export function honorTier(
  organization: string,
  name: string,
  override: number | null | undefined,
): HonorTier {
  return isHonorTier(override) ? override : ruleTier(organization, name);
}
