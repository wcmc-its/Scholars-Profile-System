"use client";

/**
 * Report 24's client half: the pieces that hold state the URL does not (which
 * rows are open and what an open row shows, "copied"). Everything shown
 * inside them is rendered by the server body and passed in; nothing here
 * fetches or reaches `@/lib/db` (the report's library is imported for its
 * types only).
 */
import { Fragment, useState, type ReactNode } from "react";
import { Check, ClipboardCheck, Copy, Landmark, Layers, Users } from "lucide-react";

import { Caret } from "@/components/ui/caret";
import type { Level } from "@/lib/edit/policy-citations-report";
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

export type CitedByChip = {
  level: Level;
  label: string;
  title?: string;
  /** A health authority chip: the issuing body whose documents it opens. */
  body?: string;
};

/** One type's citing documents under a publication. */
export type DocSection = {
  level: Level;
  /** "Systematic reviews · 3". */
  heading: string;
  /** Ticked in the filters. An unticked type is a closed group under its heading. */
  listed: boolean;
  /** One per document (editions grouped); `body` is what a body chip matches. */
  entries: { key: number; body: string | null; node: ReactNode }[];
  /** After the entries ("The newest 20 of 57 systematic reviews."). */
  note?: ReactNode;
};

/** One By publication row: the publication (`head`), the expander under it,
 *  the "Cited by" chips beside it, and the citing documents while open. The
 *  expander opens every type; a chip opens the row to its own documents only
 *  (one issuing body's, or one type's), and closes it when pressed again. */
export function PubRow({
  head,
  chips,
  count,
  sections,
}: {
  head: ReactNode;
  chips: CitedByChip[];
  /** Citing documents at the listed levels, editions grouped. */
  count: number;
  /** Highest level first. */
  sections: DocSection[];
}) {
  /** "all", or the index of the chip the row is open to. */
  const [open, setOpen] = useState<"all" | number | null>(null);
  const only = typeof open === "number" ? chips[open] : null;
  return (
    <div className="border-apollo-border border-b" data-testid="policy-citations-pub-row">
      <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-6 px-4 py-3">
        <div className="min-w-0">
          {head}
          <button
            type="button"
            aria-expanded={open !== null}
            onClick={() => setOpen(open === "all" ? null : "all")}
            className="bg-apollo-surface border-apollo-border-strong text-apollo-slate mt-2.5 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[13px]"
          >
            <Caret open={open === "all"} />
            {open === "all"
              ? "Hide citing documents"
              : `${count.toLocaleString()} citing ${count === 1 ? "document" : "documents"}`}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <button
              key={c.label}
              type="button"
              title={c.title}
              aria-pressed={open === i}
              onClick={() => setOpen(open === i ? null : i)}
              className={cn(
                "rounded border px-2 py-0.5 text-left text-xs",
                c.level === "authority"
                  ? "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate"
                  : "bg-apollo-surface-2 border-apollo-border-strong text-foreground",
                open === i && "ring-apollo-slate ring-1",
              )}
            >
              <LevelIcon level={c.level} />
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {open !== null && (
        <div
          className="bg-apollo-surface-2 border-apollo-border-strong border-t px-4 pb-2 leading-normal"
          data-testid="policy-citations-docs"
        >
          {sections.map((s) => {
            // Chips exist for listed types only, so a chip never opens a closed group.
            if (only && only.level !== s.level) return null;
            const entries = only?.body === undefined ? s.entries : s.entries.filter((e) => e.body === only.body);
            const docs = (
              <>
                {entries.map((e) => (
                  <Fragment key={e.key}>{e.node}</Fragment>
                ))}
                {s.note}
              </>
            );
            if (s.listed) return <Fragment key={s.level}>{docs}</Fragment>;
            return (
              <section
                key={s.level}
                className="border-apollo-border-strong mt-5 border-t pt-4 pb-2"
                data-testid={`policy-citations-off-${s.level}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-foreground m-0 text-xs font-semibold tracking-[0.05em] uppercase">
                    <LevelIcon level={s.level} />
                    {s.heading}
                  </h3>
                  <span className="text-muted-foreground text-[13px]">This type is switched off in the filters</span>
                  <Disclosure show="Show" className="py-1">
                    <div className="basis-full">{docs}</div>
                  </Disclosure>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
