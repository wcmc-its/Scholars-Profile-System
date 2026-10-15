/**
 * A research area's grants and clinical trials as feed items
 * (TOPIC_FEED_GRANTS_TRIALS; `/api/topics/[slug]/activity`). The "Activities"
 * control next to the publication feed reads this; publications stay on
 * `getTopicPublications`.
 *
 * Membership comes from the area scores ReciterAI produced for each grant or
 * trial TEXT (`area_signal_topic`, keyed by `grant.area_text_key` /
 * `clinical_trial.area_text_key`). The display cut is the papers' rule: an
 * item's area score against the area's `displayThreshold` (default 0.5), with
 * the same `tier` semantics as the publication route ("strongly" >= threshold,
 * "also" below it but at or over the 0.3 floor, omitted = both).
 *
 * What never appears, in the order it is applied:
 *   - rows failing the shared eligibility (lib/area-signals.ts: InfoEd PI /
 *     PI-Subaward / Co-PI grants since 2020, NCT-registered PI trials since
 *     2020, hidden trial statuses);
 *   - every grant in the six areas grants never count in (trials still do);
 *   - rows of scholars who are not active, or are soft-deleted;
 *   - suppressed grants (#160, by externalId);
 *   - the grants of a scholar who hid Funding (`hideFunding`) and the trials of
 *     one who hid Clinical Trials (`hideClinicalTrials`). A hider is also left
 *     off a colleague's item's people chips.
 * Ended grants and completed trials DO appear (Paul, 2026-10-14).
 *
 * Grouping: grants into funding projects with `groupGrantsByProject`, the key
 * the Funding search tab uses, so a multi-PI award or a renewal is ONE item;
 * trials by NCT number. An item's area score is its best text's score.
 *
 * Subarea (`subtopic`, plan S7): the publication feed's rule, primary subarea
 * only. A text is in a subarea view when its `area_signal_topic` row for THIS
 * area carries that `primarySubtopicId`. A text with no assignment (not yet
 * assigned, or "none fits") is absent from every subarea view and still shown
 * at the area level; it is never shown everywhere. The counts and tierTotals
 * are scoped to the subarea like the rows.
 *
 * Volumes are small (an area holds tens to low hundreds of items), so the whole
 * qualifying set is loaded, sorted and counted in memory and only the page is
 * hydrated (people chips, abstract, linked pubs).
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";
import {
  AREA_GRANT_ROLES,
  AREA_GRANT_SOURCE,
  AREA_SIGNAL_GRANT_EXCLUDED_TOPICS,
  AREA_SIGNAL_START_DATE,
  AREA_TRIAL_PI_ROLE,
  isEligibleAreaGrant,
  isEligibleAreaTrial,
} from "@/lib/area-signals";
import { coreProjectNum } from "@/lib/award-number";
import {
  GRANT_INDEX_SELECT,
  GRANT_INDEX_WHERE,
  groupGrantsByProject,
  projectFromRows,
} from "@/lib/funding-projection";
import { headshotUrl } from "@/lib/headshot";
import { loadEntitySuppressions } from "@/lib/api/manual-layer";
import { projectSiblingArms } from "@/lib/api/project-siblings";
import { isPublicScholarCwid } from "@/lib/api/scholar-filter";
import { isFundingActive, statusForGrant, type FundingHit } from "@/lib/api/search-funding";
import type { TrialHit } from "@/lib/api/search-trials";
import {
  TOPIC_PUBLICATIONS_DEFAULT_DISPLAY_THRESHOLD,
  type TopicPublicationTier,
} from "@/lib/api/topics";
import { phaseKey, sponsorTypeKey } from "@/lib/edit/clinical-trials-report";
import { PEOPLE_INDEX_WHERE } from "@/lib/search-index-docs";
import {
  splitTrialList,
  trialDates,
  trialStatusFields,
  trialStatusKey,
} from "@/lib/search-trial-evidence";

export type TopicActivityKind = "grant" | "trial";
/** `newest` = latest start first; `best_match` = highest area score first;
 *  `status` = open items first (recruiting, then active, for trials), newest
 *  within; `ending` = open items by soonest end, then closed ones by latest end. */
export type TopicActivitySort = "newest" | "best_match" | "status" | "ending";

/** Upstream score floor: ReciterAI writes every area score >= 0.3, the same
 *  floor `publication_topic` carries. Re-applied here so "also" means
 *  [0.3, threshold) even if a lower score ever lands. */
export const TOPIC_ACTIVITY_SCORE_FLOOR = 0.3;
const TOPIC_ACTIVITY_PAGE_SIZE = 20;

export type TopicGrantActivityHit = FundingHit & { areaScore: number };
export type TopicTrialActivityHit = TrialHit & { areaScore: number };

type TierCounts = { strongly: number; also: number };

export type TopicActivityResult = {
  kind: TopicActivityKind;
  hits: TopicGrantActivityHit[] | TopicTrialActivityHit[];
  /** Items of `kind` in scope under the requested tier. */
  total: number;
  /** Per-kind, per-tier counts in scope (area + scholar filter), ignoring the
   *  requested tier and kind, so a control can label both kinds and both
   *  tiers from one response. */
  counts: { grant: TierCounts; trial: TierCounts };
  /** `counts[kind]`, named like the publication route's field. */
  tierTotals: TierCounts;
  /** The display threshold the tiers were cut at. */
  displayThreshold: number;
  /** True when the request named a subtopic and the rows and counts are
   *  narrowed to it. */
  subtopicApplied: boolean;
  page: number;
  pageSize: number;
};

/** One qualifying feed item before hydration. `end` is "" when unknown;
 *  `rank` orders the `status` sort (0 first); `open` = not ended. */
type Candidate<R> = {
  key: string;
  score: number;
  start: string;
  end: string;
  rank: number;
  open: boolean;
  rows: R[];
};

function emptyResult(
  kind: TopicActivityKind,
  page: number,
  pageSize: number,
  displayThreshold: number,
  subtopicApplied: boolean,
): TopicActivityResult {
  const zero = { strongly: 0, also: 0 };
  return {
    kind,
    hits: [],
    total: 0,
    counts: { grant: zero, trial: zero },
    tierTotals: zero,
    displayThreshold,
    subtopicApplied,
    page,
    pageSize,
  };
}

const GRANT_ROW_SELECT = {
  id: true,
  cwid: true,
  externalId: true,
  source: true,
  role: true,
  title: true,
  awardNumber: true,
  mechanism: true,
  programType: true,
  startDate: true,
  endDate: true,
  areaTextKey: true,
} as const;

const TRIAL_SELECT = {
  protocolNumber: true,
  nctNumber: true,
  title: true,
  status: true,
  phase: true,
  studyType: true,
  sponsorClass: true,
  principalSponsor: true,
  conditions: true,
  ctgovStatus: true,
  startDate: true,
  startDateType: true,
  primaryCompletionDate: true,
  primaryCompletionDateType: true,
  hasResults: true,
  interventions: true,
  firstOtaDate: true,
  areaTextKey: true,
} as const;

/** Cwids (of those given) who set `field` to hide that profile section. */
async function loadHiders(cwids: readonly string[], field: string): Promise<Set<string>> {
  if (cwids.length === 0) return new Set();
  const rows = await prisma.fieldOverride.findMany({
    where: { entityType: "scholar", entityId: { in: [...new Set(cwids)] }, fieldName: field, value: "true" },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId));
}

const byNewest = <R>(a: Candidate<R>, b: Candidate<R>) =>
  b.start.localeCompare(a.start) || b.score - a.score || a.key.localeCompare(b.key);
const byBestMatch = <R>(a: Candidate<R>, b: Candidate<R>) =>
  b.score - a.score || b.start.localeCompare(a.start) || a.key.localeCompare(b.key);
const byStatus = <R>(a: Candidate<R>, b: Candidate<R>) => a.rank - b.rank || byNewest(a, b);
// An open item with no end date sorts after the dated ones.
const byEnding = <R>(a: Candidate<R>, b: Candidate<R>) =>
  Number(b.open) - Number(a.open) ||
  (a.open
    ? (a.end || "9999").localeCompare(b.end || "9999")
    : b.end.localeCompare(a.end)) ||
  byNewest(a, b);
const ORDER = { newest: byNewest, best_match: byBestMatch, status: byStatus, ending: byEnding };

type Scope = {
  grants: Array<Candidate<GrantRow>>;
  trials: Array<Candidate<TrialRow>>;
};

/** Every qualifying grant and trial of the area (or subarea), unpaged. */
async function loadScope(
  topicSlug: string,
  subtopic: string | undefined,
  now: Date,
): Promise<Scope> {
  const scoreRows = await prisma.areaSignalTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      score: { gte: TOPIC_ACTIVITY_SCORE_FLOOR },
      // Equality on a non-null slug: an unassigned (NULL) row never matches.
      ...(subtopic ? { primarySubtopicId: subtopic } : {}),
    },
    select: { textKey: true, score: true },
  });
  const areaScore = new Map(scoreRows.map((r) => [r.textKey, Number(r.score)]));
  const keys = [...areaScore.keys()];
  const [grants, trials] = await Promise.all([
    loadGrantCandidates(topicSlug, keys, areaScore, now),
    loadTrialCandidates(keys, areaScore),
  ]);
  return { grants, trials };
}

export async function getTopicActivity(
  topicSlug: string,
  opts: {
    kind: TopicActivityKind;
    sort?: TopicActivitySort;
    tier?: TopicPublicationTier;
    /** A subarea slug of this area: only items whose primary subarea it is. */
    subtopic?: string;
    /** Only items this scholar is a qualifying investigator on (a PI-role
     *  grant row or a PI trial row in the area). The route validates the
     *  shape; an unknown, inactive or #536-hidden cwid gets an empty result. */
    cwid?: string;
    /** 0-indexed, in units of `pageSize`. */
    page?: number;
    /** Rows per page; the route validates whole 20-row chunks up to 200. */
    pageSize?: number;
  },
  now: Date = new Date(),
): Promise<TopicActivityResult | null> {
  const topic = await prisma.topic.findUnique({
    where: { id: topicSlug },
    select: { id: true, displayThreshold: true },
  });
  if (!topic) return null;

  const page = Math.max(0, opts.page ?? 0);
  const pageSize = opts.pageSize ?? TOPIC_ACTIVITY_PAGE_SIZE;
  const displayThreshold = topic.displayThreshold ?? TOPIC_PUBLICATIONS_DEFAULT_DISPLAY_THRESHOLD;
  const cwid = opts.cwid && opts.cwid.length > 0 ? opts.cwid : undefined;
  const subtopic = opts.subtopic && opts.subtopic.length > 0 ? opts.subtopic : undefined;
  if (cwid && !(await isPublicScholarCwid(cwid))) {
    return emptyResult(opts.kind, page, pageSize, displayThreshold, subtopic !== undefined);
  }

  const { grants, trials } = await loadScope(topicSlug, subtopic, now);

  // The scholar filter is part of the scope, like the area and subarea: it narrows every
  // count, not just the visible rows.
  const inScope = <R extends { cwid: string }>(c: Candidate<R>) =>
    !cwid || c.rows.some((r) => r.cwid === cwid);
  const scopedGrants = grants.filter(inScope);
  const scopedTrials = trials.filter(inScope);

  const isStrongly = (c: { score: number }) => c.score >= displayThreshold;
  const tierCounts = (cs: Array<{ score: number }>): TierCounts => {
    const strongly = cs.filter(isStrongly).length;
    return { strongly, also: cs.length - strongly };
  };
  const counts = { grant: tierCounts(scopedGrants), trial: tierCounts(scopedTrials) };
  const inTier = (c: { score: number }) =>
    opts.tier === "strongly" ? isStrongly(c) : opts.tier === "also" ? !isStrongly(c) : true;
  const order = ORDER[opts.sort ?? "newest"];

  const base = {
    kind: opts.kind,
    counts,
    tierTotals: counts[opts.kind],
    displayThreshold,
    subtopicApplied: subtopic !== undefined,
    page,
    pageSize,
  };
  const start = page * pageSize;
  if (opts.kind === "grant") {
    const visible = scopedGrants.filter(inTier).sort(order);
    const hits = await hydrateGrants(visible.slice(start, start + pageSize), now);
    return { ...base, hits, total: visible.length };
  }
  const visible = scopedTrials.filter(inTier).sort(order);
  return { ...base, hits: visible.slice(start, start + pageSize).map(trialHit), total: visible.length };
}

type GrantRow = {
  id: string;
  cwid: string;
  externalId: string | null;
  source: string;
  role: string;
  title: string;
  awardNumber: string | null;
  mechanism: string | null;
  programType: string;
  startDate: Date;
  endDate: Date;
  areaTextKey: string | null;
};

/** Qualifying grant rows grouped into funding projects. */
async function loadGrantCandidates(
  topicSlug: string,
  keys: string[],
  areaScore: Map<string, number>,
  now: Date,
): Promise<Array<Candidate<GrantRow>>> {
  if (keys.length === 0 || AREA_SIGNAL_GRANT_EXCLUDED_TOPICS.has(topicSlug)) return [];
  const rows = (await prisma.grant.findMany({
    where: {
      ...GRANT_INDEX_WHERE,
      areaTextKey: { in: keys },
      source: AREA_GRANT_SOURCE,
      role: { in: [...AREA_GRANT_ROLES] },
      startDate: { gte: new Date(`${AREA_SIGNAL_START_DATE}T00:00:00Z`) },
    },
    select: GRANT_ROW_SELECT,
  })) as GrantRow[];
  const eligible = rows.filter((g) => areaScore.has(g.areaTextKey as string) && isEligibleAreaGrant(g));
  const hiders = await loadHiders(
    eligible.map((g) => g.cwid),
    "hideFunding",
  );
  const shown = eligible.filter((g) => !hiders.has(g.cwid));
  const suppressed = await loadEntitySuppressions(
    "grant",
    shown.flatMap((g) => (g.externalId ? [g.externalId] : [])),
    prisma,
  );
  const out: Array<Candidate<GrantRow>> = [];
  for (const [key, project] of groupGrantsByProject(shown, suppressed)) {
    const score = Math.max(...project.map((g) => areaScore.get(g.areaTextKey as string) ?? 0));
    // The earliest qualifying row's start, as the ranking dates a project. The
    // displayed range also spans the hydrated sibling rows, so it can start
    // earlier on a renewal of a pre-2020 award.
    const startMs = Math.min(...project.map((g) => g.startDate.getTime()));
    const end = new Date(Math.max(...project.map((g) => g.endDate.getTime())));
    const open = isFundingActive(end, now);
    out.push({
      key,
      score,
      start: new Date(startMs).toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      rank: open ? 0 : 1,
      open,
      rows: project,
    });
  }
  return out;
}

/**
 * FundingHits for one page of projects: every InfoEd row of each project (the
 * people chips), built with `projectFromRows` exactly as the funding index
 * builds a document. Siblings get the same visibility rules as the qualifying
 * rows: active scholars, not suppressed, not hidden by their owner.
 */
async function hydrateGrants(
  page: Array<Candidate<GrantRow>>,
  now: Date,
): Promise<TopicGrantActivityHit[]> {
  if (page.length === 0) return [];
  const qualifying = page.flatMap((c) => c.rows);
  const arms = projectSiblingArms(qualifying);
  const rows = await prisma.grant.findMany({
    where: {
      AND: [
        GRANT_INDEX_WHERE,
        { source: AREA_GRANT_SOURCE },
        { OR: [{ id: { in: qualifying.map((g) => g.id) } }, ...arms] },
      ],
    },
    select: {
      ...GRANT_INDEX_SELECT,
      id: true,
      scholar: {
        select: { ...GRANT_INDEX_SELECT.scholar.select, roleCategory: true, hasHeadshot: true },
      },
    },
    orderBy: [{ externalId: "asc" }, { id: "asc" }],
  });
  // `projectFromRows` takes a project's canonical fields (title, sponsor) from
  // its head row, so the order must be stable: the qualifying rows first (the
  // ones that put the project in the area), then by externalId.
  const qualifyingIds = new Set(qualifying.map((g) => g.id));
  rows.sort((a, b) => Number(qualifyingIds.has(b.id)) - Number(qualifyingIds.has(a.id)));
  const [hiders, suppressed] = await Promise.all([
    loadHiders(
      rows.map((r) => r.cwid),
      "hideFunding",
    ),
    loadEntitySuppressions(
      "grant",
      rows.flatMap((r) => (r.externalId ? [r.externalId] : [])),
      prisma,
    ),
  ]);
  const projects = groupGrantsByProject(
    rows.filter((r) => !hiders.has(r.cwid)),
    suppressed,
  );
  const meta = new Map(rows.map((r) => [r.cwid, r.scholar]));

  const hits: TopicGrantActivityHit[] = [];
  for (const c of page) {
    const doc = projectFromRows(projects.get(c.key) ?? [], now);
    if (!doc) continue;
    const endDate = new Date(doc.endDate);
    hits.push({
      // The grouping key, as the funding index sets it (etl/search-index), so
      // the id is stable and matches the Funding search tab's.
      projectId: c.key,
      title: doc.title,
      primeSponsor: doc.primeSponsor,
      primeSponsorRaw: doc.primeSponsorRaw,
      directSponsor: doc.directSponsor,
      isSubaward: doc.isSubaward,
      programType: doc.programType,
      mechanism: doc.mechanism,
      nihIc: doc.nihIc,
      awardNumber: doc.awardNumber,
      startDate: doc.startDate.slice(0, 10),
      endDate: doc.endDate.slice(0, 10),
      isActive: isFundingActive(endDate, now),
      status: statusForGrant(endDate, now),
      isMultiPi: doc.isMultiPi,
      people: doc.people.map((p) => ({
        ...p,
        identityImageEndpoint: headshotUrl(p.cwid, meta.get(p.cwid)?.hasHeadshot),
        roleCategory: meta.get(p.cwid)?.roleCategory ?? null,
      })),
      totalPeople: doc.totalPeople,
      department: doc.department,
      pubCount: doc.pubCount,
      abstract: doc.abstract,
      abstractSource: doc.abstractSource,
      applId: doc.applId,
      publications: doc.publications,
      coreProjectNum: coreProjectNum(doc.awardNumber),
      // Search-only "why it matched" fields: a feed item matched on its area.
      titleHighlight: null,
      matchedLiteralTitle: false,
      matchedConcept: false,
      matchedFundedPubs: 0,
      textEvidence: null,
      areaScore: c.score,
    });
  }
  return hits;
}

type TrialRow = {
  cwid: string;
  scholar: { preferredName: string; slug: string };
  trial: {
    protocolNumber: string;
    nctNumber: string | null;
    title: string;
    status: string | null;
    phase: string | null;
    studyType: string | null;
    sponsorClass: string | null;
    principalSponsor: string | null;
    conditions: string | null;
    ctgovStatus: string | null;
    startDate: string | null;
    startDateType: string | null;
    primaryCompletionDate: string | null;
    primaryCompletionDateType: string | null;
    hasResults: boolean | null;
    interventions: string | null;
    firstOtaDate: Date | null;
    areaTextKey: string | null;
  };
};

/** Qualifying PI trial rows grouped by NCT number. */
async function loadTrialCandidates(
  keys: string[],
  areaScore: Map<string, number>,
): Promise<Array<Candidate<TrialRow>>> {
  if (keys.length === 0) return [];
  const rows = (await prisma.personClinicalTrial.findMany({
    where: {
      role: AREA_TRIAL_PI_ROLE,
      scholar: PEOPLE_INDEX_WHERE,
      trial: { areaTextKey: { in: keys } },
    },
    select: {
      cwid: true,
      scholar: { select: { preferredName: true, slug: true } },
      trial: { select: TRIAL_SELECT },
    },
    orderBy: [{ protocolNumber: "asc" }, { cwid: "asc" }],
  })) as TrialRow[];
  const eligible = rows.filter(
    (r) => areaScore.has(r.trial.areaTextKey as string) && isEligibleAreaTrial(r.trial),
  );
  const hiders = await loadHiders(
    eligible.map((r) => r.cwid),
    "hideClinicalTrials",
  );
  const byNct = new Map<string, TrialRow[]>();
  for (const r of eligible) {
    if (hiders.has(r.cwid)) continue;
    const nct = r.trial.nctNumber as string; // eligibility requires one
    byNct.set(nct, [...(byNct.get(nct) ?? []), r]);
  }
  return [...byNct].map(([key, group]) => {
    const t = group[0].trial;
    const { statusRank } = trialStatusFields(trialStatusKey(t.ctgovStatus, t.status));
    return {
      key,
      score: Math.max(...group.map((r) => areaScore.get(r.trial.areaTextKey as string) ?? 0)),
      start: trialDates(t).startDate ?? "",
      end: trialDates(t).endDate ?? "",
      rank: statusRank,
      open: statusRank < 2,
      rows: group,
    };
  });
}

/** The search tab's row shape; the first protocol (by number) stands for the NCT. */
function trialHit(c: Candidate<TrialRow>): TopicTrialActivityHit {
  const t = c.rows[0].trial;
  const pis: TrialHit["pis"] = [];
  for (const r of c.rows) {
    if (pis.some((p) => p.cwid === r.cwid)) continue;
    pis.push({ cwid: r.cwid, name: r.scholar.preferredName, slug: r.scholar.slug });
  }
  const dates = trialDates(t);
  const status = trialStatusFields(trialStatusKey(t.ctgovStatus, t.status));
  return {
    trialId: c.key,
    nctNumber: t.nctNumber,
    title: t.title,
    status: t.status,
    statusBucket: status.statusBucket,
    statusKey: status.statusKey,
    phase: phaseKey(t.phase),
    studyType: t.studyType,
    sponsorClass: sponsorTypeKey(t.sponsorClass),
    principalSponsor: t.principalSponsor,
    pis,
    conditions: splitTrialList(t.conditions).join("; "),
    startDate: dates.startDate,
    startEstimated: dates.startEstimated,
    endDate: dates.endDate,
    endEstimated: dates.endEstimated,
    interventions: t.interventions,
    hasResults: t.hasResults === true,
    matchedConcept: false,
    matchedFields: [],
    areaScore: c.score,
  };
}

type ScholarTiers = { pubs: TierCounts; grant: TierCounts; trial: TierCounts };

export type TopicActivityScholar = ScholarTiers & {
  cwid: string;
  name: string;
  slug: string;
  /** "" when the scholar has no headshot. */
  headshot: string;
};

export type TopicActivityScholarsResult = {
  /** Area (or subarea) totals per kind. Publications count DISTINCT papers
   *  (research types only, the feed's default); a paper is "strongly" when any
   *  of its author rows clears the threshold. */
  totals: ScholarTiers;
  /** Every public scholar with at least one item in scope, unsorted. */
  scholars: TopicActivityScholar[];
  displayThreshold: number;
};

/**
 * The Activities Scholars chips (`?kind=scholars`): each scholar's count of
 * papers, grants and trials in the area or subarea, per tier, plus the area
 * totals for the type tabs. Same scope rules as the feeds; a paper the scholar
 * hid from their own profile is not counted for them.
 */
export async function getTopicActivityScholars(
  topicSlug: string,
  opts: { subtopic?: string },
  now: Date = new Date(),
): Promise<TopicActivityScholarsResult | null> {
  const topic = await prisma.topic.findUnique({
    where: { id: topicSlug },
    select: { id: true, displayThreshold: true },
  });
  if (!topic) return null;
  const displayThreshold = topic.displayThreshold ?? TOPIC_PUBLICATIONS_DEFAULT_DISPLAY_THRESHOLD;
  const subtopic = opts.subtopic && opts.subtopic.length > 0 ? opts.subtopic : undefined;

  const where = Prisma.sql`pt.parent_topic_id = ${topicSlug}
    ${subtopic ? Prisma.sql`AND pt.primary_subtopic_id = ${subtopic}` : Prisma.empty}
    AND pt.pmid IN (SELECT p.pmid FROM publication p WHERE p.publication_type NOT IN (${Prisma.join([...FEED_EXCLUDED_TYPES])}))`;
  const [scope, pubTotals, pubRows] = await Promise.all([
    loadScope(topicSlug, subtopic, now),
    prisma.$queryRaw<Array<{ s: bigint; a: bigint }>>`
      SELECT COUNT(DISTINCT CASE WHEN pt.score >= ${displayThreshold} THEN pt.pmid END) AS s,
             COUNT(DISTINCT pt.pmid) AS a
      FROM publication_topic pt WHERE ${where}`,
    prisma.$queryRaw<Array<{ cwid: string; s: bigint; a: bigint }>>`
      SELECT pt.cwid,
             SUM(pt.score >= ${displayThreshold}) AS s,
             COUNT(*) AS a
      FROM publication_topic pt
      WHERE ${where}
        AND NOT EXISTS (
          SELECT 1 FROM suppression x
          WHERE x.entity_type = 'publication' AND x.entity_id = pt.pmid
            AND x.contributor_cwid = pt.cwid AND x.revoked_at IS NULL)
      GROUP BY pt.cwid`,
  ]);

  const tiers = (s: number, a: number): TierCounts => ({ strongly: s, also: a - s });
  const zero = (): ScholarTiers => ({
    pubs: { strongly: 0, also: 0 },
    grant: { strongly: 0, also: 0 },
    trial: { strongly: 0, also: 0 },
  });
  const by = new Map<string, ScholarTiers>();
  const at = (cwid: string) => by.get(cwid) ?? by.set(cwid, zero()).get(cwid)!;
  // publication_topic is keyed (pmid, cwid, parent_topic_id): one row per paper per scholar.
  for (const r of pubRows) at(r.cwid).pubs = tiers(Number(r.s), Number(r.a));
  const tally = <R extends { cwid: string }>(cs: Array<Candidate<R>>, kind: "grant" | "trial") => {
    const out = { strongly: 0, also: 0 };
    for (const c of cs) {
      const tier = c.score >= displayThreshold ? "strongly" : "also";
      out[tier]++;
      for (const cwid of new Set(c.rows.map((r) => r.cwid))) at(cwid)[kind][tier]++;
    }
    return out;
  };
  const totals: ScholarTiers = {
    pubs: tiers(Number(pubTotals[0]?.s ?? 0), Number(pubTotals[0]?.a ?? 0)),
    grant: tally(scope.grants, "grant"),
    trial: tally(scope.trials, "trial"),
  };

  const people = await prisma.scholar.findMany({
    where: { cwid: { in: [...by.keys()] }, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, preferredName: true, slug: true, roleCategory: true, hasHeadshot: true },
  });
  const scholars = people
    .filter((p) => isPubliclyDisplayed(p.roleCategory))
    .map((p) => ({
      cwid: p.cwid,
      name: p.preferredName,
      slug: p.slug,
      headshot: headshotUrl(p.cwid, p.hasHeadshot),
      ...by.get(p.cwid)!,
    }));
  return { totals, scholars, displayThreshold };
}
