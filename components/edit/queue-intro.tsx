/**
 * A page intro: one short paragraph ending in an inline toggle that opens a
 * help panel below it. Used by ORCID coverage ("How we count") and the /edit
 * review queues ("How this queue works").
 *
 * A client island only for the toggle. The panel is server-rendered
 * `children` and stays in the DOM when closed (`hidden`), so the copy is one
 * source of truth whichever way the panel is. Closed by default.
 */
"use client";

import * as React from "react";
import { Caret } from "@/components/ui/caret";

/** The intro paragraph's default look (the ORCID coverage page's). */
const INTRO_CLASS =
  "text-muted-foreground m-0 max-w-[88ch] text-[14.5px] leading-[1.55] text-pretty";

export function QueueIntro({
  intro,
  children,
  panelId,
  label = "How this queue works",
  hideLabel = "Hide how this queue works",
  toggleTestId,
  panelTestId = panelId,
  introClassName = INTRO_CLASS,
}: {
  intro: React.ReactNode;
  children: React.ReactNode;
  /** The panel's DOM id, which the toggle names in `aria-controls`. */
  panelId: string;
  label?: string;
  hideLabel?: string;
  toggleTestId: string;
  panelTestId?: string;
  introClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <p className={introClassName}>
        {intro}{" "}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="text-apollo-slate whitespace-nowrap hover:underline"
          data-testid={toggleTestId}
        >
          {open ? hideLabel : label}
          <Caret dropdown open={open} className="ml-0.5 inline-block align-[-2px]" />
        </button>
      </p>
      <div id={panelId} hidden={!open} data-testid={panelTestId}>
        {children}
      </div>
    </div>
  );
}
