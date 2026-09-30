/**
 * Home-page section heading (home refinements mockup, 2026-09-24): a short
 * maroon rule over a 26px serif title. Home-only — a deliberate exception to
 * the #213 "section headers stay sans" rule, per the mockup.
 */
import type { ReactNode } from "react";

export function SectionHeading({
  id,
  children,
  aside,
}: {
  id?: string;
  children: ReactNode;
  /** Inline after the title (e.g. an info button). */
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-end gap-1.5">
      <h2 id={id} className="font-serif text-[26px] leading-8 font-normal tracking-[-0.005em]">
        <span aria-hidden="true" className="bg-apollo-maroon mb-3 block h-[3px] w-7 rounded-sm" />
        {children}
      </h2>
      {aside}
    </div>
  );
}
