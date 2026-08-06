/**
 * Headshot-presence backfill (Data Quality dashboard, #data-quality-dashboard).
 *
 * Probes the WCM directory for every active scholar's headshot and persists the
 * verdict to `Scholar.has_headshot` / `headshot_checked_at`. The app can't know
 * presence otherwise (it derives the directory URL from the cwid and only finds
 * out at image-load time, client-side); persisting it makes "missing headshot" an
 * exact, prominence-sortable, filterable column in the dashboard.
 *
 * Reads the PUBLIC directory endpoint over NAT egress with no credential, so this
 * is wired into the weekly cadence as `external:false` (like etl:nsf). It mutates
 * SPS-DB only.
 *
 * Usage:
 *   npm run etl:headshot           incremental — never-checked + stale
 *                                  (older than HEADSHOT_STALE_DAYS)
 *   npm run etl:headshot -- --full re-probe every active scholar
 *
 * Exits 0 on success, 1 on failure. STDOUT carries one structured result line.
 */
import { db } from "../../lib/db";
import { headshotStaleBefore, probeHeadshot } from "../../lib/headshot-presence";
import { withEtlRun } from "@/lib/etl-run";

/** Concurrent in-flight directory probes. The directory is a shared WCM service;
 *  keep this modest so the weekly job is a good citizen. */
const CONCURRENCY = 12;

async function main(): Promise<void> {
  const full = process.argv.includes("--full");
  // Incremental mode re-probes a scholar whose last check is older than this.
  // The threshold is pinned to the weekly cadence in `lib/headshot-presence.ts`
  // — see HEADSHOT_STALE_DAYS for why it must stay under 7 days (#2210).
  const staleBefore = headshotStaleBefore();

  const scholars = await db.write.scholar.findMany({
    where: full
      ? { deletedAt: null }
      : {
          deletedAt: null,
          OR: [{ headshotCheckedAt: null }, { headshotCheckedAt: { lt: staleBefore } }],
        },
    select: { cwid: true, hasHeadshot: true },
  });

  let present = 0;
  let absent = 0;
  let indeterminate = 0;
  // Directory-wide 404s (outage, URL-scheme change) read as authoritative
  // absence per-probe; cap how many previously-true rows may flip to absent
  // in one run before aborting (audit PR-3). Threshold: 20% of the cohort's
  // known-true rows, min 25 so small incremental batches don't false-trip.
  const previouslyTrue = scholars.filter((s) => s.hasHeadshot === true).length;
  const maxAbsentFlips = Math.max(25, Math.ceil(previouslyTrue * 0.2));
  let absentFlips = 0;
  // The mirror-image count: rows that were persisted `false` and now probe
  // present. This is exactly the #2210 population — a scholar whose photo
  // landed after the last probe, whom the dashboard has been listing under
  // `?gap=no-headshot` ever since. `absent`/`present` below count the whole
  // scanned cohort and cannot separate "still absent" from "just corrected",
  // so the flips are what makes the correction rate observable at all. Both
  // are reported, not just the one the abort guard reads.
  let presentFlips = 0;

  // Bounded-concurrency pool over a shared index — each worker pulls the next
  // cwid until the list is drained.
  let next = 0;
  async function worker(): Promise<void> {
    while (next < scholars.length) {
      const scholar = scholars[next++];
      const cwid = scholar.cwid;
      const verdict = await probeHeadshot(cwid);
      if (verdict === null) {
        // Indeterminate — do NOT overwrite a known value or stamp checkedAt.
        indeterminate++;
        continue;
      }
      if (verdict === true && scholar.hasHeadshot === false) {
        presentFlips++;
      }
      if (verdict === false && scholar.hasHeadshot === true) {
        absentFlips++;
        if (absentFlips > maxAbsentFlips) {
          throw new Error(
            `[Headshot] ${absentFlips} previously-true rows flipped to absent ` +
              `(cap ${maxAbsentFlips}) — suspected directory outage, aborting run`,
          );
        }
      }
      await db.write.scholar.update({
        where: { cwid },
        data: { hasHeadshot: verdict, headshotCheckedAt: new Date() },
      });
      if (verdict) present++;
      else absent++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, scholars.length) }, () => worker()),
  );

  console.log(
    JSON.stringify({
      event: "headshot_presence",
      mode: full ? "full" : "incremental",
      scanned: scholars.length,
      present,
      absent,
      indeterminate,
      flippedToPresent: presentFlips,
      flippedToAbsent: absentFlips,
      ts: new Date().toISOString(),
    }),
  );
}

withEtlRun("Headshot", main)
  .catch((err) => {
    console.error("[Headshot] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
