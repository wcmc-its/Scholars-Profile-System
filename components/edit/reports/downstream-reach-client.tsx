"use client";

/**
 * Report 27's client half: the two buttons that open the publication modal
 * (`components/publication/publication-modal.tsx`, the one the public pages
 * use) from a Publications row, and the rail's checkbox groups that can never
 * be left empty. The body mounts `PublicationModalProvider` around the list;
 * nothing here fetches or reaches `@/lib/db`.
 */
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { pubTitleProps } from "@/components/publication/pub-html";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { sanitizePubTitle } from "@/lib/utils";

/** The paper's title, as the search and profile rows have it: a button that
 *  opens the publication modal. */
export function PaperTitle({ pmid, title }: { pmid: string; title: string }) {
  const { open } = usePublicationModal();
  return (
    <button
      type="button"
      onClick={() => open(pmid)}
      aria-haspopup="dialog"
      data-testid="downstream-reach-title"
      {...pubTitleProps(sanitizePubTitle(title), "text-left font-medium hover:underline")}
    />
  );
}

/** A count that opens the publication modal at the section listing what it
 *  counts ("trials": clinical studies, trials and patents; "policy"). */
export function ModalCount({
  pmid,
  section,
  label,
  className,
  children,
}: {
  pmid: string;
  section: "trials" | "policy";
  /** "12 clinical studies citing this paper": the button's accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { open } = usePublicationModal();
  return (
    <button
      type="button"
      onClick={() => open(pmid, { section })}
      aria-haspopup="dialog"
      aria-label={label}
      className={className}
      data-testid="downstream-reach-modal-count"
    >
      {children}
    </button>
  );
}

/**
 * A rail checkbox group with an "All" box on top (spec E2): every option the
 * filter includes is shown ticked, so no state reads "none = everything".
 * Unticking the last option (or "All" while everything is ticked) is refused
 * with "Choose at least one."; its `change` never reaches the auto-submitting
 * form. Inputs stay uncontrolled: "All" ticks the boxes
 * in the DOM before its `change` bubbles, so the form submits them. Without
 * JS a group can still be emptied; the parser reads that as every option.
 */
export function AtLeastOneChecklist({
  name,
  options,
  selected,
  testId,
}: {
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** What the filter includes now; every option when it is unfiltered. */
  selected: ReadonlyArray<string>;
  testId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const all = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState(false);
  const boxes = () => [...root.current!.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
  // React derives a checkbox's `change` from its click, so cancelling the click
  // would not stop the form's `onChange`: refuse in `change`, stop it there,
  // and put the tick back by hand.
  const refuse = (e: ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    e.currentTarget.checked = true;
    setRefused(true);
  };
  const onAll = (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.currentTarget.checked) return refuse(e);
    for (const b of boxes()) b.checked = true;
  };
  const onOne = (e: ChangeEvent<HTMLInputElement>) => {
    const group = boxes();
    if (group.every((b) => !b.checked)) return refuse(e);
    setRefused(false);
    all.current!.checked = group.every((b) => b.checked);
  };
  const row = "hover:bg-apollo-rail-hover -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-[5px] text-sm";
  const box = "accent-apollo-maroon mt-0.5 size-4 shrink-0";
  return (
    <div ref={root} className="flex flex-col gap-0.5" data-testid={testId}>
      <label className={row}>
        <input
          ref={all}
          type="checkbox"
          defaultChecked={options.every((o) => selected.includes(o.value))}
          onChange={onAll}
          className={box}
        />
        <span className="leading-[1.35] font-medium">All</span>
      </label>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {options.map((o) => (
          <li key={o.value}>
            <label className={row}>
              <input
                type="checkbox"
                name={name}
                value={o.value}
                defaultChecked={selected.includes(o.value)}
                onChange={onOne}
                className={box}
              />
              <span className="min-w-0 flex-1 leading-[1.35]">{o.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <p role="status" className="text-apollo-maroon text-xs">
        {refused ? "Choose at least one." : ""}
      </p>
    </div>
  );
}
