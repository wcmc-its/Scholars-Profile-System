/**
 * Grant and trial points for one research area, for the scholars who already
 * rank there on their papers (TOPIC_RANK_AREA_SIGNALS; lib/api/topics.ts
 * `getTopScholarsForTopic` is the only caller).
 *
 * Joins each scholar's eligible rows to the area scores ReciterAI produced for
 * their TEXT (`grant.area_text_key` / `clinical_trial.area_text_key` ->
 * `area_signal_topic`, filled by etl/area-signal-inputs + etl/dynamodb), then
 * scores them with lib/ranking.ts. What does not count, in order:
 *   - rows failing the shared eligibility (lib/area-signals.ts);
 *   - every grant in the six areas grants never count in;
 *   - suppressed grants (#160, by externalId);
 *   - all grants of a scholar who hid Funding (`hideFunding`), all trials of one
 *     who hid Clinical Trials (`hideClinicalTrials`): a hidden section never
 *     moves its owner;
 *   - trials in a status the profile hides.
 */
import { prisma } from "@/lib/db";
import {
  AREA_GRANT_ROLES,
  AREA_GRANT_SOURCE,
  AREA_SIGNAL_GRANT_EXCLUDED_TOPICS,
  AREA_SIGNAL_START_DATE,
  AREA_TRIAL_PI_ROLE,
  isEligibleAreaGrant,
  isEligibleAreaTrial,
} from "@/lib/area-signals";
import { loadEntitySuppressions } from "@/lib/api/manual-layer";
import { collapseGrantProjects, scoreAreaSignals, type AreaSignalItem } from "@/lib/ranking";

/** "YYYY-MM" or "YYYY-MM-DD" (CT.gov precision varies) -> UTC date; null if unreadable. */
function trialStart(s: string | null): Date | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s ?? "");
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2] ?? "1") - 1, Number(m[3] ?? "1")));
}

/** Points per cwid; scholars with none are absent. Never adds a cwid not passed in. */
export async function loadAreaSignalPoints(
  topicSlug: string,
  cwids: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (cwids.length === 0) return out;
  const cwidIn = { in: [...cwids] };
  const grantsCount = !AREA_SIGNAL_GRANT_EXCLUDED_TOPICS.has(topicSlug);

  const [hiddenRows, grantRows, trialRows] = await Promise.all([
    prisma.fieldOverride.findMany({
      where: {
        entityType: "scholar",
        entityId: cwidIn,
        fieldName: { in: ["hideFunding", "hideClinicalTrials"] },
        value: "true",
      },
      select: { entityId: true, fieldName: true },
    }),
    grantsCount
      ? prisma.grant.findMany({
          where: {
            cwid: cwidIn,
            areaTextKey: { not: null },
            source: AREA_GRANT_SOURCE,
            role: { in: [...AREA_GRANT_ROLES] },
            startDate: { gte: new Date(`${AREA_SIGNAL_START_DATE}T00:00:00Z`) },
          },
          select: {
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
            areaTextKey: true,
          },
        })
      : Promise.resolve([]),
    prisma.personClinicalTrial.findMany({
      where: { cwid: cwidIn, role: AREA_TRIAL_PI_ROLE, trial: { areaTextKey: { not: null } } },
      select: {
        cwid: true,
        trial: {
          select: {
            protocolNumber: true,
            nctNumber: true,
            startDate: true,
            status: true,
            areaTextKey: true,
          },
        },
      },
    }),
  ]);

  const hidden = (field: string) =>
    new Set(hiddenRows.filter((r) => r.fieldName === field).map((r) => r.entityId));
  const hideFunding = hidden("hideFunding");
  const hideTrials = hidden("hideClinicalTrials");

  let grants = grantRows.filter((g) => !hideFunding.has(g.cwid) && isEligibleAreaGrant(g));
  const suppressed = await loadEntitySuppressions(
    "grant",
    grants.map((g) => g.externalId),
    prisma,
  );
  grants = grants.filter((g) => !suppressed.has(g.externalId));
  const trials = trialRows.filter((r) => !hideTrials.has(r.cwid) && isEligibleAreaTrial(r.trial));

  const keys = [
    ...new Set([
      ...grants.map((g) => g.areaTextKey as string),
      ...trials.map((r) => r.trial.areaTextKey as string),
    ]),
  ];
  if (keys.length === 0) return out;
  const texts = await prisma.areaSignalText.findMany({
    where: { textKey: { in: keys } },
    select: { textKey: true, topics: { where: { parentTopicId: topicSlug }, select: { score: true } } },
  });
  // key -> this area's score; 0 = scored, but not into this area; absent = not scored yet.
  const areaScore = new Map(texts.map((t) => [t.textKey, t.topics.length ? Number(t.topics[0].score) : 0]));

  const items = new Map<string, AreaSignalItem[]>();
  const push = (cwid: string, item: AreaSignalItem) =>
    items.set(cwid, [...(items.get(cwid) ?? []), item]);

  // A project's area score is its best row's; its start is the earliest SCORED row's.
  for (const project of collapseGrantProjects(grants)) {
    const scored = project.filter((g) => areaScore.has(g.areaTextKey as string));
    if (scored.length === 0) continue;
    const score = Math.max(...scored.map((g) => areaScore.get(g.areaTextKey as string) ?? 0));
    if (score <= 0) continue;
    const start = new Date(Math.min(...scored.map((g) => g.startDate.getTime())));
    push(project[0].cwid, { kind: "grant", score, start });
  }

  // One trial per NCT per scholar: the earliest-starting protocol stands for it.
  const seen = new Set<string>();
  const byStart = [...trials].sort(
    (a, b) =>
      (a.trial.startDate ?? "").localeCompare(b.trial.startDate ?? "") ||
      a.trial.protocolNumber.localeCompare(b.trial.protocolNumber),
  );
  for (const { cwid, trial } of byStart) {
    const id = JSON.stringify([cwid, trial.nctNumber ?? trial.protocolNumber]);
    if (seen.has(id)) continue;
    seen.add(id);
    const score = areaScore.get(trial.areaTextKey as string) ?? 0;
    if (score > 0) push(cwid, { kind: "trial", score, start: trialStart(trial.startDate) });
  }

  for (const [cwid, its] of items) {
    const points = scoreAreaSignals(its, now);
    if (points > 0) out.set(cwid, points);
  }
  return out;
}
