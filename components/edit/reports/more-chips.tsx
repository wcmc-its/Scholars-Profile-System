"use client";

/**
 * "+N more": the chips past the first few, shown inline on click (spec B1).
 * The chips are rendered by the server and passed in as children, so their
 * hover-card footers (functions) never cross into the client. Per row, not
 * persisted.
 */
import { useState, type ReactNode } from "react";

export function MoreChips({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && children}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="border-border text-apollo-slate rounded-full border px-2.5 py-[3px] text-[13px] leading-[1.3] font-semibold hover:underline"
        data-testid="author-pills-more"
      >
        {open ? "Show fewer" : `+${count.toLocaleString()} more`}
      </button>
    </>
  );
}
