/**
 * Bulk-confirm the STRONG pending matches in four /edit review queues, from the
 * back end, with exactly the write a curator's Approve / Confirm click makes.
 *
 *   grant   /edit/grant-attribution-queue  confirm  (decideGrantReview)
 *   honors  /edit/honors-queue             approve  (decideHonor)
 *   news    /edit/news-queue               approve  (decideNewsMention; newsroom only)
 *   orcid   /edit/orcid-queue              confirm  (confirmPair)
 *
 * Each item goes through the SAME core function its decision route calls, in
 * its own `db.write` transaction: the same status re-check, sibling handling,
 * decision stamps and audit row (`honor_update`, `news_mention_update`,
 * `grant_attribution_confirm`, `orcid_librarian_confirm`; no new audit
 * action). The audit actor and every decided-by column is `--actor`, the real
 * person authorizing the run, and every audit row of the run carries one
 * request id, `bulk-strong-<iso time>`, so the run is one query in the log.
 *
 * WHICH ITEMS. The verified "strong" LIST query per queue (`./sql/*.sql`),
 * selected on the writer at run time, never from a saved list. Items are
 * decided in that query's order. Media highlights clips are out of scope.
 *
 * PER ITEM. A row decided since the selection (or now refused by the route's
 * own guards: a sibling published meanwhile, a dismissal, an iD now on file, an
 * age hide) is SKIPPED, not failed. So is a row that no longer meets the strong
 * rule: inside its transaction, before the core runs, the job re-reads the row
 * and re-asserts the rule's row-level predicates (news: pending newsroom NAME
 * row, HIGH + TAG, snippet present, never touched by /edit, not a copy, no
 * other row on its source_ref; honors: pending, alone on its source_ref;
 * grant: pending, queue band, never decided or reopened, no active hide other
 * than `system-unverified`). A decision that would reject a sibling (the strong
 * rule says none exists) is rolled back and STOPS that queue, as does any
 * unexpected error. The remaining queues still run.
 *
 * RUNNING ETL. A queue whose own ETL has a `running` etl_run row from the last
 * 6 h sits out (HELD): ReporterGrants, HonorsLists (all-lists runs only; a
 * single-list run writes no row), ORCID-evidence. News has no such guard: its
 * ETL writes etl_run only on completion, so a running News reconcile is
 * invisible; the in-transaction re-check is what protects that queue.
 *
 * EXIT CODE, first match wins:
 *   2  bad arguments (nothing ran)
 *   1  a queue STOPPED (unexpected outcome or error)
 *   3  a queue was HELD by its running ETL: re-run it when the ETL finishes
 *   4  every write committed, but a refresh step failed (see the TALLY
 *      refresh line; the ISR TTL, nightly sweep and reconcilers backstop it)
 *   0  otherwise
 *
 * REFRESH, after the writes (this task has no Next runtime, so no
 * `revalidatePath`, and no CloudFront grant):
 *   - ISR: `POST /api/revalidate` for `/browse` and each touched profile, the
 *     path the nightly sweep uses (etl/revalidate).
 *   - CDN: ONE `/*` row on the `cdn_invalidation` outbox, as the nightly sweep
 *     enqueues; the cdn-reconcile machine sends it within ~5 min. One row per
 *     run rather than one per item keeps CloudFront from being flooded.
 *   - Search: grant confirms revoke suppressions, so their OpenSearch fast path
 *     (`reflectGrantSuppressions`) runs here, as the route runs it after the
 *     response; scholars-reconcile retries any miss from the NULL
 *     `search_reflected_at`. The other three queues have no search write in
 *     their routes either; the nightly index rebuild picks them up.
 * NOT refreshed: the app tasks' in-process `methods:` cache (the routes bust it
 * per task; these queues do not change what the methods rollup reads).
 *
 * Dry run by default: prints each queue's strong items and writes nothing.
 *
 *   npm run etl:bulk-confirm-strong -- [--apply --actor=<cwid>]
 *     [--queues=grant,honors,news,orcid] [--limit=N] [--pause-ms=N]
 *
 * `--limit` caps each queue. `--pause-ms` (default 100) spaces the items.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { enqueueEdgePurgeAll, requestRevalidate } from "@/etl/revalidate";
import { isCwid } from "@/lib/cwid";
import { db, disconnect } from "@/lib/db";
import {
  decideGrantReview,
  GrantAttributionRefused,
  SYSTEM_UNVERIFIED,
} from "@/lib/edit/grant-attribution-decision";
import { decideHonor } from "@/lib/edit/honor-decision";
import { decideNewsMention } from "@/lib/edit/news-mention-decision";
import { confirmPair, OrcidQueueRefused } from "@/lib/edit/orcid-queue.server";
import { reflectGrantSuppressions } from "@/lib/edit/search-suppression";
import { canonicalProfilePath } from "@/lib/profile-url";

export const QUEUES = ["grant", "honors", "news", "orcid"] as const;
export type QueueName = (typeof QUEUES)[number];

export type Args = {
  apply: boolean;
  queues: QueueName[];
  /** Most items decided per queue; null = all. */
  limit: number | null;
  /** The real person authorizing the run. Required with --apply. */
  actor: string | null;
  pauseMs: number;
};

/** Parse argv (after the script name). Throws a usage error on anything off. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, queues: [...QUEUES], limit: null, actor: null, pauseMs: 100 };
  for (const a of argv) {
    const [flag, value] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, null];
    if (flag === "--apply" && value === null) args.apply = true;
    else if (flag === "--dry-run" && value === null) args.apply = false;
    else if (flag === "--queues" && value) {
      const qs = value
        .split(",")
        .map((q) => q.trim())
        .filter(Boolean);
      const bad = qs.filter((q) => !(QUEUES as readonly string[]).includes(q));
      if (qs.length === 0 || bad.length > 0)
        throw new Error(`--queues: unknown ${bad.join(",") || "(empty)"}`);
      // Run order is fixed (QUEUES order), whatever order they were named in.
      args.queues = QUEUES.filter((q) => qs.includes(q));
    } else if (flag === "--limit" && value !== null) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--limit: expected a positive integer, got ${value}`);
      args.limit = n;
    } else if (flag === "--pause-ms" && value !== null) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`--pause-ms: expected an integer >= 0, got ${value}`);
      args.pauseMs = n;
    } else if (flag === "--actor" && value !== null) {
      const cwid = value.trim().toLowerCase();
      // A real person's CWID, never a synthetic `system-*` marker: the actor is
      // stamped as decided-by and audit actor, exactly as a curator's click is.
      if (!isCwid(cwid)) throw new Error(`--actor: not a CWID: ${value}`);
      args.actor = cwid;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (args.apply && !args.actor) {
    throw new Error("--apply needs --actor=<cwid>: the person authorizing this run");
  }
  return args;
}

/** One strong item, as selected. `key` is the id the core decides by. */
export type Candidate = {
  queue: QueueName;
  /** honor id, news_mention id, grant_attribution_review id, or `cwid|orcid`. */
  key: string;
  cwid: string;
  orcid?: string;
  /** A short human label for the log. */
  label: string;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** The verified LIST query for one queue (etl/bulk-confirm-strong/sql). */
export function strongSql(queue: QueueName): string {
  return readFileSync(path.join(__dirname, "sql", `${queue}.sql`), "utf8");
}

/** Map one LIST row to a Candidate. */
export function toCandidate(queue: QueueName, r: Row): Candidate {
  switch (queue) {
    case "grant":
      return {
        queue,
        key: str(r.review_id),
        cwid: str(r.cwid),
        label: `${str(r.core_project_num)} ${str(r.award_title)}`.trim(),
      };
    case "honors":
      return {
        queue,
        key: str(r.id),
        cwid: str(r.cwid),
        label: `${str(r.organization)} | ${str(r.name)} (${str(r.year) || "undated"}) [${str(r.evidence_kind)}]`,
      };
    case "news":
      return { queue, key: str(r.id), cwid: str(r.cwid), label: str(r.article_title) };
    case "orcid":
      return {
        queue,
        key: `${str(r.cwid)}|${str(r.orcid)}`,
        cwid: str(r.cwid),
        orcid: str(r.orcid),
        label: str(r.orcid),
      };
  }
}

type RawClient = { $queryRawUnsafe: <T = unknown>(sql: string) => Promise<T> };

/** Select one queue's strong items NOW, on `client` (the writer). */
export async function selectStrong(client: RawClient, queue: QueueName): Promise<Candidate[]> {
  const rows = await client.$queryRawUnsafe<Row[]>(strongSql(queue));
  return rows.map((r) => toCandidate(queue, r));
}

/** What one item came to. `done` carries what the refresh step needs. */
export type Outcome =
  | {
      kind: "done";
      cwids: string[];
      suppressions: Array<{ suppressionId: string; entityId: string }>;
    }
  | { kind: "skipped"; reason: string };

/** The decision would have done more than the strong rule allows. Thrown
 *  INSIDE the transaction so it rolls back; stops the queue. */
export class UnexpectedOutcome extends Error {}

type WriteCtx = { actor: string; requestId: string };
type TxRunner = { $transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T> };

/** Decide one item in its own transaction, through the route's core. Returns
 *  `skipped` for anything decided or refused since selection; throws on the
 *  unexpected. */
export async function decideOne(client: TxRunner, c: Candidate, ctx: WriteCtx): Promise<Outcome> {
  const base = { realCwid: ctx.actor, impersonatedCwid: null, requestId: ctx.requestId };
  try {
    return await client.$transaction(async (txAny: never): Promise<Outcome> => {
      // `never` keeps the runner mockable; the real one hands a TransactionClient.
      const tx = txAny as Parameters<typeof decideHonor>[0];
      const ts = new Date();
      switch (c.queue) {
        case "honors": {
          // A single-list HonorsLists run writes no etl_run row, so it can add a
          // competing row on this line after the selection. Re-asserted here.
          const cur = await tx.honor.findUnique({
            where: { id: c.key },
            select: { status: true, sourceRef: true },
          });
          if (!cur) return { kind: "skipped" as const, reason: "not_found" };
          if (cur.status !== "pending") return { kind: "skipped" as const, reason: "not_pending" };
          if (cur.sourceRef === null)
            return { kind: "skipped" as const, reason: "no_longer_strong" };
          const sharing = await tx.honor.count({
            where: { sourceRef: cur.sourceRef, id: { not: c.key } },
          });
          if (sharing > 0) return { kind: "skipped" as const, reason: "source_ref_shared" };
          const r = await decideHonor(tx, {
            ...base,
            id: c.key,
            decision: "approve",
            reason: null,
            ts,
          });
          if (r.kind !== "ok") return { kind: "skipped" as const, reason: r.kind };
          if (r.siblingsRejected !== 0) {
            throw new UnexpectedOutcome(
              `honor ${c.key} would reject ${r.siblingsRejected} sibling(s)`,
            );
          }
          return { kind: "done" as const, cwids: r.affectedCwids, suppressions: [] };
        }
        case "news": {
          // The core also approves a REJECTED row (the un-reject path); a bulk
          // run decides pending rows only. And the nightly News reconcile can
          // rewrite a pending row (likelihood, basis, snippet, group) after the
          // selection without leaving a running etl_run row, so the strong
          // rule's row-level predicates are re-asserted here, in the write.
          const cur = await tx.newsMention.findUnique({
            where: { id: c.key },
            select: {
              status: true,
              outlet: true,
              source: true,
              likelihood: true,
              matchBasis: true,
              contextSnippet: true,
              enteredByCwid: true,
              decisionId: true,
              duplicateOf: true,
              sourceRef: true,
            },
          });
          if (!cur) return { kind: "skipped" as const, reason: "not_found" };
          if (cur.status !== "pending") return { kind: "skipped" as const, reason: "not_pending" };
          if (
            cur.outlet !== null ||
            cur.source !== "NAME" ||
            cur.likelihood !== "HIGH" ||
            cur.matchBasis !== "TAG" ||
            cur.contextSnippet === null ||
            cur.enteredByCwid !== null ||
            cur.decisionId !== null ||
            cur.duplicateOf !== null ||
            cur.sourceRef === null
          ) {
            return { kind: "skipped" as const, reason: "no_longer_strong" };
          }
          const sharing = await tx.newsMention.count({
            where: { sourceRef: cur.sourceRef, id: { not: c.key } },
          });
          if (sharing > 0) return { kind: "skipped" as const, reason: "source_ref_shared" };
          const r = await decideNewsMention(tx, {
            ...base,
            mentionId: c.key,
            decision: "approve",
            reassignCwid: null,
            // Its own undo stamp per item, as one click would have.
            decisionId: randomUUID(),
            ts,
          });
          if (r.kind !== "ok") return { kind: "skipped" as const, reason: r.kind };
          if (r.siblingsRejected !== 0) {
            throw new UnexpectedOutcome(
              `news ${c.key} would reject ${r.siblingsRejected} sibling(s)`,
            );
          }
          return { kind: "done" as const, cwids: r.affectedCwids, suppressions: [] };
        }
        case "grant": {
          const row = await tx.grantAttributionReview.findUnique({ where: { id: c.key } });
          if (!row) return { kind: "skipped" as const, reason: "not_found" };
          if (row.status !== "pending") return { kind: "skipped" as const, reason: "not_pending" };
          // The strong rule's row-level predicates, re-asserted in the write: a
          // rescore or a curator can change them after the selection.
          if (row.band !== "queue" || row.decidedByCwid !== null || row.reopenedAt !== null) {
            return { kind: "skipped" as const, reason: "no_longer_strong" };
          }
          // Confirm revokes `system-unverified` hides only as a side effect of
          // the decision; any other active hide (a curator's, the age rule's)
          // means the rule no longer holds.
          const hides = await tx.suppression.findMany({
            where: { entityType: "grant", entityId: row.grantExternalId, revokedAt: null },
            select: { createdBy: true },
          });
          if (hides.some((s) => s.createdBy !== SYSTEM_UNVERIFIED)) {
            return { kind: "skipped" as const, reason: "other_hide_active" };
          }
          const r = await decideGrantReview(tx, row, {
            ...base,
            decision: "confirm",
            reason: null,
            ts,
          });
          return { kind: "done" as const, cwids: [row.cwid], suppressions: r.suppressions };
        }
        case "orcid": {
          const orcid = c.orcid ?? "";
          // confirmPair does not check this; the strong rule does. Re-checked so
          // one iD can never land on two scholars.
          const held = await tx.scholar.findFirst({
            where: { orcid, cwid: { not: c.cwid } },
            select: { cwid: true },
          });
          if (held) return { kind: "skipped" as const, reason: "held_by_other" };
          await confirmPair(
            tx,
            { cwid: c.cwid, orcid },
            { actor: ctx.actor, impersonatedCwid: null, requestId: ctx.requestId, ts },
          );
          return { kind: "done" as const, cwids: [c.cwid], suppressions: [] };
        }
      }
    });
  } catch (err) {
    // The routes' own refusals (409/404): decided or changed since selection.
    if (err instanceof GrantAttributionRefused || err instanceof OrcidQueueRefused) {
      return { kind: "skipped", reason: err.code };
    }
    throw err;
  }
}

export type QueueTally = {
  queue: QueueName;
  selected: number;
  decided: number;
  skipped: Record<string, number>;
  stopped: string | null;
  /** Etl run in progress that made this queue sit out, if any. */
  heldBy: string | null;
};

/** The ETL whose `running` etl_run row holds each queue. Null where the ETL
 *  writes no running row (News records etl_run only on completion), so a
 *  guard on it could never fire; that queue relies on the in-transaction
 *  re-check in `decideOne`. HonorsLists writes one on all-lists runs only. */
const QUEUE_ETL: Record<QueueName, string | null> = {
  grant: "ReporterGrants",
  honors: "HonorsLists",
  news: null,
  orcid: "ORCID-evidence",
};

export type Deps = {
  write: RawClient &
    TxRunner & {
      etlRun: {
        findFirst: (a: {
          where: { source: string; status: string; startedAt: { gt: Date } };
          select: { startedAt: true };
        }) => Promise<{ startedAt: Date } | null>;
      };
      scholar: {
        findMany: (a: {
          where: { cwid: { in: string[] } };
          select: { slug: true };
        }) => Promise<Array<{ slug: string }>>;
      };
    };
  /** Resolves false when the revalidate did not land (the helper swallows errors). */
  revalidate: (path: string) => Promise<boolean>;
  /** Resolves false when the outbox row was not written. */
  enqueuePurgeAll: () => Promise<boolean>;
  reflectGrants: (
    rows: Array<{ suppressionId: string; entityId: string }>,
  ) => Promise<ReadonlyArray<{ ok: boolean }>>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
};

/** What the post-commit refresh came to. Null when nothing needed one. */
export type RefreshTally = {
  /** /browse + profile revalidates that did not land (or could not be listed). */
  revalidateFailed: number;
  revalidateTotal: number;
  /** The one CDN outbox row was not written. */
  purgeFailed: boolean;
  /** Grant suppressions not reflected to search. */
  reflectFailed: number;
  reflectTotal: number;
};

export type RunResult = { tallies: QueueTally[]; refresh: RefreshTally | null };

export function refreshFailed(r: RefreshTally | null): boolean {
  return !!r && (r.revalidateFailed > 0 || r.purgeFailed || r.reflectFailed > 0);
}

/** The process exit code for a finished run; see the file docblock. */
export function exitCodeFor(r: RunResult): number {
  if (r.tallies.some((t) => t.stopped)) return 1;
  if (r.tallies.some((t) => t.heldBy)) return 3;
  if (refreshFailed(r.refresh)) return 4;
  return 0;
}

/** Run the job. Never writes without `args.apply`. */
export async function runBulkConfirm(args: Args, deps: Deps): Promise<RunResult> {
  const { write, log } = deps;
  const requestId = `bulk-strong-${deps.now().toISOString()}`;
  log(
    `bulk-confirm-strong ${args.apply ? "APPLY" : "DRY RUN"} queues=${args.queues.join(",")}` +
      `${args.limit ? ` limit=${args.limit}` : ""}${args.apply ? ` actor=${args.actor} requestId=${requestId}` : ""}`,
  );
  const tallies: QueueTally[] = [];
  const touched = new Set<string>();
  const suppressions: Array<{ suppressionId: string; entityId: string }> = [];
  let refreshTally: RefreshTally | null = null;

  try {
    for (const queue of args.queues) {
      const tally: QueueTally = {
        queue,
        selected: 0,
        decided: 0,
        skipped: {},
        stopped: null,
        heldBy: null,
      };
      tallies.push(tally);

      let all: Candidate[];
      try {
        // The queue's own ETL rewrites these rows (the weekly ORCID evidence run
        // replaces its table outright). Sit it out rather than race it.
        const etl = QUEUE_ETL[queue];
        if (args.apply && etl) {
          const since = new Date(deps.now().getTime() - 6 * 3600 * 1000);
          const running = await write.etlRun.findFirst({
            where: { source: etl, status: "running", startedAt: { gt: since } },
            select: { startedAt: true },
          });
          if (running) {
            tally.heldBy = `${etl} running since ${running.startedAt.toISOString()}`;
            log(`[${queue}] SKIPPED: ${tally.heldBy}; re-run when it finishes`);
            continue;
          }
        }
        all = await selectStrong(write, queue);
      } catch (err) {
        tally.stopped = `selection failed: ${err instanceof Error ? err.message : String(err)}`;
        log(`[${queue}] STOPPED: ${tally.stopped}`);
        continue;
      }
      const items = args.limit ? all.slice(0, args.limit) : all;
      tally.selected = all.length;
      log(
        `[${queue}] ${all.length} strong${args.limit && all.length > items.length ? `, deciding the first ${items.length}` : ""}`,
      );
      if (!args.apply) {
        for (const c of items)
          log(
            `[${queue}] would ${queue === "honors" || queue === "news" ? "approve" : "confirm"} ${c.key} cwid=${c.cwid} ${c.label}`,
          );
        continue;
      }

      for (const c of items) {
        let out: Outcome;
        try {
          out = await decideOne(write, c, { actor: args.actor!, requestId });
        } catch (err) {
          tally.stopped = `${c.key}: ${err instanceof Error ? err.message : String(err)}`;
          log(`[${queue}] STOPPED at ${tally.stopped}`);
          break;
        }
        if (out.kind === "skipped") {
          tally.skipped[out.reason] = (tally.skipped[out.reason] ?? 0) + 1;
          log(`[${queue}] skip ${c.key} cwid=${c.cwid}: ${out.reason}`);
        } else {
          tally.decided++;
          for (const cwid of out.cwids) touched.add(cwid);
          suppressions.push(...out.suppressions);
          log(
            `[${queue}] ${queue === "honors" || queue === "news" ? "approved" : "confirmed"} ${c.key} cwid=${c.cwid}`,
          );
        }
        if (args.pauseMs > 0) await deps.sleep(args.pauseMs);
      }
    }
  } finally {
    // Refresh whatever was committed, even when a queue stopped.
    if (args.apply && touched.size > 0)
      refreshTally = await refresh(deps, [...touched], suppressions);
  }

  for (const t of tallies) {
    const skipped =
      Object.entries(t.skipped)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "none";
    log(
      `TALLY ${t.queue}: selected=${t.selected} decided=${t.decided} skipped: ${skipped}` +
        `${t.heldBy ? ` HELD: ${t.heldBy}` : ""}${t.stopped ? ` STOPPED: ${t.stopped}` : ""}`,
    );
  }
  if (refreshTally) {
    const r = refreshTally;
    // The writes above are committed whatever this line says.
    log(
      `TALLY refresh: ${refreshFailed(r) ? "FAILED" : "ok"} (writes committed)` +
        ` revalidate=${r.revalidateTotal - r.revalidateFailed}/${r.revalidateTotal}` +
        ` cdn_purge=${r.purgeFailed ? "FAILED" : "enqueued"}` +
        ` search_reflect=${r.reflectTotal - r.reflectFailed}/${r.reflectTotal}`,
    );
  }
  return { tallies, refresh: refreshTally };
}

/** Post-commit refresh outside Next; see the file docblock. Best-effort: a
 *  failed step is logged and counted, never thrown, so it cannot hide the
 *  committed writes. */
async function refresh(
  deps: Deps,
  cwids: string[],
  suppressions: Array<{ suppressionId: string; entityId: string }>,
): Promise<RefreshTally> {
  const { log } = deps;
  const t: RefreshTally = {
    revalidateFailed: 0,
    revalidateTotal: 0,
    purgeFailed: false,
    reflectFailed: 0,
    reflectTotal: suppressions.length,
  };
  const landed = async (p: Promise<boolean>): Promise<boolean> => {
    try {
      return await p;
    } catch {
      return false;
    }
  };

  let paths: string[];
  try {
    const scholars = await deps.write.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: { slug: true },
    });
    paths = ["/browse", ...scholars.map((s) => canonicalProfilePath(s.slug))];
  } catch (err) {
    // The profiles cannot be listed: count each touched one as missed.
    log(`[refresh] could not list touched profiles: ${String(err)}`);
    paths = ["/browse"];
    t.revalidateTotal += cwids.length;
    t.revalidateFailed += cwids.length;
  }
  for (const p of paths) {
    t.revalidateTotal++;
    if (!(await landed(deps.revalidate(p)))) {
      t.revalidateFailed++;
      log(`[refresh] revalidate ${p} did not land`);
    }
  }
  log(
    `[refresh] revalidated ${t.revalidateTotal - t.revalidateFailed}/${t.revalidateTotal} path(s)` +
      `${t.revalidateFailed ? " (the 6h ISR TTL and the nightly sweep still cover the rest)" : ""}`,
  );

  t.purgeFailed = !(await landed(deps.enqueuePurgeAll()));
  log(`[refresh] CDN /* purge ${t.purgeFailed ? "NOT enqueued" : "enqueued"}`);

  if (suppressions.length > 0) {
    try {
      const results = await deps.reflectGrants(suppressions);
      t.reflectFailed = suppressions.length - results.filter((r) => r.ok).length;
    } catch (err) {
      log(`[refresh] search reflect threw: ${String(err)}`);
      t.reflectFailed = suppressions.length;
    }
    log(
      `[refresh] reflected ${t.reflectTotal - t.reflectFailed}/${t.reflectTotal} grant suppression(s) to search` +
        `${t.reflectFailed ? " (scholars-reconcile retries the rest)" : ""}`,
    );
  }
  return t;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "usage: etl:bulk-confirm-strong -- [--apply --actor=<cwid>] [--queues=grant,honors,news,orcid] [--limit=N] [--pause-ms=N]",
    );
    return 2;
  }
  const result = await runBulkConfirm(args, {
    write: db.write as unknown as Deps["write"],
    revalidate: requestRevalidate,
    enqueuePurgeAll: enqueueEdgePurgeAll,
    reflectGrants: reflectGrantSuppressions,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    now: () => new Date(),
  });
  return exitCodeFor(result);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .then(async (code) => {
      await disconnect();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await disconnect();
      process.exit(1);
    });
}
