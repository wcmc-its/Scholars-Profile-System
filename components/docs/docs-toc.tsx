"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface NavItem {
  id: string;
  label: string;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * Scroll-spy hook: returns the id of the doc section currently in view.
 * Shared by the desktop sidebar (DocsToc) and the mobile section menu
 * (DocsMobileNav) so both highlight the same section. Each consumer runs its
 * own IntersectionObserver over the identical element set + config, so the two
 * always converge on the same id. Returns "" before the first intersection
 * (top of page) and when IntersectionObserver is unavailable.
 */
function useActiveSection(nav: NavGroup[]): string {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const ids = nav.flatMap((g) => g.items.map((i) => i.id));
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((e): e is HTMLElement => Boolean(e));
    if (!("IntersectionObserver" in window) || els.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-90px 0px -72% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [nav]);

  return active;
}

// Shared link styling so the desktop sidebar and the mobile menu render the
// active / inactive states identically.
const ITEM_BASE = "block rounded-r border-l-2 px-2.5 py-1 ";
const ITEM_ACTIVE = "border-[#7d1c1c] bg-[#f6f7f9] font-semibold text-[#7d1c1c]";
const ITEM_INACTIVE = "border-transparent text-muted-foreground hover:text-[#7d1c1c]";

function NavLinks({
  nav,
  active,
  onSelect,
}: {
  nav: NavGroup[];
  active: string;
  onSelect?: () => void;
}) {
  return (
    <>
      {nav.map((g) => (
        <div key={g.group || "_top"} className="mb-4 last:mb-0">
          {g.group ? (
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {g.group}
            </div>
          ) : null}
          {g.items.map((it) => {
            const isActive = active === it.id;
            return (
              <Link
                key={it.id}
                href={`#${it.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={onSelect}
                className={ITEM_BASE + (isActive ? ITEM_ACTIVE : ITEM_INACTIVE)}
              >
                {it.label}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * /about scroll-spy sidebar (v0). Anchor nav over the single comprehensive docs
 * page; highlights the section currently in view. Hidden below lg, where
 * DocsMobileNav takes over (the content stacks full-width). Mirrors the
 * standalone v4 mockup's sidebar.
 */
export function DocsToc({ nav }: { nav: NavGroup[] }) {
  const active = useActiveSection(nav);

  return (
    <nav
      aria-label="Documentation"
      className="hidden py-9 text-sm lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-auto"
    >
      <NavLinks nav={nav} active={active} />
    </nav>
  );
}

/**
 * /about section navigation for mobile / tablet (#571). Below the lg breakpoint
 * the desktop sidebar is hidden and the page stacks full-width with no way to
 * jump between sections or see where you are. This sticky "On this page" bar
 * restores both: it always shows the section currently in view (same scroll-spy
 * as the sidebar) and expands to the full grouped section list. Shown only
 * below lg; DocsToc covers lg and up.
 */
export function DocsMobileNav({ nav }: { nav: NavGroup[] }) {
  const active = useActiveSection(nav);
  const [open, setOpen] = useState(false);

  const items = nav.flatMap((g) => g.items);
  // Before the first intersection (top of page) `active` is "" — fall back to
  // the first section so the bar always names a real section.
  const activeLabel = items.find((i) => i.id === active)?.label ?? items[0]?.label ?? "Sections";

  return (
    <div className="sticky top-[60px] z-30 -mx-6 border-b border-border bg-white/95 backdrop-blur lg:hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="flex w-full items-center gap-2 px-6 py-2.5 text-left text-sm focus:outline-none focus-visible:bg-[#f6f7f9]"
          aria-label="Jump to section"
        >
          <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            On this page
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-[#7d1c1c]">{activeLabel}</span>
          <ChevronDownIcon
            className={
              "size-4 shrink-0 text-muted-foreground transition-transform " +
              (open ? "rotate-180" : "")
            }
            aria-hidden="true"
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={1}
          className="max-h-[70vh] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-none border-x-0 p-3 text-sm"
        >
          <nav aria-label="Documentation">
            <NavLinks nav={nav} active={active} onSelect={() => setOpen(false)} />
          </nav>
        </PopoverContent>
      </Popover>
    </div>
  );
}
