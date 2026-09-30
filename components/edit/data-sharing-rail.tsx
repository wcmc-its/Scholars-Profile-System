"use client";

/**
 * `/edit/data-sharing` client islands (2026-09 page revision):
 *
 * - `DataSharingRail` — the "On this page" rail: audience chips (Everyone /
 *   Leadership / Library / RDM / Compliance) that dim the sections a given
 *   audience doesn't need, a numbered section list with a headline stat per
 *   section, scroll-spy highlighting of the section in view, and a Methods &
 *   definitions link. Sticky beside the dashboard at `lg`; an ordinary block
 *   above it on phones.
 * - `ShowMoreRows` — shows the first N of a server-rendered list of rows with a
 *   "Show all N" / "Show top N" footer toggle.
 *
 * Props only — never import the report lib or anything that builds prisma
 * here (the manageable-units client-bundle trap in CLAUDE.md).
 */
import { Children, useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type RailAudience = "lead" | "rdm" | "comp";

export type RailItem = {
  id: string;
  label: string;
  /** Headline number shown at the row's right edge ("" for none). */
  stat: string;
  audiences: readonly RailAudience[];
};

const AUDIENCES: { key: RailAudience | null; label: string }[] = [
  { key: null, label: "Everyone" },
  { key: "lead", label: "Leadership" },
  { key: "rdm", label: "Library / RDM" },
  { key: "comp", label: "Compliance" },
];

/** Offset below the viewport top at which a section counts as "in view": the
 *  sticky console bar (56px) plus the sticky filter bar and some slack. */
const SPY_OFFSET_PX = 200;

export function DataSharingRail({ items }: { items: RailItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const [audience, setAudience] = useState<RailAudience | null>(null);

  useEffect(() => {
    const onScroll = () => {
      let cur = items[0]?.id ?? "";
      for (const { id } of items) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < SPY_OFFSET_PX) cur = id;
      }
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [items]);

  return (
    <aside
      className="bg-apollo-rail border-apollo-rail-border flex flex-col gap-3 rounded-[13px] border px-3 pt-3.5 pb-3 lg:sticky lg:top-[76px]"
      aria-label="On this page"
      data-testid="ds-rail"
    >
      <span className="text-muted-foreground px-1.5 text-xs font-medium tracking-[.12em] uppercase">
        On this page
      </span>
      <div className="flex flex-wrap gap-1 px-1" role="group" aria-label="Highlight sections for">
        {AUDIENCES.map((a) => {
          const on = audience === a.key;
          return (
            <button
              key={a.label}
              type="button"
              aria-pressed={on}
              onClick={() => setAudience(a.key)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap",
                on
                  ? "border-apollo-slate bg-apollo-surface text-apollo-slate"
                  : "border-apollo-border-strong hover:bg-apollo-rail-hover",
              )}
            >
              {a.label}
            </button>
          );
        })}
      </div>
      <nav className="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-1">
        {items.map((item, i) => {
          const isActive = active === item.id;
          const relevant = audience === null || item.audiences.includes(audience);
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={() => setActive(item.id)}
              aria-current={isActive ? "location" : undefined}
              data-dimmed={relevant ? undefined : "true"}
              className={cn(
                "hover:bg-apollo-surface grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-1.5 rounded-[7px] px-2 py-[7px]",
                isActive
                  ? "bg-apollo-surface shadow-[inset_2px_0_0_var(--apollo-maroon)]"
                  : "bg-transparent",
                !relevant && "opacity-40",
              )}
            >
              <span className="text-muted-foreground text-[11.5px] tabular-nums">{i + 1}</span>
              <span
                className={cn(
                  "text-[13.5px] leading-snug",
                  isActive ? "font-semibold" : "font-normal",
                )}
              >
                {item.label}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">{item.stat}</span>
            </a>
          );
        })}
      </nav>
      <a
        href="#methods"
        className="border-apollo-rail-border text-apollo-slate border-t px-2 pt-2 text-[13px] hover:underline"
      >
        Methods &amp; definitions
      </a>
    </aside>
  );
}

/** `colSpan` set ⇒ the children are `<tr>`s and the toggle renders as a
 *  full-width table row, so the markup stays valid inside a `<tbody>`. */
export function ShowMoreRows({
  initial,
  children,
  colSpan,
}: {
  initial: number;
  children: ReactNode;
  colSpan?: number;
}) {
  const [open, setOpen] = useState(false);
  const rows = Children.toArray(children);
  const toggle =
    rows.length > initial ? (
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="bg-apollo-page text-apollo-slate w-full p-2.5 text-[13px] hover:underline"
      >
        {open ? `Show top ${initial}` : `Show all ${rows.length}`}
      </button>
    ) : null;
  return (
    <>
      {open ? rows : rows.slice(0, initial)}
      {toggle && colSpan ? (
        <tr className="border-apollo-border border-t">
          <td colSpan={colSpan} className="p-0">
            {toggle}
          </td>
        </tr>
      ) : (
        toggle
      )}
    </>
  );
}
