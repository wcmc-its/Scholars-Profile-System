"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface NavItem {
  id: string;
  label: string;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * /docs scroll-spy sidebar (v0). Anchor nav over the single comprehensive docs
 * page; highlights the section currently in view. Hidden below lg (the content
 * stacks full-width). Mirrors the standalone v4 mockup's sidebar.
 */
export function DocsToc({ nav }: { nav: NavGroup[] }) {
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

  return (
    <nav
      aria-label="Documentation"
      className="hidden py-9 text-sm lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-auto"
    >
      {nav.map((g) => (
        <div key={g.group || "_top"} className="mb-4">
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
                className={
                  "block rounded-r border-l-2 px-2.5 py-1 " +
                  (isActive
                    ? "border-[#7d1c1c] bg-[#f6f7f9] font-semibold text-[#7d1c1c]"
                    : "border-transparent text-muted-foreground hover:text-[#7d1c1c]")
                }
              >
                {it.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
