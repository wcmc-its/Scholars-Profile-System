/**
 * ORCID push — SPS → WCM Identity, through the ReCiter engine API.
 *
 * `scholar.orcid` is SPS's belief about a person's ORCID iD, from either of
 * two writers: the WCM Identity table (etl/identity) or the person confirming
 * it in `/edit` (which also stamps `orcid_confirmed_at`). Identity is the
 * AUTHORITY — ReCiter's retrieval and Publication Manager read it there — but
 * today it cannot hold a value: the Institutional Client's nightly rebuild PUTs
 * every WCM identity with `orcid: null` (IC #155), which is how it erased RPM's
 * 2026-04 bulk load. Until that fix ships, the durable record of a confirmation
 * is SPS's own row, and this step copies it back into Identity every night.
 *
 * Compare-then-write, per scholar, sequentially:
 *   - every active scholar with a non-null `orcid` (whichever writer set it):
 *     GET the Identity record; no record → `no_identity`; same iD → `equal`;
 *     else set `orcid` on the record and POST it back → `pushed`.
 *     DELIBERATE WIDENING of the spec/handoff's "every scholar with
 *     `orcid_confirmed_at` set": an Identity-sourced value SPS still holds is
 *     re-healed after the IC wipe too, and the step stays a pure mirror of
 *     `scholar.orcid` (one writer of that column in Identity, not two rules).
 *   - every `orcid_dismissal` row ("Not me" / Remove in SPS): GET the record;
 *     if Identity still holds exactly the dismissed iD → set it null and POST
 *     → `cleared`; anything else → `skip` (a different iD there is someone
 *     else's write, not ours to undo).
 *   - a target whose (cwid, orcid) ALSO has a dismissal row is a contradiction
 *     (the person said "Not me" to the iD SPS holds): the target is dropped
 *     (never pushed) and the dismissal kept, so Identity ends up without it.
 *     Counted as `contradiction` in the log; without this the same night both
 *     pushed X and cleared X — two POSTs per person, forever.
 * Idempotent by construction, so it can run forever: a night the IC wipes the
 * value is a night this pushes it again, and once the IC preserves it every
 * row reads `equal`. The POST sends the GET result back with only `orcid`
 * changed — nothing else on the record is modelled or touched.
 *
 * Fails LOUD on a dead API. Any GET/POST failure is counted and the loop
 * continues, but at the end the run throws (a failed EtlRun, non-zero exit,
 * the nightly's continue-tier Catch) when there was work and none of it could
 * be checked, or more than max(2, 10%) of the checks failed. A run that could
 * not reach ReCiter must never grade green on /edit/etl-status. An EMPTY
 * action set (no iD on file anywhere, no dismissals — prod today) is a green
 * 0-row success, not an alarm: the API was never needed.
 *
 * Runs ONLY on the `sps-etl-reciter-api-<env>` task family — the one that
 * carries the ReCiter ADMIN key (`scholars/<env>/reciter-api` → RECITER_API_*),
 * kept off the web tier and every other cadence def (#746, #1508). Without the
 * key this throws rather than silently doing nothing.
 *
 * `--dry-run` / `ORCID_PUSH_DRY_RUN=1`: GETs only, no POSTs; prints what would
 * change as counts + cwids (never names, never the iDs).
 *
 * Usage: `npm run etl:orcid-push` (nightly step OrcidPush, right BEFORE Identity —
 * push-then-pull, so the pull never mistakes our own last push for a foreign
 * change and reverts a confirmation; see the step comment in cdk/lib/etl-stack.ts).
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import {
  getIdentityByUid,
  reciterApiConfig,
  saveIdentity,
  type ReciterApiConfig,
  type ReciterIdentity,
} from "@/lib/reciter/client";

/** Gap between consecutive ReCiter calls; the confirmed set is small, be polite. */
const CALL_GAP_MS = 100;

/** One unit of work: an iD SPS holds (push it) or one the person dismissed (clear it). */
export type PushAction =
  | { kind: "target"; cwid: string; orcid: string }
  | { kind: "dismissal"; cwid: string; orcid: string };

export type PushOutcome = "equal" | "pushed" | "cleared" | "skip" | "no_identity";

export type PushCounts = Record<PushOutcome | "failed" | "checked", number>;

/**
 * Pure: what to do with one action given the Identity record ReCiter returned
 * (`null` = 404, no record). `save`, when present, is the exact object to POST
 * back — the fetched record with only `orcid` changed.
 */
export function decide(
  action: PushAction,
  identity: ReciterIdentity | null,
): { outcome: PushOutcome; save?: ReciterIdentity } {
  const held = typeof identity?.orcid === "string" ? identity.orcid.trim() : null;
  if (action.kind === "target") {
    if (!identity) return { outcome: "no_identity" };
    if (held === action.orcid) return { outcome: "equal" };
    return { outcome: "pushed", save: { ...identity, orcid: action.orcid } };
  }
  // dismissal: only undo OUR iD; a different value there is someone else's write.
  if (!identity || held !== action.orcid) return { outcome: "skip" };
  return { outcome: "cleared", save: { ...identity, orcid: null } };
}

/**
 * Pure: the action list from the two DB reads. Targets first, then dismissals
 * (so a person with target Y + dismissal X gets Y pushed, then X read as
 * "different, skip"). A target whose exact (cwid, orcid) pair is also
 * dismissed is a contradiction and is DROPPED — the dismissal is the person's
 * word, the target is a stale row (e.g. re-imported before the identity ETL
 * learned about dismissals) — and counted so the log shows it.
 */
export function buildActions(
  targets: ReadonlyArray<{ cwid: string; orcid: string }>,
  dismissals: ReadonlyArray<{ cwid: string; orcid: string }>,
): { actions: PushAction[]; contradictions: string[] } {
  // Identity uids are lowercase cwids; scholar.cwid is too (10,814/10,815), lowercase anyway.
  const key = (cwid: string, orcid: string) => `${cwid.toLowerCase()}\u0000${orcid}`;
  const dismissedKeys = new Set(dismissals.map((d) => key(d.cwid, d.orcid)));
  const contradictions: string[] = [];
  const actions: PushAction[] = [];
  for (const t of targets) {
    const cwid = t.cwid.toLowerCase();
    if (dismissedKeys.has(key(cwid, t.orcid))) {
      contradictions.push(cwid);
      continue;
    }
    actions.push({ kind: "target", cwid, orcid: t.orcid });
  }
  for (const d of dismissals) {
    actions.push({ kind: "dismissal", cwid: d.cwid.toLowerCase(), orcid: d.orcid });
  }
  return { actions, contradictions };
}

/**
 * Pure: whether the run must fail. `checked` = actions whose GET returned an
 * answer (a record or a 404); `failed` = GETs/POSTs that threw; `actions` =
 * how many there were to do. Work to do and zero checked = a dead API → fail.
 * Nothing to do (`actions === 0`) = a green 0-row success — the API was never
 * needed, and a standing red on an empty set would be a false alarm.
 */
export function exceedsFailureThreshold(checked: number, failed: number, actions: number): boolean {
  if (actions === 0) return false;
  if (checked === 0) return true;
  return failed > Math.max(2, checked * 0.1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sequential GET → decide → (POST) over every action; the counters, plus the cwids that changed. */
export async function runActions(
  actions: readonly PushAction[],
  config: ReciterApiConfig,
  opts: { dryRun: boolean; gapMs?: number },
): Promise<{ counts: PushCounts; changed: string[] }> {
  const counts: PushCounts = {
    checked: 0,
    equal: 0,
    pushed: 0,
    cleared: 0,
    skip: 0,
    no_identity: 0,
    failed: 0,
  };
  const changed: string[] = [];
  let first = true;
  for (const action of actions) {
    if (!first) await sleep(opts.gapMs ?? CALL_GAP_MS);
    first = false;
    let identity: ReciterIdentity | null;
    try {
      identity = await getIdentityByUid(config, action.cwid);
    } catch (err) {
      counts.failed += 1;
      console.warn(`orcid-push: GET failed for ${action.cwid}: ${errMessage(err)}`);
      continue;
    }
    counts.checked += 1;
    const d = decide(action, identity);
    if (!d.save) {
      counts[d.outcome] += 1;
      continue;
    }
    if (opts.dryRun) {
      counts[d.outcome] += 1;
      changed.push(action.cwid);
      continue;
    }
    try {
      await saveIdentity(config, d.save);
      counts[d.outcome] += 1;
      changed.push(action.cwid);
    } catch (err) {
      counts.failed += 1;
      console.warn(`orcid-push: POST failed for ${action.cwid}: ${errMessage(err)}`);
    }
  }
  return { counts, changed };
}

/** The error text without ever echoing a request (the key travels in a header, never in the URL or body). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<number> {
  const config = reciterApiConfig();
  if (!config) {
    throw new Error(
      "ReCiter API not configured (RECITER_API_BASE_URL / RECITER_API_KEY) — this step runs only on the reciter-api task family",
    );
  }
  const dryRun = process.argv.includes("--dry-run") || process.env.ORCID_PUSH_DRY_RUN === "1";

  const targets = await db.write.scholar.findMany({
    where: { deletedAt: null, orcid: { not: null } },
    select: { cwid: true, orcid: true },
    orderBy: { cwid: "asc" },
  });
  const dismissals = await db.write.orcidDismissal.findMany({
    select: { cwid: true, orcid: true },
    orderBy: [{ cwid: "asc" }, { orcid: "asc" }],
  });
  const { actions, contradictions } = buildActions(
    targets.map((s) => ({ cwid: s.cwid, orcid: s.orcid as string })),
    dismissals,
  );
  console.log(
    `orcid-push${dryRun ? " (DRY RUN)" : ""}: ${targets.length} scholar(s) with an iD on file, ${dismissals.length} dismissal(s), ` +
      `${contradictions.length} contradiction(s) (iD on file that the person dismissed — not pushed).`,
  );
  if (contradictions.length > 0) {
    // cwids only, never the iDs; the fix is on the scholar row (clear the dismissed iD).
    console.warn(`orcid-push: scholar.orcid equals a dismissed iD for: ${contradictions.join(", ")}`);
  }

  const { counts, changed } = await runActions(actions, config, { dryRun });

  console.log(
    `orcid-push${dryRun ? " (DRY RUN — no POSTs sent)" : ""} complete: ${counts.checked} checked, ` +
      `${counts.equal} equal, ${counts.pushed} ${dryRun ? "would push" : "pushed"}, ` +
      `${counts.cleared} ${dryRun ? "would clear" : "cleared"}, ${counts.skip} skip, ` +
      `${counts.no_identity} no_identity, ${counts.failed} failed.`,
  );
  if (dryRun && changed.length > 0) {
    console.log(`orcid-push (DRY RUN) would change: ${changed.join(", ")}`);
  }

  if (exceedsFailureThreshold(counts.checked, counts.failed, actions.length)) {
    throw new Error(
      counts.checked === 0
        ? `orcid-push checked 0 identities (${actions.length} action(s), ${counts.failed} failed) — the ReCiter API is unreachable`
        : `orcid-push: ${counts.failed} of ${counts.checked + counts.failed} ReCiter call(s) failed — over the max(2, 10%) threshold`,
    );
  }
  return counts.pushed + counts.cleared;
}

// Run only when invoked directly (`npm run etl:orcid-push` / the nightly task) — the module
// is also imported by its unit test for the pure decide + threshold.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  withEtlRun("ORCID-push", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
