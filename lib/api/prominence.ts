/**
 * The ONE definition of a scholar's "prominence" score and institutional-
 * leadership tier.
 *
 * Extracted from `lib/api/data-quality.ts` (still the owner of the /edit/profiles
 * + /edit/coi roster query) when the news-approval queue needed to offer the same
 * ordering. Two copies of this formula would drift the first time anyone tuned a
 * weight — the repeated failure mode this module exists to prevent — so the
 * weights, the tier rules and the arithmetic live here and nowhere else.
 *
 * Two entry points, because the two callers have opposite shapes:
 *   - `scoreProminence` — the pure formula. `data-quality.ts` keeps its own
 *     whole-roster reads (grouped aggregates across the entire table, joined
 *     in-app; see its module doc comment on why) and calls this per candidate.
 *   - `computeProminence` — the same score for a BOUNDED set of cwids, doing its
 *     own `IN`-scoped reads. For callers holding a few hundred cwids (the news
 *     queue), not for a whole-roster load.
 *
 * Server-only by construction (Prisma types + reads) but with no `server-only`
 * import, so it loads under vitest with a fake client — matching `data-quality.ts`.
 */
import { PI_ROLES } from "@/lib/funding-roles";
import {
  CENTER_ENTITY_TYPE,
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
} from "@/lib/org-unit-roles";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { rankTitleText, TITLE_RANK } from "@/lib/scholar-title";

/** The Prisma surface `computeProminence` reads — a `db.read` client satisfies it. */
export type ProminenceClient = Pick<PrismaClient, "scholar" | "grant" | "orgUnitRoleAssignment">;

/**
 * cwids that direct a center. Every tracked center is school-wide, so each is
 * an Institutional Center Director (rank 5). `cwids` bounds the read
 * (`computeProminence`); omit it for a whole-roster load (`data-quality.ts`).
 */
export async function loadCenterDirectors(
  client: Pick<PrismaClient, "orgUnitRoleAssignment">,
  cwids?: readonly string[],
): Promise<Set<string>> {
  const rows = await client.orgUnitRoleAssignment.findMany({
    where: {
      entityType: CENTER_ENTITY_TYPE,
      roleKey: DIRECTOR_ROLE_KEY,
      ...(cwids ? { cwid: { in: [...cwids] } } : {}),
    },
    select: { cwid: true },
  });
  return new Set(rows.map((r) => r.cwid));
}

/** Prominence weights — kept here so they're easy to tune in one place.
 *  Leadership weights mirror the people-search #532 constants (chair > chief). */
const W_HINDEX = 0.5;
const W_PI = 0.5;
const W_NIH_PI = 0.5;
const W_CHAIR = 3.0;
const W_CHIEF = 1.5;
const W_FACULTY = 1.0;

/**
 * Institutional-leadership sort tiers (lower number ranks higher). Since
 * 2026-09-24 these ARE the EA title ladder (`TITLE_RANK`, lib/scholar-title.ts)
 * — one ladder for both the display-title pick and this sort — plus tier 0,
 * which keeps THE Dean alone above rank 1 (#1 v2 decision: the Dean ranks #1
 * even though he is not a department chair).
 *
 * The rank is the best of the resolved `primaryTitle` TEXT (no hand-maintained
 * cwid map, so it stays current as titles change) and the FK roles the text
 * cannot always express: department chair (4), center director (5 or 10),
 * division chief (6). Within a tier, prominence then name.
 *
 * Emeritus/Emerita titles hold no office — a retired dean ranks as academic
 * by prominence like everyone else (#1 v2 refinement).
 */
export const LEADERSHIP_TIER = { dean: 0, ...TITLE_RANK, none: TITLE_RANK.unranked } as const;

const TITLE_EMERITUS = /\bemerit(?:us|a|i)\b/i;
const HAS_DEAN = /\bdean\b/i;
/** Modifiers that demote a "Dean" title out of tier 0 (it's a sub-dean). */
const SUBDEAN_MODIFIER = /\b(?:associate|assistant|affiliate|senior|interim|deputy|vice)\b/i;
/** A school/college-specific deanship (Graduate School, WCM-Qatar) is not THE dean. */
const SCHOOL_SPECIFIC_DEAN = /\b(?:graduate school|qatar)\b/i;

/** A concise label for an active (non-Emeritus) deanery / institutional-officer title. */
function deaneryLabel(title: string): string | null {
  if (/\bsenior associate dean\b/i.test(title)) return "Senior Associate Dean";
  if (/\bassociate dean\b/i.test(title)) return "Associate Dean";
  if (/\bassistant dean\b/i.test(title)) return "Assistant Dean";
  if (/\baffiliate dean\b/i.test(title)) return "Affiliate Dean";
  if (/\b(?:vice|deputy) dean\b/i.test(title)) return "Vice Dean";
  if (/\binterim dean\b/i.test(title)) return "Interim Dean";
  if (/\bassociate vice provost\b/i.test(title)) return "Associate Vice Provost";
  if (/\bassistant vice provost\b/i.test(title)) return "Assistant Vice Provost";
  if (/\bvice provost\b/i.test(title)) return "Vice Provost";
  if (HAS_DEAN.test(title)) return "Dean"; // school-specific dean (Graduate School / Qatar)
  if (/\bprovost\b/i.test(title)) return "Provost";
  // Most specific first: a bare /president/ also matches "Vice President …".
  if (/\bexecutive vice (?:president|dean)\b|\bevp\b/i.test(title)) return "EVP";
  if (/\bsenior vice president\b/i.test(title)) return "Senior Vice President";
  if (/\b(?:associate|assistant) vice president\b/i.test(title)) return "Associate Vice President";
  if (/\bvice president\b/i.test(title)) return "Vice President";
  if (/\bpresident\b/i.test(title)) return "President";
  return null;
}

/**
 * Classify a scholar's leadership tier + display label from their title + the
 * FK role flags: the best (lowest) of the title's ladder rank and each role's.
 *
 * `chairLabel` is pre-resolved by the caller, not a plain "is this cwid a
 * department chair" boolean: an administrative department's leader is a
 * DIRECTOR, not a Chair (#58 / #2542) — the caller reads it straight off the
 * `OrgUnitRoleAssignment.roleKey`, which already carries that distinction.
 * `null` means "not a department leader at all";
 * a non-null string is "Chair" or "Director" (whichever the caller resolved).
 * `isChief` stays a boolean — divisions have no category ternary, so there is
 * only one possible label for them.
 */
export function classifyLeadership(
  title: string | null,
  chairLabel: string | null,
  isChief: boolean,
  isCenterDirector = false,
): { tier: number; label: string | null } {
  const t = (title ?? "").trim();
  const active = t !== "" && !TITLE_EMERITUS.test(t);
  if (active && HAS_DEAN.test(t) && !SUBDEAN_MODIFIER.test(t) && !SCHOOL_SPECIFIC_DEAN.test(t)) {
    return { tier: LEADERSHIP_TIER.dean, label: "Dean" };
  }
  const textRank = rankTitleText(t);
  const candidates: Array<[number, string | null]> = [
    [textRank, textRank <= TITLE_RANK.associateViceProvost && active ? deaneryLabel(t) : null],
  ];
  if (textRank === TITLE_RANK.chair) candidates[0][1] = "Chair";
  if (textRank === TITLE_RANK.divisionChief) candidates[0][1] = "Chief";
  if (textRank === TITLE_RANK.viceChair) candidates[0][1] = "Vice Chair";
  if (chairLabel) candidates.push([TITLE_RANK.chair, chairLabel]);
  if (isCenterDirector) {
    candidates.push([TITLE_RANK.institutionalCenterDirector, "Center Director"]);
  }
  if (isChief) candidates.push([TITLE_RANK.divisionChief, "Chief"]);
  // Stable: on a tie the title text (listed first) keeps its own label.
  const [tier, label] = candidates.reduce((best, c) => (c[0] < best[0] ? c : best));
  return { tier, label };
}

/** Everything the formula reads. Nulls are the DB's own — never pre-coerced by
 *  the caller, so the `?? 0` guards below stay in ONE place. */
export type ProminenceInputs = {
  scoredPubCount: number | null;
  hIndex: number | null;
  roleCategory: string | null;
  primaryTitle: string | null;
  /** Pre-resolved department-leader label ("Chair" / "Director"); null when not
   *  a department leader. See `classifyLeadership` on why this is not a boolean. */
  chairLabel: string | null;
  isChief: boolean;
  /** Directs a center (always school-wide, rank 5). Defaults to false. */
  isCenterDirector?: boolean;
  piCount: number | null;
  nihPiCount: number | null;
};

export type ProminenceEntry = {
  prominence: number;
  /** Leadership sort tier: 0 THE Dean, then the EA ladder 1–12, 13 none. */
  leadershipTier: number;
  /** Display label ("Dean", "Associate Dean", "Chair", "Chief", …) or null. */
  leadershipLabel: string | null;
};

/**
 * The prominence formula + leadership tier for one scholar. Pure — no reads, no
 * clock — so both callers get identical numbers from identical inputs.
 *
 * Every count is `?? 0` guarded: `Math.log1p(null)` silently coerces to
 * `log1p(0)` today, but a missing count reaching the formula as `undefined` would
 * poison the whole score to NaN and sort that scholar arbitrarily.
 */
export function scoreProminence(input: ProminenceInputs): ProminenceEntry {
  const prominence =
    Math.log1p(input.scoredPubCount ?? 0) +
    W_HINDEX * Math.log1p(input.hIndex ?? 0) +
    Math.max(input.chairLabel !== null ? W_CHAIR : 0, input.isChief ? W_CHIEF : 0) +
    W_PI * Math.log1p(input.piCount ?? 0) +
    W_NIH_PI * Math.log1p(input.nihPiCount ?? 0) +
    (input.roleCategory === "full_time_faculty" ? W_FACULTY : 0);

  const { tier, label } = classifyLeadership(
    input.primaryTitle,
    input.chairLabel,
    input.isChief,
    input.isCenterDirector ?? false,
  );
  return { prominence, leadershipTier: tier, leadershipLabel: label };
}

/**
 * Prominence + leadership tier for a BOUNDED set of cwids.
 *
 * Every read is `IN`-scoped to `cwids` — this is deliberately NOT the
 * whole-roster shape `data-quality.ts` uses. That module loads the entire
 * in-scope roster because it SORTS and PAGINATES all of it; a caller that
 * already knows its cwids (the news queue: a few hundred distinct scholars
 * behind ~1,400 pending mentions) must not drag the roster in behind them.
 *
 * Callers should dedupe before calling, and this dedupes again — five bounded
 * queries per call, never one per row.
 *
 * A cwid with no scholar row is simply ABSENT from the returned map (rather than
 * carrying a fabricated 0-score entry the caller can't distinguish from a real
 * one); callers supply their own default.
 */
export async function computeProminence(
  client: ProminenceClient,
  cwids: readonly string[],
): Promise<Map<string, ProminenceEntry>> {
  const out = new Map<string, ProminenceEntry>();
  const unique = [...new Set(cwids)];
  if (unique.length === 0) return out;

  const [scholars, chairRows, chiefRows, piRows, nihPiRows, centerDirectors] = await Promise.all([
    client.scholar.findMany({
      where: { cwid: { in: unique } },
      select: {
        cwid: true,
        hIndex: true,
        scoredPubCount: true,
        roleCategory: true,
        primaryTitle: true,
      },
    }),
    // #2542 contract A — chair/director/chief come from `OrgUnitRoleAssignment`
    // only; `roleKey` itself carries the Chair-vs-Director split (#58).
    client.orgUnitRoleAssignment.findMany({
      where: {
        entityType: "department",
        roleKey: { in: [DEPARTMENT_CHAIR_ROLE_KEY, DEPARTMENT_DIRECTOR_ROLE_KEY] },
        cwid: { in: unique },
      },
      select: { cwid: true, roleKey: true },
    }),
    client.orgUnitRoleAssignment.findMany({
      where: { entityType: "division", roleKey: DIVISION_CHIEF_ROLE_KEY, cwid: { in: unique } },
      select: { cwid: true },
    }),
    client.grant.groupBy({
      by: ["cwid"],
      // PI prominence weights WCM-administered grants only; exclude RePORTER
      // backfill so a recruit's prior-institution history doesn't inflate it.
      where: { cwid: { in: unique }, role: { in: [...PI_ROLES] }, source: { not: "RePORTER" } },
      _count: { _all: true },
    }),
    client.grant.groupBy({
      by: ["cwid"],
      where: {
        cwid: { in: unique },
        role: { in: [...PI_ROLES] },
        nihIc: { not: null },
        source: { not: "RePORTER" },
      },
      _count: { _all: true },
    }),
    loadCenterDirectors(client, unique),
  ]);

  const chairLabelByCwid = new Map<string, string>();
  for (const r of chairRows) {
    chairLabelByCwid.set(r.cwid, r.roleKey === DEPARTMENT_DIRECTOR_ROLE_KEY ? "Director" : "Chair");
  }
  const chiefs = new Set(chiefRows.map((r) => r.cwid));
  const piCount = new Map(piRows.map((r) => [r.cwid, r._count._all]));
  const nihPiCount = new Map(nihPiRows.map((r) => [r.cwid, r._count._all]));

  for (const s of scholars) {
    out.set(
      s.cwid,
      scoreProminence({
        scoredPubCount: s.scoredPubCount,
        hIndex: s.hIndex,
        roleCategory: s.roleCategory ?? null,
        primaryTitle: s.primaryTitle ?? null,
        chairLabel: chairLabelByCwid.get(s.cwid) ?? null,
        isChief: chiefs.has(s.cwid),
        isCenterDirector: centerDirectors.has(s.cwid),
        piCount: piCount.get(s.cwid) ?? 0,
        nihPiCount: nihPiCount.get(s.cwid) ?? 0,
      }),
    );
  }
  return out;
}
