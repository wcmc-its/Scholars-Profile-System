"use client";

/**
 * ORCID queue — Bulk review (`/edit/orcid-queue`, the "Bulk review" mode).
 *
 * Lists every unassigned scholar in the current view who qualifies under an
 * adjustable rule (`bulkEligible`). The fixed part: Strong, no competitor, name
 * agrees, nothing on file, no decision on file, and for WCM one of two routes through the
 * floor (`bulkRoutes`): the ORCID record (3+ shared works and an institution
 * match) or the bylines (the iD printed on 2+ of the scholar's accepted papers,
 * uncontested). The adjustable part (`OrcidBulkRuleControls`, set in the page's
 * filter row): one candidate iD, which route, shared works, works only on
 * ORCID. Only pairs that also pass the server's floor
 * (`assertBulkConfirmable`, asked once via a `dryRun` post) are listed. Cornell
 * Ithaca rows (Affiliation Manager and web-page pairs, and email-verified ones)
 * skip the WCM controls and are capped at `ORCID_BULK_ITHACA_MAX` per batch: the
 * rest wait, unchecked, for the next one. "Why the rest don't match" counts
 * everyone else in the view by the first check they fail. Each row can be
 * unchecked; a row with any work only on ORCID is tinted so it gets a look
 * first. "Confirm N iDs" asks once more, then
 * posts in chunks of `ORCID_BULK_MAX` to `POST /api/edit/orcid-queue/bulk-confirm`,
 * which re-checks the fixed part per pair and skips anything that no longer
 * qualifies. The page's toast offers Undo for the whole batch.
 */
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  bulkBlocker,
  bulkEligible,
  bulkRoutes,
  inBulkBand,
  isOrcidBulkBlocker,
  isOrcidCandidateSource,
  ORCID_BULK_BLOCKER_LABEL,
  ORCID_BULK_ITHACA_MAX,
  ORCID_BULK_MAX,
  ORCID_BULK_ROUTE_LABEL,
  ORCID_BULK_ROUTES,
  ORCID_BULK_RULE_DEFAULT,
  ORCID_QUEUE_BAND_LABEL,
  ORCID_SOURCE_LABEL,
  onlyOnOrcid,
  type OrcidBulkRoute,
  type OrcidBulkRule,
  type OrcidQueueSummary,
} from "@/lib/edit/orcid-queue";
import { cn } from "@/lib/utils";

import { postBatch } from "@/components/edit/orcid-queue-api";

type Pair = { cwid: string; orcid: string };
type Result = Pair & { ok: boolean; code?: string };
/** A dry run's extras: `bulkPairFacts` for a pair that passed, else why it failed. */
type DryResult = Result & {
  orcidName?: string | null;
  verifiedEmail?: boolean;
  /** Scholars holds publications for this person, so works can be compared. */
  hasPublications?: boolean;
  blocker?: string;
};

const PAGE = 100;
/** Dry-run batches in flight at once (the server checks 4 pairs at a time each). */
const DRY_RUN_IN_FLIGHT = 3;
/** The fixed client floor only: the adjustable rule at its loosest. */
const ANY_RULE: OrcidBulkRule = { minShared: 0, maxOnlyOrcid: 10_000, allowMultiple: true };
const keyOf = (s: OrcidQueueSummary) => `${s.cwid}|${s.candidates[0]!.orcid}`;
const fmt = (n: number) => n.toLocaleString("en-US");

export function OrcidBulkReview({
  list,
  rule,
  needEmail,
  outcomes,
  canDecide,
  onConfirmed,
  onError,
  onCount,
}: {
  /** The page's list under the current filters (unassigned scholars). */
  list: OrcidQueueSummary[];
  /** The rule and the Cornell Ithaca email box, set in the filter row
   *  (`OrcidBulkRuleControls`). */
  rule: OrcidBulkRule;
  needEmail: boolean;
  /** Decisions made on this page (`cwid|orcid` keys): decided scholars drop out. */
  outcomes: Record<string, string>;
  canDecide: boolean;
  onConfirmed: (confirmed: Pair[], skipped: number) => void;
  onError: (message: string) => void;
  /** The match count once the server check is in, for the mode toggle. */
  onCount?: (n: number) => void;
}) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  // "Confirm N" is asked once more, for the rule as it stood: a changed rule asks again.
  const ruleKey = JSON.stringify([rule, needEmail]);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const asking = askedFor === ruleKey;
  const setAsking = (on: boolean) => setAskedFor(on ? ruleKey : null);
  const [progress, setProgress] = useState<string | null>(null);

  // The server's floor (`assertBulkConfirmable`, the etl:bulk-confirm-strong
  // rule) needs facts the summary doesn't carry, so ask it which pairs pass
  // (dry run, writes nothing) and list only those. null = still checking.
  const [floor, setFloor] = useState<ReadonlyMap<string, DryResult> | null>(null);
  const floorKeys = useMemo(
    () =>
      list
        .filter((s) => bulkEligible(s, ANY_RULE))
        .map(keyOf)
        .sort()
        .join(","),
    [list],
  );
  useEffect(() => {
    if (!canDecide) return;
    let live = true;
    setFloor(null);
    (async () => {
      const pairs = floorKeys ? floorKeys.split(",").map((k) => k.split("|")) : [];
      const seen = new Map<string, DryResult>();
      const batches: string[][][] = [];
      for (let i = 0; i < pairs.length; i += ORCID_BULK_MAX)
        batches.push(pairs.slice(i, i + ORCID_BULK_MAX));
      // A few batches in flight at once (~30 batches of 100 in prod); the first
      // failure stops the rest.
      let next = 0;
      let failed = false;
      const worker = async () => {
        while (live && !failed && next < batches.length) {
          const batch = batches[next++]!;
          const r = await postBatch<DryResult>("/api/edit/orcid-queue/bulk-confirm", {
            dryRun: true,
            pairs: batch.map(([cwid, orcid]) => ({ cwid, orcid })),
            rule: ANY_RULE,
          });
          if (!live || failed) return;
          if (!r.ok) {
            failed = true;
            onError(r.message);
            return;
          }
          for (const x of r.results) seen.set(`${x.cwid}|${x.orcid}`, x);
        }
      };
      await Promise.all(Array.from({ length: DRY_RUN_IN_FLIGHT }, worker));
      if (live) setFloor(seen);
    })();
    return () => {
      live = false;
    };
    // onError is a fresh closure each render; the check only reruns on the pairs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorKeys, canDecide]);

  // Every undecided scholar in the view either matches or is counted once under
  // the first check they fail: the fixed rule, then the server's floor, then the
  // boxes the librarian checked.
  const { eligible, inBand, why } = useMemo(() => {
    const eligible: OrcidQueueSummary[] = [];
    const why = new Map<string, number>();
    let inBand = 0;
    for (const s of list) {
      if (s.candidates.some((c) => outcomes[`${s.cwid}|${c.orcid}`])) continue;
      if (inBulkBand(s)) inBand += 1;
      const blocker = bulkBlocker(s, ANY_RULE);
      const f = blocker ? undefined : floor?.get(keyOf(s));
      // What the librarian's own settings rule out: more than one iD, the route or
      // a threshold.
      const mine = bulkBlocker(s, rule);
      const emailOk = !needEmail || s.campus !== "ithaca" || !!f?.verifiedEmail;
      if (f?.ok && !mine && emailOk) {
        eligible.push(s);
        continue;
      }
      const label =
        blocker === "band"
          ? `${ORCID_QUEUE_BAND_LABEL[s.candidates[0]!.band]}: reviewed one at a time`
          : blocker
            ? ORCID_BULK_BLOCKER_LABEL[blocker]
            : f?.ok
              ? mine && mine !== "band"
                ? ORCID_BULK_BLOCKER_LABEL[mine]
                : "Cornell Ithaca, no verified email on the ORCID record"
              : isOrcidBulkBlocker(f?.blocker)
                ? ORCID_BULK_BLOCKER_LABEL[f.blocker]
                : "No longer qualifies: reload the page";
      why.set(label, (why.get(label) ?? 0) + 1);
    }
    return { eligible, inBand, why: [...why].sort((a, b) => b[1] - a[1]) };
  }, [list, rule, outcomes, floor, needEmail]);
  const hasIthaca = useMemo(() => list.some((s) => s.campus === "ithaca"), [list]);
  useEffect(() => {
    if (floor) onCount?.(eligible.length);
    // onCount is a fresh closure each render; report only when the count moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible.length, floor]);
  // Cornell Ithaca: at most ORCID_BULK_ITHACA_MAX per batch; the rest wait.
  const overCap = useMemo(() => {
    const ithaca = eligible.filter((s) => s.campus === "ithaca" && !excluded.has(s.cwid));
    return new Set(ithaca.slice(ORCID_BULK_ITHACA_MAX).map((s) => s.cwid));
  }, [eligible, excluded]);
  const selected = eligible.filter((s) => !excluded.has(s.cwid) && !overCap.has(s.cwid));
  // No publications here = every work is "only on ORCID": nothing to compare, so
  // never tinted. Read per person, not per campus (Ithaca publications will come).
  const compared = (s: OrcidQueueSummary) => floor?.get(keyOf(s))?.hasPublications !== false;
  const tinted = (s: OrcidQueueSummary) => compared(s) && onlyOnOrcid(s.candidates[0]!) > 0;
  const anyNotCompared = eligible.some((s) => !compared(s));
  const tintedChecked = selected.filter(tinted).length;
  const ithacaSelected = selected.filter((s) => s.campus === "ithaca").length;
  const busy = progress !== null;

  const toggle = (cwid: string) =>
    setExcluded((x) => {
      const next = new Set(x);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });

  const allOn = selected.length === eligible.length - overCap.size && eligible.length > 0;

  async function confirmAll() {
    const pairs: Pair[] = selected.map((s) => ({ cwid: s.cwid, orcid: s.candidates[0]!.orcid }));
    const done: Pair[] = [];
    let skipped = 0;
    for (let i = 0; i < pairs.length; i += ORCID_BULK_MAX) {
      setProgress(
        `Confirming ${fmt(Math.min(i + ORCID_BULK_MAX, pairs.length))} of ${fmt(pairs.length)}…`,
      );
      const r = await postBatch<Result>("/api/edit/orcid-queue/bulk-confirm", {
        pairs: pairs.slice(i, i + ORCID_BULK_MAX),
        rule,
      });
      if (!r.ok) {
        onError(r.message);
        break;
      }
      for (const x of r.results) {
        if (x.ok) done.push({ cwid: x.cwid, orcid: x.orcid });
        else skipped += 1;
      }
    }
    setProgress(null);
    setAsking(false);
    setExcluded(new Set());
    if (done.length > 0 || skipped > 0) onConfirmed(done, skipped);
  }

  const bands = hasIthaca ? "Strong or Email verified" : "Strong";
  return (
    <div className="flex flex-col gap-4" data-testid="orcid-bulk">
      <section
        aria-label="Bulk confirm rule"
        className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-[var(--apollo-radius-card)] border px-5 py-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium" data-testid="orcid-bulk-heading">
            Confirm {hasIthaca ? "Strong and Email verified" : "Strong"} matches that meet the
            settings above
          </span>
          <span className="text-muted-foreground text-[13px]" data-testid="orcid-bulk-count">
            <span className="text-foreground font-semibold">{fmt(eligible.length)}</span> of{" "}
            {fmt(inBand)} {bands} {inBand === 1 ? "scholar matches" : "scholars match"}
          </span>
        </div>
        <span className="text-muted-foreground text-[12.5px]">
          Passes by: ORCID record means 3 or more shared works and a Cornell or WCM affiliation or
          email on the record; Bylines means the iD is printed on 2 or more of the scholar&rsquo;s
          accepted papers and nothing contests it. Shared works at least narrows the ORCID record
          route only. Only on ORCID counts works on the ORCID record that aren&rsquo;t in this
          person&rsquo;s publications here. Rows with any are tinted: make sure those works are
          theirs before confirming.
          {anyNotCompared
            ? " Not compared means Scholars has no publications for this person yet."
            : null}{" "}
          Anything you uncheck stays in the one-at-a-time queue.
          {rule.allowMultiple
            ? " With One candidate iD off, a scholar's best iD is confirmed and their other iDs stay in the queue under Different iD on file."
            : null}
          {hasIthaca
            ? " One candidate iD, Passes by, shared works and only on ORCID apply to WCM scholars only."
            : null}
        </span>
        {floor && why.length > 0 ? (
          <details
            key={eligible.length === 0 ? "none" : "some"}
            open={eligible.length === 0}
            className="text-[13px]"
            data-testid="orcid-bulk-why"
          >
            <summary className="text-apollo-slate cursor-pointer">
              Why the other {fmt(why.reduce((n, [, k]) => n + k, 0))} in this view don&rsquo;t match
            </summary>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {why.map(([label, n]) => (
                <li key={label} className="flex gap-3">
                  <span className="w-14 shrink-0 text-right font-semibold tabular-nums">
                    {fmt(n)}
                  </span>
                  <span className="text-muted-foreground min-w-0">{label}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {canDecide && floor === null ? (
        <p className="text-muted-foreground m-0 text-[14px]" data-testid="orcid-bulk-checking">
          Checking which scholars qualify…
        </p>
      ) : eligible.length === 0 ? (
        <p className="text-muted-foreground m-0 text-[14px]" data-testid="orcid-bulk-empty">
          No scholars in this view match the rule.
        </p>
      ) : (
        <div
          role="table"
          aria-label="Matches for bulk confirm"
          className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-[var(--apollo-radius-card)] border"
        >
          <div className="min-w-[960px]">
            <div
              role="row"
              className={cn(
                GRID,
                "bg-apollo-surface-2 text-muted-foreground py-2.5 text-[11.5px] font-semibold tracking-[0.08em] uppercase",
              )}
            >
              <span role="columnheader">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={() =>
                    setExcluded(allOn ? new Set(eligible.map((s) => s.cwid)) : new Set())
                  }
                  aria-label="Include every match"
                  className="accent-apollo-slate size-4"
                  data-testid="orcid-bulk-all"
                />
              </span>
              <span role="columnheader">Scholar</span>
              <span role="columnheader">ORCID iD</span>
              <span role="columnheader">Name on ORCID</span>
              <span role="columnheader">Shared works</span>
              <span role="columnheader">Passes by</span>
              <span role="columnheader">Only on ORCID</span>
              <span role="columnheader">Found by</span>
            </div>
            {eligible.slice(0, shown).map((s) => {
              const c = s.candidates[0]!;
              const only = onlyOnOrcid(c);
              const capped = overCap.has(s.cwid);
              const on = !excluded.has(s.cwid) && !capped;
              const sources = c.sources.filter(isOrcidCandidateSource);
              // The same test the rule runs (`bulkBlocker`), so the column and the
              // Passes by control agree: shared works below the setting is not the
              // ORCID record route.
              const routes = bulkRoutes(c);
              const byRecord = routes.record && c.shared >= rule.minShared;
              return (
                <div
                  key={s.cwid}
                  role="row"
                  className={cn(
                    GRID,
                    "border-t py-2.5 text-[13.5px]",
                    tinted(s)
                      ? "border-apollo-coral-tint-border bg-apollo-coral-tint"
                      : "border-apollo-border",
                    !on && "opacity-55",
                  )}
                  data-testid={`orcid-bulk-row-${s.cwid}`}
                >
                  <span role="cell">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={capped}
                      onChange={() => toggle(s.cwid)}
                      aria-label={`Include ${s.name}`}
                      className="accent-apollo-slate size-4"
                      title={
                        capped
                          ? `Up to ${ORCID_BULK_ITHACA_MAX} Cornell Ithaca iDs per batch`
                          : undefined
                      }
                    />
                  </span>
                  <span role="cell" className="flex min-w-0 flex-col">
                    <span className="truncate">{s.name}</span>
                    <span className="text-muted-foreground truncate text-[12.5px]">
                      {s.department ? `${s.department} · ` : ""}
                      <span className="font-mono text-[0.92em]">{s.cwid}</span>
                    </span>
                  </span>
                  <span role="cell" className="flex flex-col font-mono text-[12.5px]">
                    {c.orcid}
                    {s.candidates.length > 1 ? (
                      <span className={cn(TAG, "font-sans")}>
                        Best of {fmt(s.candidates.length)} iDs
                      </span>
                    ) : null}
                  </span>
                  <span role="cell" className="min-w-0 truncate">
                    {floor?.get(keyOf(s))?.orcidName ?? (
                      <span className="text-muted-foreground">Name not public</span>
                    )}
                  </span>
                  <span role="cell" className="flex flex-col tabular-nums">
                    {compared(s) ? (
                      <span className="font-semibold">
                        {fmt(c.shared)} of {fmt(c.worksTotal)}
                      </span>
                    ) : (
                      `${fmt(c.worksTotal)} on ORCID`
                    )}
                    {c.bylinePapers ? (
                      <span className="text-muted-foreground text-[12.5px]">
                        {fmt(c.bylinePapers)} byline
                      </span>
                    ) : null}
                  </span>
                  <span role="cell" className="text-[12.5px]">
                    {s.campus === "ithaca"
                      ? c.band === "email_verified"
                        ? "Verified email"
                        : "Cornell source"
                      : byRecord && routes.byline
                        ? "Both"
                        : ORCID_BULK_ROUTE_LABEL[routes.byline ? "byline" : "record"]}
                  </span>
                  <span
                    role="cell"
                    className={cn(
                      "tabular-nums",
                      tinted(s)
                        ? "text-apollo-coral-foreground font-semibold"
                        : "text-muted-foreground",
                    )}
                  >
                    {compared(s) ? fmt(only) : "Not compared"}
                  </span>
                  <span role="cell" className="text-[12.5px] leading-snug">
                    {sources.map((x) => ORCID_SOURCE_LABEL[x]).join(", ") || "Unknown"}
                  </span>
                </div>
              );
            })}
            <div className="border-apollo-border text-muted-foreground flex justify-between border-t px-4 py-2.5 text-[13px]">
              <span>
                Showing {fmt(Math.min(shown, eligible.length))} of {fmt(eligible.length)}
              </span>
              {shown < eligible.length ? (
                <button
                  type="button"
                  onClick={() => setShown(shown + PAGE)}
                  className="text-apollo-slate hover:underline"
                >
                  Show the next {fmt(Math.min(PAGE, eligible.length - shown))} →
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {eligible.length > 0 ? (
        <div
          className="border-apollo-border-strong bg-apollo-surface sticky bottom-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--apollo-radius-card)] border px-4 py-3 shadow-[0_2px_8px_rgba(42,36,33,0.10)]"
          data-testid="orcid-bulk-footer"
        >
          <span className="text-[14px]">
            <span className="font-semibold">{fmt(selected.length)}</span> selected
            {tintedChecked > 0 ? (
              <span className="text-apollo-coral-foreground">
                {" "}
                · {fmt(tintedChecked)} tinted {tintedChecked === 1 ? "row" : "rows"} still checked
              </span>
            ) : null}
            {overCap.size > 0 ? (
              <span className="text-muted-foreground" data-testid="orcid-bulk-ithaca-cap">
                {" "}
                · Cornell Ithaca: {fmt(ORCID_BULK_ITHACA_MAX)} per batch, {fmt(overCap.size)} more
                after this one
              </span>
            ) : null}
          </span>
          <span className="flex-1" />
          {!asking && !progress ? (
            <span className="text-muted-foreground text-[12.5px]">
              {ithacaSelected === 0
                ? "Each iD goes on file and reaches WCM Identity overnight."
                : ithacaSelected === selected.length
                  ? "Each iD goes on file; Cornell Ithaca iDs stay in Scholars."
                  : "WCM iDs reach WCM Identity overnight; Cornell Ithaca iDs stay in Scholars."}{" "}
              The batch can be undone from the confirmation.
            </span>
          ) : null}
          {progress ? (
            <span className="text-muted-foreground text-[13px]" role="status">
              {progress}
            </span>
          ) : asking ? (
            <>
              <span className="text-[13px]">
                Put {fmt(selected.length)} iDs on file?{" "}
                {ithacaSelected === 0
                  ? "Each reaches WCM Identity overnight."
                  : ithacaSelected === selected.length
                    ? "Cornell Ithaca iDs stay in Scholars (not sent to Identity)."
                    : "WCM iDs reach WCM Identity overnight; Cornell Ithaca iDs stay in Scholars."}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAsking(false)}
                className="text-[13px]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void confirmAll()}
                className="bg-apollo-maroon hover:bg-apollo-maroon-press text-[13px] text-white"
                data-testid="orcid-bulk-confirm-yes"
              >
                Yes, confirm {fmt(selected.length)}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canDecide || busy || selected.length === 0}
              onClick={() => setAsking(true)}
              className="bg-apollo-maroon hover:bg-apollo-maroon-press text-[13px] text-white"
              data-testid="orcid-bulk-confirm"
            >
              Confirm {fmt(selected.length)} iDs
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

const GRID =
  "grid grid-cols-[28px_minmax(180px,1.5fr)_170px_minmax(140px,1fr)_100px_100px_110px_minmax(150px,1.1fr)] items-center gap-x-3 px-4";
const TAG =
  "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber w-max rounded border px-1.5 text-[11.5px] font-medium";

/**
 * Bulk review's rule, set in the page's filter row (one row of controls). "No
 * competitor" and "Name agrees" are locked: the server enforces them. The rest
 * can be unchecked; the server validates what the request then sends
 * (`allowMultiple`). The verified-email box only shows, and only applies, where
 * the view has Cornell Ithaca scholars.
 */
export function OrcidBulkRuleControls({
  rule,
  onRule,
  needEmail,
  onNeedEmail,
  hasIthaca,
}: {
  rule: OrcidBulkRule;
  onRule: (r: OrcidBulkRule) => void;
  needEmail: boolean;
  onNeedEmail: (v: boolean) => void;
  hasIthaca: boolean;
}) {
  // A threshold is a checkbox (off = not applied) plus its value.
  type Threshold = "minShared" | "maxOnlyOrcid";
  const OPTIONS: Record<Threshold, number[]> = {
    // From 3: the server's floor, so a lower value would change nothing.
    minShared: [3, 5, 8, 10, 15, 20],
    maxOnlyOrcid: [0, 1, 2, 3, 5, 10],
  };
  const on = (k: Threshold) => rule[k] !== ANY_RULE[k];
  const setNum = (k: Threshold, v: string | number) =>
    onRule({ ...rule, [k]: Math.max(0, Math.min(10_000, Math.floor(Number(v) || 0))) });
  const CHIP =
    "border-apollo-border-strong bg-apollo-surface inline-flex h-[34px] items-center gap-2 rounded-lg border px-3 text-[13.5px] whitespace-nowrap";
  const BOX = "accent-apollo-slate size-4";
  const SELECT =
    "border-apollo-border-strong bg-apollo-surface rounded-md border px-1 py-0.5 text-[13px] font-semibold tabular-nums disabled:opacity-50";
  const threshold = (k: Threshold, before: string, label: string) => (
    <label className={CHIP}>
      <input
        type="checkbox"
        checked={on(k)}
        onChange={() => setNum(k, on(k) ? ANY_RULE[k] : ORCID_BULK_RULE_DEFAULT[k])}
        className={BOX}
        data-testid={`orcid-bulk-rule-${k}-on`}
      />
      {before}
      <select
        value={on(k) ? rule[k] : ORCID_BULK_RULE_DEFAULT[k]}
        onChange={(e) => setNum(k, e.target.value)}
        disabled={!on(k)}
        aria-label={label}
        className={SELECT}
        data-testid={`orcid-bulk-rule-${k}`}
      >
        {[...new Set([...OPTIONS[k], rule[k], ORCID_BULK_RULE_DEFAULT[k]])]
          .filter((n) => n !== ANY_RULE[k])
          .sort((a, b) => a - b)
          .map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <>
      <label className={CHIP}>
        <input
          type="checkbox"
          checked={!rule.allowMultiple}
          onChange={() => onRule({ ...rule, allowMultiple: !rule.allowMultiple })}
          className={BOX}
          data-testid="orcid-bulk-rule-one"
        />
        One candidate iD
      </label>
      {/* The fixed part: the server enforces these, so they can't be unchecked. */}
      {["No competitor", "Name agrees"].map((t) => (
        <label key={t} className={CHIP} title="Always required">
          <input type="checkbox" checked disabled className={BOX} />
          {t}
        </label>
      ))}
      <label className={CHIP}>
        Passes by
        <select
          value={rule.passesBy ?? "either"}
          onChange={(e) => onRule({ ...rule, passesBy: e.target.value as OrcidBulkRoute })}
          className={SELECT}
          data-testid="orcid-bulk-rule-passesBy"
        >
          {ORCID_BULK_ROUTES.map((r) => (
            <option key={r} value={r}>
              {ORCID_BULK_ROUTE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {threshold("minShared", "Shared works at least", "Shared works at least")}
      {threshold("maxOnlyOrcid", "Only on ORCID at most", "Works only on ORCID at most")}
      {hasIthaca ? (
        <label className={CHIP}>
          <input
            type="checkbox"
            checked={needEmail}
            onChange={() => onNeedEmail(!needEmail)}
            className={BOX}
            data-testid="orcid-bulk-rule-email"
          />
          Cornell Ithaca: verified email
        </label>
      ) : null}
    </>
  );
}
