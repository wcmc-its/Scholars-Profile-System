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
 *   npm run etl:headshot           incremental — never-checked + stale (> 30d)
 *   npm run etl:headshot -- --full re-probe every active scholar
 *
 * Exits 0 on success, 1 on failure. STDOUT carries one structured result line.
 */
import { db } from "../../lib/db";
import { probeHeadshot } from "../../lib/headshot-presence";

/** Concurrent in-flight directory probes. The directory is a shared WCM service;
 *  keep this modest so the weekly job is a good citizen. */
const CONCURRENCY = 12;
/** Incremental mode re-probes a scholar whose last check is older than this. */
const STALE_DAYS = 30;

async function main(): Promise<void> {
  const full = process.argv.includes("--full");
  const staleBefore = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const scholars = await db.write.scholar.findMany({
    where: full
      ? { deletedAt: null }
      : {
          deletedAt: null,
          OR: [{ headshotCheckedAt: null }, { headshotCheckedAt: { lt: staleBefore } }],
        },
    select: { cwid: true },
  });

  let present = 0;
  let absent = 0;
  let indeterminate = 0;

  // Bounded-concurrency pool over a shared index — each worker pulls the next
  // cwid until the list is drained.
  let next = 0;
  async function worker(): Promise<void> {
    while (next < scholars.length) {
      const cwid = scholars[next++].cwid;
      const verdict = await probeHeadshot(cwid);
      if (verdict === null) {
        // Indeterminate — do NOT overwrite a known value or stamp checkedAt.
        indeterminate++;
        continue;
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
      ts: new Date().toISOString(),
    }),
  );
}

main()
  .catch((err) => {
    console.error("[Headshot] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
