/**
 * Scholar display-title resolution.
 *
 * `Scholar.primaryTitle` is the RESOLVED title — what every render surface
 * already reads (search hits, `/og` cards, person popovers, people result
 * cards, the profile sidebar, `/edit`). The raw inputs it is resolved FROM
 * live beside it as `Scholar.edPrimaryTitle` and `Scholar.workingTitle`, so
 * the `/edit` picker can offer the losing tiers without re-reading LDAP.
 *
 * Precedence is BY RANK, not by source (EA pecking order, 2026-09-24 — see
 * {@link TITLE_RANK}). An operator override wins outright; otherwise every
 * candidate below is ranked and the highest-ranked one wins, ties going to
 * the earlier source in {@link TITLE_TIERS}:
 *
 *   working       ED `weillCornellEduWorkingTitle`
 *   primary       ED `weillCornellEduPrimaryTitle` (the official wording wins
 *                 a tie with a sibling appointment's)
 *   appointment   best-ranked current ED appointment title (chair, endowed…)
 *   centerHead    center Director (`OrgUnitRoleAssignment(center, director)`)
 *   chief         division chief (`OrgUnitRoleAssignment(division, …)`)
 *
 * DEPENDENCY-FREE ON PURPOSE, for the same reason `lib/org-unit-roles.ts` is:
 * `components/edit/edit-page.tsx` imports this at runtime, so it reaches the
 * CLIENT bundle. Nothing in this file's import graph may touch `@/lib/db` or
 * construct `prisma` at module scope, or the mariadb driver gets dragged into
 * the browser and the Next build dies on unresolvable `fs`/`net`. Keeping the
 * file literally import-free is the cheapest way to guarantee that — callers
 * pass data in, this module only computes strings.
 */

/**
 * The External Affairs title pecking order (from Institutional Communications,
 * 2026-09-24; Paul added Vice President to rank 2). LOWER ranks HIGHER. One
 * ladder drives both the display-title pick here and the leadership sort in
 * `lib/api/prominence.ts`, so the two cannot disagree.
 */
export const TITLE_RANK = {
  deanProvost: 1,
  viceProvostDean: 2,
  seniorAssociateDean: 3,
  chair: 4,
  institutionalCenterDirector: 5,
  divisionChief: 6,
  associateDean: 7,
  associateViceProvost: 8,
  /** Not on the original list; EA slotted it "between 8 and 9" (2026-09-24).
   *  Fractional so ranks 1–12 keep the list's own numbering. */
  viceChair: 8.5,
  endowed: 9,
  unitCenterDirector: 10,
  unitProgramDirector: 11,
  academic: 12,
  /** Anything the ladder does not name ("Attending Physician", "Lecturer"). */
  unranked: 13,
} as const;

/** The rubric's wording per rank — what `/edit/reports/display-titles` and
 *  `docs/title-hierarchy.md` show (a test pins the doc to this and
 *  {@link TITLE_RANK}). */
export const TITLE_RANK_LABEL: Record<keyof typeof TITLE_RANK, string> = {
  deanProvost: "Dean / Provost / President",
  viceProvostDean: "Vice Provost / Vice Dean / Vice President",
  seniorAssociateDean: "Senior Associate Dean",
  chair: "Department Chair",
  institutionalCenterDirector: "Institutional Center / Institute Director",
  divisionChief: "Division Chief",
  associateDean: "Associate / Assistant Dean",
  associateViceProvost: "Associate / Assistant Vice Provost",
  viceChair: "Vice Chair",
  endowed: "Endowed / named professorship",
  unitCenterDirector: "Unit-based Center / Institute Director",
  unitProgramDirector: "Unit-based Program Director",
  academic: "Academic rank (Professor, Instructor …)",
  unranked: "Anything else",
};

const EMERITUS = /\bemerit(?:us|a|i)\b/i;
/** Words that qualify an academic rank without making it a named (endowed) one. */
const RANK_WORDS = new Set([
  "the",
  "and",
  "associate",
  "assistant",
  "adjunct",
  "clinical",
  "visiting",
  "research",
  "full",
  "courtesy",
  "affiliate",
  "interim",
  "acting",
  "senior",
]);

/**
 * Rank a title STRING on the ladder. Role-derived ranks the text cannot
 * express (institutional vs unit-based center director) are the caller's.
 *
 * Most specific first: "Associate Vice Provost" must not read as Vice Provost,
 * "Senior Associate Dean" not as Associate Dean, "Vice Dean" not as Dean.
 * Emeritus titles hold no office, so they rank as academic at best.
 */
export function rankTitleText(
  title: string | null | undefined,
  /** The department the title is held in, when known. A center/institute
   *  director title that NAMES its own department heads that department, which
   *  ranks as Chair: BMRI is a department in all but name (EA, 2026-09-25). */
  ownDepartment?: string | null,
): number {
  const t = blankToNull(title ?? null);
  if (t === null) return TITLE_RANK.unranked;
  if (!EMERITUS.test(t)) {
    if (/\b(?:associate|assistant) vice (?:provost|president)\b/i.test(t)) {
      return TITLE_RANK.associateViceProvost;
    }
    if (/\bsenior associate dean\b/i.test(t)) return TITLE_RANK.seniorAssociateDean;
    if (/\b(?:associate|assistant|affiliate) dean\b/i.test(t)) return TITLE_RANK.associateDean;
    if (/\b(?:vice|deputy) (?:dean|provost)\b|\bvice president\b|\bevp\b/i.test(t)) {
      return TITLE_RANK.viceProvostDean;
    }
    if (/\b(?:dean|provost|president)\b/i.test(t)) return TITLE_RANK.deanProvost;
    // Department chair ("Chair of Medicine", "Sanford I. Weill Chair of
    // Medicine", "Chairman, …"); a named chair IN a field is endowed, below.
    if (
      /\bchair(?:man|woman|person)?\b(?! in\b)/i.test(t) &&
      !/\b(?:vice|associate|deputy|assistant)[- ]chair/i.test(t)
    ) {
      return TITLE_RANK.chair;
    }
    if (/\bchief of\b|\bdivision chief\b|^(?:interim |acting )?chief,/i.test(t)) {
      return TITLE_RANK.divisionChief;
    }
    if (/\bvice[- ]chair(?:man|woman|person)?\b/i.test(t)) return TITLE_RANK.viceChair;
  }
  if (isEndowed(t)) return TITLE_RANK.endowed;
  if (!EMERITUS.test(t) && isDirectorOf(t, /\b(?:center|centre|institute)\b/i)) {
    return ownDepartment && sharesUnitName(t, ownDepartment)
      ? TITLE_RANK.chair
      : TITLE_RANK.unitCenterDirector;
  }
  if (!EMERITUS.test(t) && isDirectorOf(t, /\bprogram\b/i)) return TITLE_RANK.unitProgramDirector;
  if (/\b(?:professor|instructor|postdoctoral associate)\b/i.test(t)) return TITLE_RANK.academic;
  return TITLE_RANK.unranked;
}

/** "Gale and Ira Drukier Professor of …", "… Chair in …", "Endowed …". A
 *  professorship is named when a non-rank word precedes "Professor" —
 *  "Associate Professor of Clinical Medicine" is not. A lead naming an office
 *  or carrying of/for/in is another role joined on ("Director of X and
 *  Professor"), not a name; a comma alone is not ("Anne Belcher, M.D.
 *  Assistant Professor"). */
function isEndowed(t: string): boolean {
  if (/\bendowed\b|\bchair in\b/i.test(t)) return true;
  const m = /^(.*?)\bprofessor\b/i.exec(t);
  if (!m || /\b(?:of|for|in|director|chief|chair|dean|provost|president|head)\b/i.test(m[1])) {
    return false;
  }
  const lead = m[1].toLowerCase().match(/[a-z.'-]+/g) ?? [];
  return lead.some((w) => !RANK_WORDS.has(w));
}

/** Director (or Co-Director) of a unit matching `unit` — never an
 *  Associate/Assistant/Deputy Director, the #2735 demotion case. */
function isDirectorOf(t: string, unit: RegExp): boolean {
  if (/\b(?:associate|assistant|deputy) (?:co-)?director\b/i.test(t)) return false;
  return /\b(?:co-)?director\b/i.test(t) && unit.test(t);
}

/** The candidate sources. Order is the TIE-BREAK between equal ranks only. */
export type TitleTier = "working" | "primary" | "appointment" | "centerHead" | "chief";

export const TITLE_TIERS: readonly TitleTier[] = [
  "working",
  "primary",
  "appointment",
  "centerHead",
  "chief",
] as const;

/** Operator-facing label per tier — drives the `/edit` picker's option rows. */
export const TITLE_TIER_LABEL: Record<TitleTier, string> = {
  working: "Working title",
  appointment: "Appointment title",
  centerHead: "Center director",
  chief: "Division chief",
  primary: "Primary title",
};

/** One row in the `/edit` picker. `value` is null when the tier does not apply
 *  to this scholar. `rank` is its place on {@link TITLE_RANK}. */
export type TitleOption = {
  tier: TitleTier;
  label: string;
  value: string | null;
  rank: number;
};

/** The per-scholar inputs. Every string is already a finished display string;
 *  this module never reaches a database or formats a unit name itself. */
export type TitleInputs = {
  /** ED `weillCornellEduWorkingTitle`, annotation-stripped. */
  workingTitle: string | null;
  /** Current ED appointment titles; the best-ranked one is the candidate. */
  appointmentTitles?: readonly AppointmentTitle[];
  /** Pre-formatted, e.g. "Chief, Cardiology (Medicine)" — see {@link formatUnitLeadershipTitle}. */
  chiefTitle: string | null;
  /** Pre-formatted, e.g. "Director, Example Cancer Center". Every tracked
   *  center is school-wide, so this is always rank 5. */
  centerHeadTitle: string | null;
  /** ED `weillCornellEduPrimaryTitle`, annotation-stripped. */
  edPrimaryTitle: string | null;
};

/**
 * Build the picker's rows, highest rank first (ties in {@link TITLE_TIERS}
 * order). Every tier always produces a row; `value: null` marks one that does
 * not apply, and sorts last.
 */
export function buildTitleOptions(inputs: TitleInputs): TitleOption[] {
  const centerHead = blankToNull(inputs.centerHeadTitle);
  // A text title that words the SAME directorship the role confers ("Meyer
  // Cancer Center Director", an ED "Director, Drukier Institute") keeps the
  // person's own wording: it takes the role's rank, and the text tier wins the
  // tie. Text alone can only say "some center" (rank 10); the role knows it
  // is a tracked one (5).
  const sameDirectorship = (r: [string | null, number]): [string | null, number] =>
    centerHead !== null &&
    r[0] !== null &&
    r[1] === TITLE_RANK.unitCenterDirector &&
    sharesUnitName(r[0], centerHead)
      ? [r[0], TITLE_RANK.institutionalCenterDirector]
      : r;
  const byTier: Record<TitleTier, [string | null, number]> = {
    working: sameDirectorship(ranked(inputs.workingTitle)),
    appointment: sameDirectorship(bestRanked(inputs.appointmentTitles ?? [])),
    centerHead: [centerHead, TITLE_RANK.institutionalCenterDirector],
    chief: [blankToNull(inputs.chiefTitle), TITLE_RANK.divisionChief],
    primary: sameDirectorship(ranked(inputs.edPrimaryTitle)),
  };
  return TITLE_TIERS.map((tier) => ({
    tier,
    label: TITLE_TIER_LABEL[tier],
    value: byTier[tier][0],
    rank: byTier[tier][0] === null ? TITLE_RANK.unranked : byTier[tier][1],
  })).sort(
    (a, b) =>
      Number(a.value === null) - Number(b.value === null) ||
      a.rank - b.rank ||
      TITLE_TIERS.indexOf(a.tier) - TITLE_TIERS.indexOf(b.tier),
  );
}

/** Generic words that do not identify a unit. */
const UNIT_FILLER = new Set([
  "director",
  "center",
  "centre",
  "institute",
  "research",
  "interim",
  "acting",
  "the",
  "and",
  "for",
  "of",
  "disease",
  "health",
]);

/** Do two titles name the same unit? True when they share a distinctive word
 *  ("Meyer", "Drukier", "Appel") — enough to tell one center's director
 *  wording from another's without a curated alias list. */
function sharesUnitName(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !UNIT_FILLER.has(w)));
  const bw = words(b);
  return [...words(a)].some((w) => bw.has(w));
}

/** One current ED appointment: its title and, when the appointment's
 *  organization is a department, that department's name. */
export type AppointmentTitle = { title: string; department?: string | null };

function ranked(title: string | null, ownDepartment?: string | null): [string | null, number] {
  const v = blankToNull(title);
  return [v, rankTitleText(v, ownDepartment)];
}

/** Best-ranked title among `titles`, counting only those ABOVE a plain
 *  academic rank (endowed, chair, …). The ED primary title already carries the
 *  academic rank; letting an equal-rank appointment compete would swap
 *  "Professor of Medicine" for a sibling appointment's wording on a tie. */
function bestRanked(titles: readonly AppointmentTitle[]): [string | null, number] {
  let best: [string | null, number] = [null, TITLE_RANK.academic];
  for (const t of titles) {
    const r = ranked(t.title, t.department);
    if (r[0] !== null && r[1] < best[1]) best = r;
  }
  return best[0] === null ? [null, TITLE_RANK.unranked] : best;
}

export type ResolvedTitle = {
  /** What belongs in `Scholar.primaryTitle`. Null only when a scholar has no
   *  title at ANY tier — rare, and a null subtitle is correct there. */
  value: string | null;
  /** Which tier won, or null when an operator override won (or nothing did). */
  tier: TitleTier | null;
  /** True when `field_override(primaryTitle)` decided this. */
  overridden: boolean;
};

/**
 * Resolve the display title.
 *
 * `override` is the raw `field_override(scholar, <cwid>, 'primaryTitle')`
 * value. The EMPTY STRING is meaningful and means "no pin — fall through to
 * the derived default", which is how an operator undoes a pick without the
 * request path having to delete a row it may not own.
 *
 * Note this is the OPPOSITE of the `""` convention in
 * `etl/ed/unit-overrides.ts`, where an empty `leaderCwid` is an explicit
 * vacancy that must NOT re-engage auto-detection. The difference is
 * deliberate: a vacancy is a fact a curator asserts about a unit, whereas
 * there is no such thing as a scholar who asserts they have no title — the
 * floor tier always applies. Calling it out because the two conventions sit
 * two files apart and read identically.
 */
export function resolveScholarTitle(
  inputs: TitleInputs & { override: string | null },
): ResolvedTitle {
  return resolveFromOptions(buildTitleOptions(inputs), inputs.override);
}

/** {@link resolveScholarTitle} over already-built options (the `/edit` write
 *  path holds those, not the raw inputs). */
export function resolveFromOptions(
  options: readonly TitleOption[],
  override: string | null,
): ResolvedTitle {
  const pinned = blankToNull(override);
  if (pinned !== null) return { value: pinned, tier: null, overridden: true };
  const winner = options.find((o) => o.value !== null);
  return winner
    ? { value: winner.value, tier: winner.tier, overridden: false }
    : { value: null, tier: null, overridden: false };
}

/**
 * Format a unit leadership assignment as a title line.
 *
 * Mirrors what `lib/api/profile.ts` already emits for `leadershipTitles`
 * (#1266) — `` `${formatLeadershipTitle(label, interim)}, ${unitName}` `` —
 * with one addition: a `(Department)` qualifier when the unit's NAME is not
 * unique.
 *
 * Probed 2026-09-22 across all 42 divisions: exactly ONE name is shared —
 * "Cardiology", which exists under two different departments and so affects
 * 2 of 25 chiefs. The qualifier is therefore conditional, not unconditional:
 * appending the department to all 25 would add noise to 23 of them in order
 * to disambiguate 2.
 * `ambiguous` is computed per run from the unit table (a name held by 2+
 * codes), never hardcoded, so a future collision qualifies itself.
 *
 * `(Department)` matches the convention the profile sidebar already uses for
 * divisions ("<Division> (<Department>)", issue #167).
 */
export function formatUnitLeadershipTitle(opts: {
  /** Vocabulary label, e.g. "Chief" / "Director". */
  roleLabel: string;
  interim: boolean;
  unitName: string;
  /** Parent department name. Only read when `ambiguous`. */
  parentName?: string | null;
  /** True when another unit of the same kind shares `unitName`. */
  ambiguous?: boolean;
}): string {
  const role = opts.interim ? `Interim ${opts.roleLabel}` : opts.roleLabel;
  const parent = blankToNull(opts.parentName ?? null);
  const unit = opts.ambiguous && parent !== null ? `${opts.unitName} (${parent})` : opts.unitName;
  return `${role}, ${unit}`;
}

/**
 * Names held by more than one unit, lowercased. Feeds `ambiguous` above.
 * Takes the whole unit list so the caller does one pass, not one query per
 * chief.
 */
export function ambiguousUnitNames(
  units: readonly { name: string }[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const u of units) {
    const key = u.name.trim().toLowerCase();
    if (key.length === 0) continue;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return dupes;
}

/** Whitespace-only is absence, not a title. Keeps a stray ED space from
 *  winning a tier and rendering an empty subtitle. */
function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
