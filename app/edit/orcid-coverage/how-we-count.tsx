/**
 * The ORCID coverage intro: one short paragraph ending in an inline
 * "How we count" toggle that opens the definitions panel below it.
 *
 * A client island only for the toggle. The definitions are server-rendered
 * `children` and stay in the DOM when closed (`hidden`), so the copy is one
 * source of truth whichever way the panel is.
 */
"use client";

import * as React from "react";

export function HowWeCount({
  intro,
  children,
}: {
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-muted-foreground m-0 max-w-[88ch] text-[14.5px] leading-[1.55] text-pretty">
        {intro}{" "}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="orcid-coverage-definitions"
          className="text-apollo-slate whitespace-nowrap hover:underline"
          data-testid="orcid-coverage-how-we-count"
        >
          {open ? "Hide how we count ▴" : "How we count ▾"}
        </button>
      </p>
      <div id="orcid-coverage-definitions" hidden={!open} data-testid="orcid-coverage-definitions">
        {children}
      </div>
    </div>
  );
}
