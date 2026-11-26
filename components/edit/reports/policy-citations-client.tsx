"use client";

/**
 * Report 24's client half: the pieces that hold state the URL does not (which
 * rows are open, which level the chart shows, "copied"). Everything shown
 * inside them is rendered by the server body and passed in; nothing here
 * fetches or reaches `@/lib/db`.
 */
import { useState, type ReactNode } from "react";
import { Check, ClipboardCheck, Copy, Landmark, Layers, Users } from "lucide-react";

import { Caret } from "@/components/ui/caret";
import type { DocLevel, Level } from "@/lib/edit/policy-citations-report";
import { cn } from "@/lib/utils";

const ICON = { authority: Landmark, guideline: ClipboardCheck, consensus: Users, review: Layers } as const;

export function LevelIcon({ level }: { level: Level }) {
  const Icon = ICON[level];
  return <Icon aria-hidden className="mr-[5px] inline-block size-[13px] align-[-2px]" />;
}

export function CopyPmid({ pmid }: { pmid: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "PMID copied" : "Copy PMID"}
      title="Copy PMID"
      onClick={() => {
        navigator.clipboard?.writeText(pmid).then(
          () => setDone(true),
          () => {},
        );
      }}
      className="text-muted-foreground hover:text-foreground ml-0.5 inline-flex size-6 items-center justify-center rounded align-middle"
    >
      {done ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
    </button>
  );
}

/** A "Show … / Hide" button over content that is only mounted while open. */
export function Disclosure({
  show,
  hide = "Hide",
  className,
  children,
}: {
  show: string;
  hide?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn("text-apollo-slate inline-flex items-center gap-1 text-[13px]", className)}
      >
        <Caret open={open} />
        {open ? hide : show}
      </button>
      {open && children}
    </>
  );
}

export type CitedByChip = { level: Level; label: string; title?: string };

/** One By publication row: the publication (`head`), the expander under it,
 *  the "Cited by" chips beside it (each opens the row), and the citing
 *  documents (`children`) while open. */
export function PubRow({
  head,
  chips,
  count,
  children,
}: {
  head: ReactNode;
  chips: CitedByChip[];
  /** Citing documents at the listed levels, editions grouped. */
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-apollo-border border-b" data-testid="policy-citations-pub-row">
      <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-6 px-4 py-3">
        <div className="min-w-0">
          {head}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="bg-apollo-surface border-apollo-border-strong text-apollo-slate mt-2.5 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[13px]"
          >
            <Caret open={open} />
            {open
              ? "Hide citing documents"
              : `${count.toLocaleString()} citing ${count === 1 ? "document" : "documents"}`}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              title={c.title}
              onClick={() => setOpen(true)}
              className={cn(
                "rounded border px-2 py-0.5 text-left text-xs",
                c.level === "authority"
                  ? "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate"
                  : "bg-apollo-surface-2 border-apollo-border-strong text-foreground",
              )}
            >
              <LevelIcon level={c.level} />
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {open && (
        <div
          className="bg-apollo-surface-2 border-apollo-border-strong border-t px-4 pb-2 leading-normal"
          data-testid="policy-citations-docs"
        >
          {children}
        </div>
      )}
    </div>
  );
}

const CHART: Record<DocLevel, { tab: string; noun: string; label: string }> = {
  authority: { tab: "Authorities", noun: "health authority documents", label: "Health authority documents" },
  guideline: { tab: "Guidelines", noun: "guidelines", label: "Clinical guidelines" },
  consensus: { tab: "Consensus", noun: "consensus statements", label: "Consensus statements" },
};
/** The chart's widest span, ending this year. */
const CHART_YEARS = 11;
const BAR_PX = 120;

/** "Citing documents by year published": one level at a time, from the first
 *  year that has any (at most `CHART_YEARS` back) to this year. */
export function LevelChart({
  series,
  thisYear,
}: {
  series: Record<DocLevel, { year: number; count: number }[]>;
  thisYear: number;
}) {
  const [level, setLevel] = useState<DocLevel>("guideline");
  const { noun, label } = CHART[level];
  const byYear = new Map(series[level].map((r) => [r.year, r.count]));
  const first = Math.min(thisYear, ...series[level].filter((r) => r.count > 0).map((r) => r.year));
  const start = Math.max(first, thisYear - CHART_YEARS + 1);
  const bars = Array.from({ length: thisYear - start + 1 }, (_, i) => ({
    year: start + i,
    count: byYear.get(start + i) ?? 0,
  }));
  const max = Math.max(1, ...bars.map((b) => b.count));
  const none = bars.every((b) => b.count === 0);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Citing documents by year published</h2>
        <div
          role="radiogroup"
          aria-label="Level shown"
          className="border-apollo-border-strong flex overflow-hidden rounded-lg border text-xs"
        >
          {(Object.keys(CHART) as DocLevel[]).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={level === l}
              onClick={() => setLevel(l)}
              className={cn(
                "border-apollo-border-strong px-[9px] py-[5px] [&:not(:first-child)]:border-l",
                level === l ? "bg-apollo-surface-2 font-semibold" : "bg-apollo-surface",
              )}
            >
              {CHART[l].tab}
            </button>
          ))}
        </div>
      </div>
      {none ? (
        <p className="text-muted-foreground mt-3.5 text-[13px]">No citing {noun} match.</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${label} citing WCM papers, by year: ${bars
              .map((b) => `${b.count.toLocaleString()} in ${b.year}${b.year === thisYear ? " to date" : ""}`)
              .join(", ")}`}
            className="border-apollo-border-strong mt-3.5 flex h-[150px] items-end gap-0.5 border-b"
          >
            {bars.map((b) => (
              <div
                key={b.year}
                title={`${b.year}${b.year === thisYear ? " to date" : ""}: ${b.count.toLocaleString()} ${noun}`}
                className="flex flex-1 flex-col items-center gap-1"
              >
                <span className="text-muted-foreground text-xs tabular-nums">{b.count.toLocaleString()}</span>
                <div
                  className={cn(
                    "w-[70%] max-w-11 rounded-t",
                    b.year === thisYear
                      ? "bg-apollo-slate-tint border-apollo-slate border-2 border-b-0 border-dashed"
                      : "bg-apollo-slate",
                  )}
                  style={{ height: `${Math.round((b.count / max) * BAR_PX)}px` }}
                />
              </div>
            ))}
          </div>
          <div className="text-muted-foreground mt-1 flex gap-0.5 text-xs" aria-hidden>
            {bars.map((b) => (
              <span key={b.year} className="flex-1 text-center">
                {b.year}
                {b.year === thisYear && "*"}
              </span>
            ))}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            * Year to date.{" "}
            {start === first
              ? `Earlier years have no citing ${noun} and are not drawn.`
              : "Earlier years are not drawn."}
          </p>
        </>
      )}
    </>
  );
}
