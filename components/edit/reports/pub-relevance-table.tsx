"use client";

/**
 * Report 17 — Publication cancer relevance, the client half: the review table.
 * The body (`pub-relevance-body.tsx`) filters on the server and hands over the
 * rows; this pages them and owns the writes
 * (`PATCH /api/edit/center/[code]/pub-relevance/[pmid]`, which makes the row
 * `source: "human"` and writes the `pub_relevance_review` audit row):
 *   - Yes / No sets the answer (the current one on an AI row confirms it); a
 *     flip clears the note and opens the editor for the reviewer's reason;
 *   - the note opens an editor; leaving the field saves, Esc undoes.
 * The refresh reads the read replica, which can lag the write, so the table
 * shows each saved row itself until the server row has it (the report 2
 * precedent). A rule row can still be flipped; a row not yet scored cannot be
 * set here. Nothing here reaches `@/lib/db`.
 */
import * as React from "react";
import { useRouter } from "next/navigation";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  PUB_RELEVANCE_REASON_MAX,
  PUB_RELEVANCE_STATUS_LABEL,
  pubRelevanceStatus,
  type PubRelevanceRow,
} from "@/lib/edit/pub-relevance-report";
import { cn } from "@/lib/utils";

const AMBER = "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border";
const SLATE = "text-apollo-slate bg-apollo-slate-tint border-apollo-slate-tint-border";

type Write = { relevant: boolean; reason: string | null };
type Save = (pmid: string, patch: Partial<Write>) => Promise<boolean>;

function Row({ row, save }: { row: PubRelevanceRow; save: Save }) {
  const status = pubRelevanceStatus(row);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  const cancelled = React.useRef(false);
  const run = async (patch: Partial<Write>) => {
    setBusy(true);
    await save(row.pmid, patch);
    setBusy(false);
  };
  const commitNote = async () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === undefined) return;
    const next = draft.trim() || null;
    if (next !== row.reason) await run({ reason: next });
    setDraft(undefined);
  };
  const choice = (value: boolean) => (
    <Button
      variant={row.relevant === value ? "default" : "outline"}
      size="xs"
      disabled={busy || status === "not-scored"}
      aria-pressed={row.relevant === value}
      onClick={() => {
        if (row.relevant === value) return void run({ relevant: value });
        // A flip drops the old note (it argues the other answer) and asks for a new one.
        void run({ relevant: value, reason: null });
        setDraft("");
      }}
      aria-label={`${value ? "Yes" : "No"}, cancer relevant, PMID ${row.pmid}`}
    >
      {value ? "Yes" : "No"}
    </Button>
  );

  return (
    <tr className="border-apollo-border border-b align-top" data-testid="pub-relevance-row">
      <td className="py-3 pr-3 pl-5">
        <a
          href={`https://pubmed.ncbi.nlm.nih.gov/${row.pmid}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="leading-snug font-semibold underline-offset-2 hover:underline"
        >
          {row.title}
        </a>
        {row.isReview && (
          <span
            className={cn(
              "ml-1.5 inline-block rounded border px-1.5 py-px align-middle text-[11px] font-semibold whitespace-nowrap",
              SLATE,
            )}
            data-testid="pub-relevance-review"
          >
            Review
          </span>
        )}
        <div className="text-muted-foreground mt-0.5 text-xs">
          {[row.journal, row.year, row.publicationType, `PMID ${row.pmid}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td className="p-3 text-[13px] leading-snug">
        {row.members.map((m) => (
          <div key={m.cwid}>
            <ScholarHoverCard cwid={m.cwid}>
              <span>{m.name}</span>
            </ScholarHoverCard>
            {m.programCode && <span className="text-muted-foreground"> - {m.programCode}</span>}
          </div>
        ))}
      </td>
      <td className="p-3">
        <div className="flex gap-1.5">
          {choice(true)}
          {choice(false)}
        </div>
        <span
          className={cn(
            "mt-1.5 inline-block rounded border px-1.5 py-px text-[11px] font-semibold whitespace-nowrap",
            status === "ai" || status === "not-scored" ? AMBER : SLATE,
          )}
          data-testid="pub-relevance-status"
        >
          {PUB_RELEVANCE_STATUS_LABEL[status]}
        </span>
      </td>
      <td className="py-3 pr-5 pl-3 text-[13px] leading-snug">
        {draft !== undefined ? (
          <Textarea
            rows={3}
            autoFocus
            maxLength={PUB_RELEVANCE_REASON_MAX}
            value={draft}
            disabled={busy}
            aria-label={`Note, PMID ${row.pmid}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitNote()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                cancelled.current = true;
                setDraft(undefined);
              }
            }}
            className="min-h-0 bg-white"
          />
        ) : (
          <button
            type="button"
            disabled={status === "not-scored"}
            onClick={() => setDraft(row.reason ?? "")}
            className="cursor-pointer text-left hover:underline disabled:cursor-default disabled:no-underline"
            aria-label={`Edit note, PMID ${row.pmid}`}
          >
            {row.reason ?? (
              <span className="text-muted-foreground">
                {status === "not-scored" ? "—" : "Add note"}
              </span>
            )}
          </button>
        )}
      </td>
    </tr>
  );
}

const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";

export function PubRelevanceTable({
  centerCode,
  rows,
  resetKey,
}: {
  centerCode: string;
  rows: ReadonlyArray<PubRelevanceRow>;
  /** The filter query; paging resets when it changes. */
  resetKey: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  // Rows this table saved, by pmid, shown until the (possibly lagging) replica has them.
  const [written, setWritten] = React.useState<Record<string, Write>>({});
  const shown = React.useMemo(
    () =>
      rows.map((r) => {
        const w = written[r.pmid];
        const landed =
          w && r.source === "human" && r.relevant === w.relevant && r.reason === w.reason;
        return w && !landed ? { ...r, ...w, source: "human" as const } : r;
      }),
    [rows, written],
  );
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(shown, 25, resetKey);

  const save: Save = async (pmid, patch) => {
    setError(null);
    const current = shown.find((r) => r.pmid === pmid);
    try {
      const res = await fetch(
        `/api/edit/center/${encodeURIComponent(centerCode)}/pub-relevance/${encodeURIComponent(pmid)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        setError(`Save failed (${res.status}). Nothing was changed.`);
        return false;
      }
    } catch {
      setError("Save failed. Nothing was changed.");
      return false;
    }
    if (current) {
      setWritten((w) => ({
        ...w,
        [pmid]: {
          relevant: patch.relevant ?? (current.relevant as boolean),
          reason: "reason" in patch ? (patch.reason ?? null) : current.reason,
        },
      }));
    }
    React.startTransition(() => router.refresh());
    return true;
  };

  return (
    <div data-testid="pub-relevance-table">
      {error && (
        <p role="alert" className="text-destructive px-5 pt-3 text-sm">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-sm">
          No publications match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead>
              <tr className="bg-apollo-surface-2 text-left">
                <th className={cn(TH, "pl-5")}>Publication</th>
                <th className={cn(TH, "w-[200px]")}>Research members</th>
                <th className={cn(TH, "w-[130px]")}>Cancer relevant</th>
                <th className={cn(TH, "w-[320px] pr-5")}>Note</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <Row key={r.pmid} row={r} save={save} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <span className="text-muted-foreground text-[13px]">
          {rows.length ? `${rangeLabel} publications` : ""}
        </span>
        {hasMore && (
          <Button variant="outline" size="sm" onClick={showMore}>
            Show 25 more
          </Button>
        )}
      </div>
    </div>
  );
}
