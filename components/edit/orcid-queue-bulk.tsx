"use client";

/**
 * ORCID queue — Bulk review (`/edit/orcid-queue`, the "Bulk review" mode).
 *
 * Lists every scholar in the current view who qualifies under an adjustable
 * rule (`bulkEligible`): the fixed part (one candidate iD, Strong, no
 * competitor, name agrees, nothing on file, WCM campus, no decision on file)
 * plus three thresholds the librarian sets: shared works, works only on ORCID,
 * and discovery sources. Each row can be unchecked; a row with any work only on
 * ORCID is tinted so it gets a look first. "Confirm N iDs" asks once more, then
 * posts in chunks of `ORCID_BULK_MAX` to `POST /api/edit/orcid-queue/bulk-confirm`,
 * which re-checks the fixed part per pair and skips anything that no longer
 * qualifies. The page's toast offers Undo for the whole batch.
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  bulkEligible,
  isOrcidCandidateSource,
  ORCID_BULK_MAX,
  ORCID_BULK_RULE_DEFAULT,
  ORCID_SOURCE_LABEL,
  onlyOnOrcid,
  type OrcidBulkRule,
  type OrcidQueueSummary,
} from "@/lib/edit/orcid-queue";
import { cn } from "@/lib/utils";

import { postBatch } from "@/components/edit/orcid-queue-api";

type Pair = { cwid: string; orcid: string };
type Result = Pair & { ok: boolean; code?: string };

const PAGE = 100;
const fmt = (n: number) => n.toLocaleString("en-US");

export function OrcidBulkReview({
  list,
  outcomes,
  canDecide,
  onConfirmed,
  onError,
}: {
  /** The page's list under the current filters. */
  list: OrcidQueueSummary[];
  /** Decisions made on this page (`cwid|orcid` keys): decided scholars drop out. */
  outcomes: Record<string, string>;
  canDecide: boolean;
  onConfirmed: (confirmed: Pair[], skipped: number) => void;
  onError: (message: string) => void;
}) {
  const [rule, setRule] = useState<OrcidBulkRule>(ORCID_BULK_RULE_DEFAULT);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const eligible = useMemo(
    () =>
      list.filter(
        (s) => bulkEligible(s, rule) && !s.candidates.some((c) => outcomes[`${s.cwid}|${c.orcid}`]),
      ),
    [list, rule, outcomes],
  );
  const selected = eligible.filter((s) => !excluded.has(s.cwid));
  const tintedChecked = selected.filter((s) => onlyOnOrcid(s.candidates[0]!) > 0).length;
  const busy = progress !== null;

  const setNum = (k: keyof OrcidBulkRule, v: string) => {
    const n = Math.max(0, Math.min(10_000, Math.floor(Number(v) || 0)));
    setRule((r) => ({ ...r, [k]: n }));
    setAsking(false);
  };

  const toggle = (cwid: string) =>
    setExcluded((x) => {
      const next = new Set(x);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });

  const allOn = selected.length === eligible.length && eligible.length > 0;

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

  const numInput = (k: keyof OrcidBulkRule, label: string) => (
    <input
      type="number"
      min={0}
      value={rule[k]}
      onChange={(e) => setNum(k, e.target.value)}
      aria-label={label}
      className="border-apollo-border-strong bg-apollo-surface w-14 rounded-md border px-1.5 py-0.5 text-[13px] font-semibold tabular-nums"
      data-testid={`orcid-bulk-rule-${k}`}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="orcid-bulk">
      <section
        aria-label="Bulk confirm rule"
        className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-[var(--apollo-radius-card)] border px-5 py-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium">
            Confirm Strong matches where every one of these holds
          </span>
          <span className="text-muted-foreground text-[13px]" data-testid="orcid-bulk-count">
            <span className="text-foreground font-semibold">{fmt(eligible.length)}</span> of{" "}
            {fmt(list.length)} scholars in this view match
          </span>
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-[13px]">
          {[
            "One candidate iD, no competitor",
            "Name agrees",
            "Nothing on file, no earlier decision",
          ].map((t) => (
            <li
              key={t}
              className="border-apollo-border-strong bg-apollo-surface-2 rounded-lg border px-2.5 py-1.5"
            >
              {t}
            </li>
          ))}
          <li className="border-apollo-border-strong flex items-center gap-1.5 rounded-lg border px-2.5 py-1">
            Shared works at least {numInput("minShared", "Shared works at least")}
          </li>
          <li className="border-apollo-border-strong flex items-center gap-1.5 rounded-lg border px-2.5 py-1">
            Only on ORCID at most {numInput("maxOnlyOrcid", "Works only on ORCID at most")}
          </li>
          <li className="border-apollo-border-strong flex items-center gap-1.5 rounded-lg border px-2.5 py-1">
            Found by at least {numInput("minSources", "Found by at least this many sources")}{" "}
            sources
          </li>
        </ul>
        <span className="text-muted-foreground text-[12.5px]">
          Rows with any work only on ORCID are tinted: look at those before confirming. Anything you
          uncheck stays in the one-at-a-time queue. The server re-checks each scholar and skips any
          that changed.
        </span>
      </section>

      {eligible.length === 0 ? (
        <p className="text-muted-foreground m-0 text-[14px]" data-testid="orcid-bulk-empty">
          No scholars in this view match the rule.
        </p>
      ) : (
        <div
          role="table"
          aria-label="Matches for bulk confirm"
          className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-[var(--apollo-radius-card)] border"
        >
          <div className="min-w-[860px]">
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
                  data-testid="orcid-bulk-all"
                />
              </span>
              <span role="columnheader">Scholar</span>
              <span role="columnheader">ORCID iD</span>
              <span role="columnheader">Shared works</span>
              <span role="columnheader">Only on ORCID</span>
              <span role="columnheader">Found by</span>
            </div>
            {eligible.slice(0, shown).map((s) => {
              const c = s.candidates[0]!;
              const only = onlyOnOrcid(c);
              const on = !excluded.has(s.cwid);
              const sources = c.sources.filter(isOrcidCandidateSource);
              return (
                <div
                  key={s.cwid}
                  role="row"
                  className={cn(
                    GRID,
                    "border-t py-2.5 text-[13.5px]",
                    only > 0
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
                      onChange={() => toggle(s.cwid)}
                      aria-label={`Include ${s.name}`}
                    />
                  </span>
                  <span role="cell" className="flex min-w-0 flex-col">
                    <span className="truncate">{s.name}</span>
                    <span className="text-muted-foreground truncate text-[12.5px]">
                      {s.department ? `${s.department} · ` : ""}
                      <span className="font-mono text-[0.92em]">{s.cwid}</span>
                    </span>
                  </span>
                  <span role="cell" className="font-mono text-[12.5px]">
                    {c.orcid}
                  </span>
                  <span role="cell" className="tabular-nums">
                    <span className="font-semibold">{fmt(c.shared)}</span> of {fmt(c.worksTotal)}
                  </span>
                  <span
                    role="cell"
                    className={cn(
                      "tabular-nums",
                      only > 0
                        ? "text-apollo-coral-foreground font-semibold"
                        : "text-muted-foreground",
                    )}
                  >
                    {fmt(only)}
                    {only > 0 ? <span className="ml-1.5 font-normal">check</span> : null}
                  </span>
                  <span role="cell" className="text-muted-foreground text-[12.5px]">
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
          </span>
          <span className="flex-1" />
          {progress ? (
            <span className="text-muted-foreground text-[13px]" role="status">
              {progress}
            </span>
          ) : asking ? (
            <>
              <span className="text-[13px]">
                Put {fmt(selected.length)} iDs on file? Each reaches WCM Identity overnight.
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
  "grid grid-cols-[28px_minmax(180px,1.6fr)_170px_110px_120px_minmax(150px,1.2fr)] items-center gap-x-3 px-4";
