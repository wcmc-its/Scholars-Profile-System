/**
 * Honors-list scraper — `npm run etl:honors`.
 *
 * Reads each public honor roster in `lib/honors/lists.ts` (one parser per list
 * under `etl/honors/lists/`), matches its entries to Weill Cornell scholars
 * (`etl/honors/lists/match.ts`, conservative: WCM affiliation + full first name +
 * surname), and proposes each NEW match as a `pending` honor for the curator
 * queue (`/edit/honors-queue` Possible). It never approves anything, and never
 * touches a row that already exists for that honor (see `lists/plan.ts`).
 *
 * Deployed as the dedicated Step Functions machine `scholars-honors-<env>`
 * (cdk/lib/etl-stack.ts): a weekly EventBridge schedule, plus the console's
 * Run now (`POST /api/edit/honor/sources/run`, behind HONORS_RUN_NOW), which
 * starts an execution for one list. ETL code ships on the ECR push; no cdk
 * deploy is needed to change a parser.
 *
 * Env:
 *   HONORS_LISTS    "all" (default) or a comma-separated list of list ids.
 *   HONORS_TRIGGER  "schedule" (default) | "manual" — recorded on each run row.
 *   HONORS_RUN_ID   set only by a Run now execution: the `queued` honor_list_run
 *                   row the route wrote. Requires exactly one list.
 *
 * Records:
 *   - one `honor_list_run` row per list (the Sources tab's "Last run"). A run
 *     only ever claims its OWN row (lib/honors/run-lock.ts claimHonorRun): a Run
 *     now execution claims the queued row named by HONORS_RUN_ID; any other run
 *     inserts a new row holding the list's lock (`active_list_id`, UNIQUE). If
 *     another run of a list is in flight (e.g. a Run now), a scheduled run SKIPS
 *     that list rather than taking over its row or scraping it twice.
 *   - on an all-lists run, one `etl_run` row under source "HonorsLists" — the
 *     freshness heartbeat's weekly signal (lib/etl/freshness-policy.ts). A
 *     single-list Run now does NOT write it: one list succeeding says nothing
 *     about the others.
 *
 * Exit status: non-zero only when EVERY requested list failed (so the state
 * machine's Catch pages). A single list failing is recorded on its run row and
 * shown on the Sources tab; it does not fail the others.
 *
 * Usage (local):  npm run etl:honors -- --dry-run   # scrape + match, no writes
 */
import { db, disconnect } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { HONOR_LISTS, type HonorListMeta, selectHonorLists } from "@/lib/honors/lists";
import { claimHonorRun } from "@/lib/honors/run-lock";

import { defaultFetch } from "./lists/html";
import { SCRAPERS } from "./lists/index";
import { buildScholarIndex, type ScholarIndex } from "./lists/match";
import { type ExistingHonor, planList } from "./lists/plan";

const dryRun = process.argv.includes("--dry-run");

/** `honor_list_run.error_message` is VARCHAR(1024). */
const ERROR_MAX = 1024;

type ListOutcome = {
  list: string;
  status: "success" | "partial" | "failed" | "skipped";
  onList: number;
};
type Trigger = "schedule" | "manual";

const clip = (s: string) => (s.length <= ERROR_MAX ? s : `${s.slice(0, ERROR_MAX - 1)}…`);

async function runList(
  meta: HonorListMeta,
  index: ScholarIndex,
  trigger: Trigger,
  ownRunId: string | null,
): Promise<ListOutcome> {
  const scraper = SCRAPERS[meta.id];
  let runId: string | null = null;
  if (!dryRun) {
    const claim = await claimHonorRun(db.write, { listId: meta.id, trigger, runId: ownRunId });
    if (claim.kind === "busy") {
      console.warn(`[Honors] ${meta.id}: another run of this list is in flight; skipped.`);
      return { list: meta.id, status: "skipped", onList: 0 };
    }
    if (claim.kind === "missing") {
      console.error(
        `[Honors] ${meta.id}: run ${ownRunId} is not a queued run of this list ` +
          "(expired as stale, or never written); nothing scraped.",
      );
      return { list: meta.id, status: "failed", onList: 0 };
    }
    runId = claim.id;
  }
  try {
    if (!scraper) throw new Error(`no scraper registered for list "${meta.id}"`);
    const scrape = await scraper(defaultFetch);
    // Every list has entries; zero means the page changed shape under us, and
    // recording that as a quiet success would hide it indefinitely.
    if (scrape.entries.length === 0) {
      throw new Error("The roster parsed to zero entries; the page layout may have changed.");
    }
    const existing = (await db.read.honor.findMany({
      where: { organization: meta.organization, name: meta.honorName },
      select: { id: true, cwid: true, status: true, evidence: true },
    })) as ExistingHonor[];
    const plan = planList(meta, scrape, index, existing);
    const status = scrape.complete ? "success" : "partial";
    console.log(
      `[Honors] ${meta.id}: ${plan.onListTotal} on list, ${plan.matched} matched, ` +
        `${plan.creates.length} new candidate(s), ${plan.evidenceFills.length} evidence fill(s)` +
        (scrape.warning ? ` — ${scrape.warning}` : ""),
    );
    if (!runId) return { list: meta.id, status, onList: plan.onListTotal };

    // Creates first, then the run row: a crash between them leaves new pending
    // rows and a `running` row that ages out as "did not finish", never a
    // success claiming candidates that were not written.
    await db.write.$transaction(async (tx) => {
      if (plan.creates.length) await tx.honor.createMany({ data: plan.creates });
      for (const f of plan.evidenceFills) {
        await tx.honor.updateMany({
          where: { id: f.id, status: "pending", evidence: null },
          data: { evidence: f.evidence },
        });
      }
    });
    await db.write.honorListRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        activeListId: null,
        onListTotal: plan.onListTotal,
        matched: plan.matched,
        newCandidates: plan.creates.length,
        errorMessage: scrape.warning ? clip(scrape.warning) : null,
      },
    });
    return { list: meta.id, status, onList: plan.onListTotal };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Honors] ${meta.id} failed: ${message}`);
    if (runId) {
      await db.write.honorListRun
        .update({
          where: { id: runId },
          data: {
            status: "failed",
            finishedAt: new Date(),
            activeListId: null,
            errorMessage: clip(message),
          },
        })
        .catch((e) => console.error(`[Honors] could not record failure for ${meta.id}`, e));
    }
    return { list: meta.id, status: "failed", onList: 0 };
  }
}

async function scrapeSelected(
  lists: HonorListMeta[],
  trigger: Trigger,
  ownRunId: string | null,
): Promise<number> {
  const scholars = await db.read.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true, preferredName: true, fullName: true },
  });
  const index = buildScholarIndex(scholars);
  console.log(
    `[Honors] ${scholars.length} scholars indexed; lists: ${lists.map((l) => l.id).join(", ")}`,
  );

  const outcomes: ListOutcome[] = [];
  // Sequential: a few polite requests at a time to each host, never a burst.
  for (const meta of lists) outcomes.push(await runList(meta, index, trigger, ownRunId));

  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length === outcomes.length) {
    throw new Error(`every requested honor list failed: ${failed.map((o) => o.list).join(", ")}`);
  }
  if (failed.length)
    console.warn(
      `[Honors] ${failed.length} list(s) failed: ${failed.map((o) => o.list).join(", ")}`,
    );
  return outcomes.reduce((n, o) => n + o.onList, 0);
}

async function main() {
  const raw = process.env.HONORS_LISTS;
  const lists = selectHonorLists(raw);
  const trigger: Trigger = process.env.HONORS_TRIGGER === "manual" ? "manual" : "schedule";
  // Empty on a scheduled or operator-started execution (the state machine
  // defaults it); a Run now execution carries the queued row's id.
  const ownRunId = process.env.HONORS_RUN_ID?.trim() || null;
  if (ownRunId && lists.length !== 1) {
    throw new Error(`HONORS_RUN_ID names one run, but ${lists.length} lists were requested`);
  }
  const allLists = lists.length === HONOR_LISTS.length;
  if (dryRun) {
    console.log("[Honors] DRY-RUN: scrape + match only, no DB writes.");
    await scrapeSelected(lists, trigger, ownRunId);
    return;
  }
  if (allLists) await withEtlRun("HonorsLists", () => scrapeSelected(lists, trigger, ownRunId));
  else await scrapeSelected(lists, trigger, ownRunId);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(disconnect);
