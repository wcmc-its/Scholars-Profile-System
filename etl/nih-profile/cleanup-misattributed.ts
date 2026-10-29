/**
 * Issue #766 — one-off cleanup of misattributed `person_nih_profile` rows.
 *
 * The grant-join resolver used to stamp a project's RePORTER *contact PI*
 * `profile_id` onto whichever single WCM scholar we held a PI-level grant row
 * for, with no name check. On multiple-PI / subaward grants where we hold a
 * *co*-PI's row, the contact PI is a different person — so co-investigators'
 * NIH profiles were attributed to the wrong scholar (e.g. Sabine Ehrt's profile
 * mapped to cnathan). `resolver.ts` now name-guards the contact shortcut, which
 * stops *new* bad rows, but `etl/nih-profile/index.ts` only ever upserts — it
 * never deletes rows no longer observed — so the rows already written persist
 * until removed. This script removes them.
 *
 * `person_nih_profile` stores only the `nih_profile_id`, not the RePORTER name,
 * so a wrong-person row can't be told from a legitimate duplicate-eRA-account
 * row by SQL alone. We recover the real name behind each id from RePORTER and
 * delete a row only when the profile's name does not agree with the scholar's
 * (same `namesMatch` bar the resolver uses).
 *
 * #3071: the rows that survived also confirm the other person's awards on the
 * scholar's profile, so preferred rows are now in scope too. And a link resolved
 * by name alone (`name_query`, `name_match`) can name a namesake: the name agrees
 * by construction, so only the attribution scorer's per-award evidence can tell.
 *
 * Two checks, either of which marks a row wrong:
 *   - NAME, for the grant-join sources (`grant_join_contact`, `grant_join_pi`).
 *     The name-only sources matched on name, so it would only re-confirm them.
 *   - EVIDENCE, for the name-only sources. The scholar's only link is wrong
 *     when every award it brought is ruled out (a veto cue, `isVetoCue`, or a
 *     curator's rejection), none is supported or confirmed, and the profile holds
 *     none of the scholar's InfoEd awards. Only net-new awards are scored, so an
 *     InfoEd match is the one tie the scores cannot show. A grant-join link was
 *     made through such a match, so it gets the name check only. Awards carry
 *     no profile id, so a scholar with several links is listed for review, never
 *     deleted on evidence. A weak cue like `name_common` lowers the score but is
 *     no evidence against, so it never counts.
 *
 * Scope / safety:
 *   - A row is deleted on NAME only on positive disagreement: RePORTER returned a name
 *     for the id, it matches neither the scholar's full nor preferred name, and
 *     its surname appears nowhere in either. A surname-only agreement (nickname,
 *     changed given name, or a namesake) is KEPT and listed for review, and so
 *     is an id RePORTER returns no name for. We never delete on absence of
 *     evidence.
 *   - A row a curator confirmed (`reporter_profile_candidate.status =
 *     'confirmed'`) is never deleted.
 *   - A deleted link is recorded as a `revoked` `reporter_profile_candidate`
 *     (reviewer `system-cleanup`, with an audit row), which the NihProfile ETL
 *     and the v2 matcher both honor, so the next run does not write it back.
 *   - Deleting a preferred row promotes the scholar's most recently verified
 *     remaining row, so the "View NIH portfolio" link keeps a target. The next
 *     NihProfile run re-picks the preferred row for any scholar it observes.
 *   - Dry-run by default. Pass `--apply` to perform deletes.
 *
 * Usage:
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts            # dry-run
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts -- --apply # delete
 *
 * The dry run reads only, so it can run as a probe (scripts/run-staging-probe.sh).
 */
// `@/` imports, not relative ones, so the dry run can ship as a read-only probe
// (scripts/run-staging-probe.sh copies this one file into the app tree).
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { evidenceLevel } from "@/lib/edit/grant-attribution-board";
import { isVetoCue, type GrantAttributionCue } from "@/lib/edit/grant-attribution-queue";
import { coreProjectNum } from "@/lib/award-number";
import {
  PAGE_LIMIT,
  searchProjectsByProfileIds,
  sleepBetweenRequests,
  type ReporterPI,
} from "@/etl/nih-profile/fetcher";
import { namesMatch, reporterPiName } from "@/etl/nih-profile/resolver";
import { piSurnameMatches } from "@/etl/reporter-grants/score";
import { NAME_ONLY_RESOLUTION_SOURCES } from "@/etl/reporter-grants/transform";

// One profile_id per request. `searchProjectsByProfileIds` fetches a single
// 500-row page (no pagination); batching many prolific PIs together overflows
// that page, so ids whose projects sort past row 500 came back nameless and
// were wrongly parked as "no RePORTER name → keep" — the cleanup then
// under-deleted (72 vs the true 148 wrong-person rows on the first dataset run).
// With a single id, every returned project lists that id as a PI, so its name
// is always present in the first page. 1 req/sec keeps us within NIH's limit.
const BATCH_SIZE = 1;

type SuspectRow = {
  cwid: string;
  nihProfileId: number;
  isPreferred: boolean;
  resolutionSource: string;
  scholarName: string;
  preferredName: string | null;
  /** Why it goes: the name, or the awards' evidence. Set once judged wrong. */
  why?: "name" | "evidence";
};

/** Sources whose link never passed a name check against the scholar. */
const NAME_CHECKED_SOURCES = new Set(["grant_join_contact", "grant_join_pi"]);
const CLEANUP_ACTOR = "system-cleanup";

export type ScoredAward = {
  score: number;
  cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight">>;
  /** A curator's decision on the award, if any. */
  curator: "confirmed" | "rejected" | null;
};

/** What a scholar's scored awards say about the link they came from. "against"
 *  only when there is at least one award, none is supported or confirmed, and
 *  every one is ruled out by a veto cue or a curator. */
export function evidenceVerdict(awards: ScoredAward[]): "against" | "not_against" {
  if (awards.length === 0) return "not_against";
  for (const a of awards) {
    if (a.curator === "confirmed") return "not_against";
    if (evidenceLevel(a.score, a.cues) === "supports") return "not_against";
  }
  return awards.every((a) => a.curator === "rejected" || a.cues.some(isVetoCue))
    ? "against"
    : "not_against";
}

export type LinkVerdict = "ok" | "surname_only" | "wrong" | "no_name";

/** How the names RePORTER holds for a profile compare with the scholar's. */
export function classifyLink(
  reporterNames: string[],
  scholarNames: Array<string | null>,
): LinkVerdict {
  if (reporterNames.length === 0) return "no_name";
  const ours = scholarNames.filter((n): n is string => !!n && n.trim().length > 0);
  if (reporterNames.some((r) => ours.some((n) => namesMatch(r, n)))) return "ok";
  if (reporterNames.some((r) => piSurnameMatches(r, ours) === true)) return "surname_only";
  return "wrong";
}

/** The row to make preferred once `deleted` rows are gone, or null when the
 *  scholar keeps a preferred row or has none left. Most recently verified wins,
 *  lowest id breaks ties so dry run and apply agree. */
export function promotionAfterDelete(
  rows: Array<{ nihProfileId: number; isPreferred: boolean; lastVerified: Date }>,
  deleted: Set<number>,
): number | null {
  const left = rows.filter((r) => !deleted.has(r.nihProfileId));
  if (left.length === 0 || left.some((r) => r.isPreferred)) return null;
  if (!rows.some((r) => r.isPreferred && deleted.has(r.nihProfileId))) return null;
  left.sort(
    (a, b) =>
      b.lastVerified.getTime() - a.lastVerified.getTime() || a.nihProfileId - b.nihProfileId,
  );
  return left[0]!.nihProfileId;
}

type ProfileLookup = {
  /** The distinct PI names RePORTER reports for each profile_id. */
  names: Map<number, Set<string>>;
  /** Each profile_id's core project numbers. */
  cores: Map<number, Set<string>>;
  /** The ids whose whole project list came back (fetched, under one page). */
  complete: Set<number>;
};

async function fetchProfiles(profileIds: number[]): Promise<ProfileLookup> {
  const namesByProfileId = new Map<number, Set<string>>();
  const cores = new Map<number, Set<string>>();
  const complete = new Set<number>();
  const idSet = new Set(profileIds);
  for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
    const batch = profileIds.slice(i, i + BATCH_SIZE);
    let projects;
    try {
      projects = await searchProjectsByProfileIds(batch);
    } catch (err) {
      console.warn(
        `  RePORTER lookup failed for batch ${i / BATCH_SIZE} (${batch.length} ids):`,
        err,
      );
      await sleepBetweenRequests();
      continue;
    }
    if (projects.length < PAGE_LIMIT) for (const id of batch) complete.add(id);
    for (const project of projects) {
      const core = project.core_project_num ? coreProjectNum(project.core_project_num) : null;
      for (const id of batch) {
        if (!core) continue;
        const set = cores.get(id) ?? new Set<string>();
        set.add(core);
        cores.set(id, set);
      }
      for (const pi of project.principal_investigators as ReporterPI[]) {
        if (!idSet.has(pi.profile_id)) continue;
        const name = reporterPiName(pi);
        if (!name) continue;
        const set = namesByProfileId.get(pi.profile_id) ?? new Set<string>();
        set.add(name);
        namesByProfileId.set(pi.profile_id, set);
      }
    }
    const done = Math.min(i + BATCH_SIZE, profileIds.length);
    if (done % 50 === 0 || done === profileIds.length) {
      console.log(`  ...resolved ${done}/${profileIds.length} profile ids`);
    }
    await sleepBetweenRequests();
  }
  return { names: namesByProfileId, cores, complete };
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    `\n=== person_nih_profile misattribution cleanup (#766, #3071) — ${apply ? "APPLY (deleting)" : "DRY RUN"} ===\n`,
  );

  const rows = await db.write.personNihProfile.findMany({
    select: {
      cwid: true,
      nihProfileId: true,
      isPreferred: true,
      resolutionSource: true,
      lastVerified: true,
      scholar: { select: { fullName: true, preferredName: true } },
    },
  });
  const bySource = new Map<string, number>();
  for (const r of rows)
    bySource.set(r.resolutionSource, (bySource.get(r.resolutionSource) ?? 0) + 1);
  console.log(
    `${rows.length} links to validate: ` +
      [...bySource].map(([src, n]) => `${src}=${n}`).join(", ") +
      ".",
  );
  if (rows.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  const suspects: SuspectRow[] = rows.map((r) => ({
    cwid: r.cwid,
    nihProfileId: r.nihProfileId,
    isPreferred: r.isPreferred,
    resolutionSource: r.resolutionSource,
    scholarName: r.scholar.fullName,
    preferredName: r.scholar.preferredName,
  }));
  const linksByCwid = new Map<string, number>();
  for (const s of suspects) linksByCwid.set(s.cwid, (linksByCwid.get(s.cwid) ?? 0) + 1);

  const confirmed = new Set(
    (
      await db.write.reporterProfileCandidate.findMany({
        where: { status: "confirmed" },
        select: { cwid: true, externalProfileId: true },
      })
    ).map((c) => `${c.cwid}::${c.externalProfileId}`),
  );

  // --- name check: the grant-join sources ---
  const nameChecked = suspects.filter((s) => NAME_CHECKED_SOURCES.has(s.resolutionSource));
  const distinctIds = Array.from(new Set(nameChecked.map((s) => s.nihProfileId)));
  console.log(`Looking up ${distinctIds.length} distinct grant-join profile ids on RePORTER...`);
  const lookup = await fetchProfiles(distinctIds);
  const namesByProfileId = lookup.names;

  const toDelete: SuspectRow[] = [];
  const kept: SuspectRow[] = [];
  const surnameOnly: SuspectRow[] = [];
  const curatorConfirmed: SuspectRow[] = [];
  const unresolvable: SuspectRow[] = [];
  const evidenceMultiLink: SuspectRow[] = [];

  for (const s of nameChecked) {
    const verdict = classifyLink(Array.from(namesByProfileId.get(s.nihProfileId) ?? []), [
      s.scholarName,
      s.preferredName,
    ]);
    if (verdict === "ok") kept.push(s);
    else if (verdict === "surname_only") surnameOnly.push(s);
    else if (verdict === "no_name")
      unresolvable.push(s); // no evidence — keep, flag for manual review
    else if (confirmed.has(`${s.cwid}::${s.nihProfileId}`)) curatorConfirmed.push(s);
    else toDelete.push({ ...s, why: "name" });
  }

  // --- evidence check: every source but a publication-proven one ---
  const scores = await db.write.grantAttributionScore.findMany({
    select: { cwid: true, grantExternalId: true, score: true, cues: true },
  });
  const curatorDecisions = new Map(
    (
      await db.write.grantAttributionReview.findMany({
        where: { status: { in: ["confirmed", "rejected"] } },
        select: { grantExternalId: true, status: true, decidedByCwid: true },
      })
    )
      .filter((r) => r.decidedByCwid !== null && !r.decidedByCwid.startsWith("system"))
      .map((r) => [r.grantExternalId, r.status as "confirmed" | "rejected"]),
  );
  const awardsByCwid = new Map<string, ScoredAward[]>();
  for (const sc of scores) {
    const arr = awardsByCwid.get(sc.cwid) ?? [];
    arr.push({
      score: sc.score,
      cues: sc.cues as unknown as GrantAttributionCue[],
      curator: curatorDecisions.get(sc.grantExternalId) ?? null,
    });
    awardsByCwid.set(sc.cwid, arr);
  }
  console.log(`${scores.length} scored awards across ${awardsByCwid.size} scholars.`);

  const evidenceSuspects: SuspectRow[] = [];
  for (const s of suspects) {
    if (!NAME_ONLY_RESOLUTION_SOURCES.has(s.resolutionSource)) continue;
    if (evidenceVerdict(awardsByCwid.get(s.cwid) ?? []) !== "against") continue;
    if (confirmed.has(`${s.cwid}::${s.nihProfileId}`)) curatorConfirmed.push(s);
    else if ((linksByCwid.get(s.cwid) ?? 0) > 1) evidenceMultiLink.push(s);
    else evidenceSuspects.push(s);
  }

  // Only net-new awards are scored: one the profile shares with the scholar's
  // InfoEd grants was deduplicated away, and it proves the link. So a suspect
  // goes only when its profile's whole project list came back and none of it
  // is among the scholar's InfoEd awards.
  const infoedCores = new Map<string, Set<string>>();
  for (const g of await db.write.grant.findMany({
    where: {
      source: "InfoEd",
      awardNumber: { not: null },
      cwid: { in: [...new Set(evidenceSuspects.map((s) => s.cwid))] },
    },
    select: { cwid: true, awardNumber: true },
  })) {
    const core = coreProjectNum(g.awardNumber!);
    if (!core) continue;
    const set = infoedCores.get(g.cwid) ?? new Set<string>();
    set.add(core);
    infoedCores.set(g.cwid, set);
  }
  console.log(`Looking up ${evidenceSuspects.length} name-only profiles the evidence rules out...`);
  const evidenceLookup = await fetchProfiles([
    ...new Set(evidenceSuspects.map((s) => s.nihProfileId)),
  ]);
  for (const [id, names] of evidenceLookup.names) namesByProfileId.set(id, names);

  const infoedProven: SuspectRow[] = [];
  let evidenceDeleted = 0;
  for (const s of evidenceSuspects) {
    const mine = infoedCores.get(s.cwid) ?? new Set<string>();
    const theirs = evidenceLookup.cores.get(s.nihProfileId) ?? new Set<string>();
    if (!evidenceLookup.complete.has(s.nihProfileId)) unresolvable.push(s);
    else if ([...theirs].some((c) => mine.has(c))) infoedProven.push(s);
    else {
      toDelete.push({ ...s, why: "evidence" });
      evidenceDeleted++;
    }
  }

  // Every row of each affected scholar, any source, to plan preferred promotion.
  const affectedCwids = [...new Set(toDelete.map((s) => s.cwid))];
  const promotions = new Map<string, number>();
  for (const cwid of affectedCwids) {
    const deleted = new Set(toDelete.filter((s) => s.cwid === cwid).map((s) => s.nihProfileId));
    const promote = promotionAfterDelete(
      rows.filter((r) => r.cwid === cwid),
      deleted,
    );
    if (promote !== null) promotions.set(cwid, promote);
  }

  const fmt = (s: SuspectRow) => {
    const rep =
      Array.from(namesByProfileId.get(s.nihProfileId) ?? []).join(" / ") || "(no RePORTER name)";
    const pn =
      s.preferredName && s.preferredName !== s.scholarName ? ` (pref "${s.preferredName}")` : "";
    const awards = awardsByCwid.get(s.cwid) ?? [];
    const ev = awards.length > 0 ? ` awards=${awards.length}` : "";
    return `  ${s.cwid.padEnd(12)} profile ${String(s.nihProfileId).padEnd(10)} ${s.isPreferred ? "PREFERRED " : "          "}${s.resolutionSource.padEnd(19)}${s.why ? ` [${s.why}]` : ""}${ev} scholar="${s.scholarName}"${pn}  reporter="${rep}"`;
  };

  const byWhy = (w: "name" | "evidence") => toDelete.filter((s) => s.why === w).length;
  console.log(
    `\n--- WRONG PERSON → ${apply ? "DELETING" : "would delete"} (${toDelete.length}: ${byWhy("name")} on name, ${byWhy("evidence")} on evidence) ---`,
  );
  toDelete.forEach((s) => console.log(fmt(s)));
  const orphaned = toDelete.filter((s) => s.isPreferred && !promotions.has(s.cwid));
  console.log(
    `\n--- preferred link ${apply ? "promoted" : "would be promoted"} after a delete (${promotions.size}) ---`,
  );
  for (const [cwid, id] of promotions) console.log(`  ${cwid.padEnd(12)} profile ${id}`);
  if (orphaned.length > 0) {
    console.log(`\n--- scholar left with NO NIH profile after the delete (${orphaned.length}) ---`);
    orphaned.forEach((s) => console.log(fmt(s)));
  }
  if (infoedProven.length > 0) {
    console.log(
      `\n--- every scored award ruled out, but the profile holds the scholar's InfoEd award → KEEPING (${infoedProven.length}) ---`,
    );
    infoedProven.forEach((s) => console.log(fmt(s)));
  }
  if (evidenceMultiLink.length > 0) {
    console.log(
      `\n--- every award ruled out, but the scholar has several links → KEEPING, review (${evidenceMultiLink.length}) ---`,
    );
    evidenceMultiLink.forEach((s) => console.log(fmt(s)));
  }
  console.log(
    `\n--- surname agrees, given name does not → KEEPING, review (${surnameOnly.length}) ---`,
  );
  surnameOnly.forEach((s) => console.log(fmt(s)));
  if (curatorConfirmed.length > 0) {
    console.log(
      `\n--- judged wrong but a curator confirmed the profile → KEEPING (${curatorConfirmed.length}) ---`,
    );
    curatorConfirmed.forEach((s) => console.log(fmt(s)));
  }
  console.log(`\n--- grant-join, name agrees → keeping (${kept.length}) ---`);
  if (unresolvable.length > 0) {
    console.log(
      `\n--- RePORTER lookup incomplete for id → KEEPING, review manually (${unresolvable.length}) ---`,
    );
    unresolvable.forEach((s) => console.log(fmt(s)));
  }

  if (!apply) {
    console.log(
      `\nDry run — re-run with \`--apply\` to delete the ${toDelete.length} wrong-person rows.\n`,
    );
    return;
  }

  let deleted = 0;
  const now = new Date();
  for (const cwid of affectedCwids) {
    const mine = toDelete.filter((s) => s.cwid === cwid);
    const promote = promotions.get(cwid);
    await db.write.$transaction(async (tx) => {
      for (const s of mine) {
        await tx.personNihProfile.delete({
          where: { cwid_nihProfileId: { cwid: s.cwid, nihProfileId: s.nihProfileId } },
        });
        // The revoked candidate is what keeps the NihProfile ETL from writing
        // the link back on its next run.
        const prior = await tx.reporterProfileCandidate.findUnique({
          where: { cwid_externalProfileId: { cwid: s.cwid, externalProfileId: s.nihProfileId } },
          select: { status: true },
        });
        const candidate = await tx.reporterProfileCandidate.upsert({
          where: { cwid_externalProfileId: { cwid: s.cwid, externalProfileId: s.nihProfileId } },
          create: {
            cwid: s.cwid,
            externalProfileId: s.nihProfileId,
            candidateName: Array.from(namesByProfileId.get(s.nihProfileId) ?? [])[0] ?? "",
            candidateOrgs: "",
            grantCount: awardsByCwid.get(s.cwid)?.length ?? 0,
            overlapK: 0,
            sampleGrants: [],
            status: "revoked",
            reviewedBy: CLEANUP_ACTOR,
            reviewedAt: now,
          },
          update: { status: "revoked", reviewedBy: CLEANUP_ACTOR, reviewedAt: now },
        });
        await appendAuditRow(tx, {
          actorCwid: CLEANUP_ACTOR,
          impersonatedCwid: null,
          targetEntityType: "reporter_profile_candidate",
          targetEntityId: candidate.id,
          action: "reporter_profile_revoke",
          fieldsChanged: ["status"],
          beforeValues: { status: prior?.status ?? null, nihProfileId: s.nihProfileId },
          afterValues: {
            status: "revoked",
            resolutionSource: s.resolutionSource,
            reason: s.why ?? "name",
          },
          ts: now,
          requestId: null,
        });
      }
      if (promote !== undefined) {
        await tx.personNihProfile.update({
          where: { cwid_nihProfileId: { cwid, nihProfileId: promote } },
          data: { isPreferred: true },
        });
      }
    });
    deleted += mine.length;
  }
  console.log(
    `\nDeleted ${deleted} misattributed rows (${evidenceDeleted} on evidence) and promoted ${promotions.size} preferred links. ` +
      `Kept ${kept.length}; ${surnameOnly.length + unresolvable.length + evidenceMultiLink.length} need manual review.\n`,
  );
}

// Guarded so the module can be imported by a unit test without running the cleanup.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .then(() => db.write.$disconnect())
    .catch(async (err) => {
      console.error(err);
      await db.write.$disconnect();
      process.exit(1);
    });
}
