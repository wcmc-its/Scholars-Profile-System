"use client";

/**
 * Below `lg` the console tabs don't fit the top bar next to the brand and the
 * account menu, so they collapse into one button naming where you are; it opens
 * a left sheet ("compact nav" canvas, `Mobile Nav.dc.html`):
 *
 * - top-level tabs are plain rows; each labelled group is a collapsible header
 *   whose collapsed hint names the current page (if it's inside) or the item
 *   count, and the group holding the current page starts open;
 * - "Jump to…" filters every item into one flat list, each tagged with its group;
 * - the viewer's name, Sign out and a link to the public site sit in a pinned footer.
 *
 * Plain links only — the Matcha hover card and the group hover menus are desktop
 * affordances a phone can't use anyway.
 */
import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Menu, Search, X } from "lucide-react";

import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";

export type ConsoleNavSection = {
  /** Group heading; `null` for the top-level tabs. */
  label: string | null;
  items: Array<{ id: string; href: string; label: string; count?: number; active: boolean }>;
};

type NavItem = ConsoleNavSection["items"][number];

const ROW = "flex min-h-11 items-center gap-2 rounded-lg px-3 text-[15px] text-[#1f1b19]";

function ItemLink({
  it,
  indent,
  weight,
  group,
}: {
  it: NavItem;
  indent?: boolean;
  weight?: string;
  group?: string;
}) {
  return (
    <Link
      href={it.href}
      aria-current={it.active ? "page" : undefined}
      className={`${ROW} ${indent ? "pl-6" : ""} ${
        it.active
          ? "bg-apollo-surface-2 font-semibold shadow-[inset_3px_0_0_var(--apollo-maroon)]"
          : `hover:bg-apollo-surface-2 ${weight ?? ""}`
      }`}
    >
      <span className="flex-1">{it.label}</span>
      {it.count !== undefined && it.count > 0 && (
        <span className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white">
          {it.count}
        </span>
      )}
      {group && <span className="text-muted-foreground text-xs font-normal">{group}</span>}
    </Link>
  );
}

export function ConsoleNavSheet({
  sections,
  currentLabel,
}: {
  sections: ConsoleNavSection[];
  currentLabel: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const activeGroups = () =>
    sections.filter((s) => s.label && s.items.some((it) => it.active)).map((s) => s.label!);
  const [expanded, setExpanded] = React.useState<string[]>(activeGroups);
  // Probe on first open only; the bar's AccountMenu already probes on mount.
  const probe = useImpersonationProbe(open);
  const name = probe?.scholar?.preferredName ?? probe?.displayName ?? null;
  const initials = name
    ? name
        .split(/\s+/)
        .filter((w) => /^[A-Za-z]/.test(w))
        .map((w) => w[0])
        .filter((_, i, a) => i === 0 || i === a.length - 1)
        .join("")
        .toUpperCase()
    : "";

  const needle = q.trim().toLowerCase();
  const results = needle
    ? sections.flatMap((s) =>
        s.items
          .filter((it) => it.label.toLowerCase().includes(needle))
          .map((it) => ({ it, group: s.label })),
      )
    : [];

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Each open starts fresh: empty filter, only the current page's group open.
    if (next) {
      setQ("");
      setExpanded(activeGroups());
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-md border border-white/25 px-3 text-sm text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none min-[960px]:hidden"
        data-testid="console-nav-sheet-trigger"
      >
        <Menu className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{currentLabel}</span>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="bg-apollo-surface w-[340px] max-w-[calc(100vw-3rem)] gap-0 border-r-0 p-0 min-[960px]:hidden [&>[data-slot=sheet-close-icon]]:hidden"
      >
        <div className="bg-apollo-bar flex h-14 flex-none items-center gap-2.5 pr-2 pl-4 text-white">
          <span
            className="bg-apollo-maroon text-apollo-maroon-foreground flex size-7 items-center justify-center rounded-md text-[10px] font-bold"
            aria-hidden
          >
            WCM
          </span>
          <SheetTitle className="flex flex-1 items-baseline gap-1.5 text-[15px] font-normal text-white">
            <span className="font-semibold">Scholars</span>
            <span className="text-white/70">Console</span>
          </SheetTitle>
          <SheetClose
            aria-label="Close menu"
            className="flex size-11 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          >
            <X className="size-5" aria-hidden />
          </SheetClose>
        </div>

        <div className="flex-none px-3 pt-3 pb-2">
          <div className="relative">
            <Search
              className="absolute top-1/2 left-[11px] size-4 -translate-y-1/2 text-[#8a847c]"
              aria-hidden
            />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Jump to…"
              aria-label="Jump to"
              className="border-apollo-border-strong h-10 w-full rounded-lg border bg-white pr-3 pl-[34px] text-[15px] text-[#1f1b19] outline-none focus-visible:ring-2 focus-visible:ring-[var(--apollo-maroon)]/40"
            />
          </div>
        </div>

        {/* Every item is a <Link>: a tap navigates and closes the sheet. */}
        <nav
          aria-label="Console"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1 pb-3"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          {needle ? (
            results.length ? (
              results.map(({ it, group }) => (
                <ItemLink key={it.id} it={it} group={group ?? undefined} />
              ))
            ) : (
              <p className="text-muted-foreground px-3 py-4 text-sm">No pages match “{q.trim()}”</p>
            )
          ) : (
            sections.map((s) => {
              if (!s.label)
                return s.items.map((it) => <ItemLink key={it.id} it={it} weight="font-medium" />);
              const label = s.label;
              const isOpen = expanded.includes(label);
              const active = s.items.find((it) => it.active);
              return (
                <div key={label} className="flex flex-col">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setExpanded((xs) => (isOpen ? xs.filter((x) => x !== label) : [...xs, label]))
                    }
                    className={`${ROW} hover:bg-apollo-surface-2 w-full text-left font-medium`}
                  >
                    <span className="flex-1">{label}</span>
                    {!isOpen && (
                      <span className="text-muted-foreground text-xs font-normal">
                        {active ? active.label : s.items.length}
                      </span>
                    )}
                    <ChevronDown
                      className={`size-4 flex-none text-[#5c574d] transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
                      aria-hidden
                    />
                  </button>
                  {isOpen && (
                    <div className="flex flex-col pb-1.5">
                      {s.items.map((it) => (
                        <ItemLink key={it.id} it={it} indent />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </nav>

        <div className="border-apollo-border bg-apollo-surface flex flex-none flex-col border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {name && (
            <div className="flex min-h-12 items-center gap-2.5 px-2">
              <span
                className="bg-apollo-surface-2 flex size-8 items-center justify-center rounded-full text-xs font-semibold text-[#5c574d]"
                aria-hidden
              >
                {initials}
              </span>
              <span className="flex-1 truncate text-sm font-medium">{name}</span>
              <form action="/api/auth/logout" method="POST">
                <button
                  type="submit"
                  className="px-2 py-3 text-[13px] text-[#5c574d] hover:underline"
                >
                  Sign out
                </button>
              </form>
            </div>
          )}
          <Link
            href="/"
            className="flex min-h-11 items-center gap-2 px-2 text-sm text-[#1f1b19] hover:underline"
            onClick={() => setOpen(false)}
          >
            Go to public Scholars site
            <ArrowUpRight className="size-[13px]" aria-hidden />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
