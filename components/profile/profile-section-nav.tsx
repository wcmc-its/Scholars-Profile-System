"use client";

/**
 * "On this page" jump-list for the profile rail.
 *
 * A populated profile runs several thousand pixels (Highlights → Publications →
 * Funding → … → External relationships), and the rail is already sticky, so the
 * cheapest navigation win is a section jump-list that rides along with it.
 *
 * Presence is read from the DOM instead of being duplicated from ProfileView's
 * render conditions: a section opts in by passing `id` to <Section>, so one that
 * did not render has no element and drops out of this nav on its own. That is
 * what keeps the list from silently desyncing when a section's gating changes —
 * SECTIONS below owns only the ORDER and the LABELS, never the presence rule.
 *
 * Scroll-spy recomputes the active section on every IntersectionObserver fire
 * rather than trusting each entry's `isIntersecting`. A direct jump (anchor on
 * load, or clicking an item here) moves past several headings without any of
 * them crossing the observer band, and the naive version keeps highlighting
 * whichever section scrolled by last.
 */
import { useEffect, useState } from "react";
import { SidebarCard } from "@/components/profile/sidebar-card";

type NavSection = { id: string; label: string };

/** Order mirrors ProfileView's render order; labels are what the rail shows. */
const SECTIONS: ReadonlyArray<NavSection> = [
  { id: "overview", label: "Overview" },
  { id: "highlights", label: "Highlights" },
  { id: "publications", label: "Publications" },
  { id: "funding", label: "Funding" },
  { id: "honors", label: "Honors & Distinctions" },
  { id: "clinical-research", label: "Clinical research" },
  { id: "technologies", label: "Available technologies" },
  { id: "news", label: "News mentions" },
  { id: "mentoring", label: "Mentoring" },
  { id: "external-relationships", label: "External relationships" },
];

export function ProfileSectionNav() {
  const [present, setPresent] = useState<ReadonlyArray<NavSection>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Runs after hydration, once: every <Section id> is in the server-rendered
  // HTML (only the publications *cluster* streams, not the section wrappers).
  useEffect(() => {
    const found = SECTIONS.filter((s) => document.getElementById(s.id));
    // A single-entry jump-list is noise, not navigation.
    setPresent(found.length > 1 ? found : []);
  }, []);

  useEffect(() => {
    if (present.length === 0) return;
    const els = present
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    const first = els[0];
    if (!first) return;

    const spy = () => {
      // The section we are *in* is the last one whose top cleared the header.
      let current: HTMLElement = first;
      for (const el of els) {
        if (el.getBoundingClientRect().top > 100) break;
        current = el;
      }
      setActiveId(current.id);
    };

    const io = new IntersectionObserver(spy, {
      rootMargin: "-88px 0px -70% 0px",
      threshold: 0,
    });
    els.forEach((el) => io.observe(el));
    spy();
    return () => io.disconnect();
  }, [present]);

  if (present.length === 0) return null;

  return (
    // The rail is sticky only at md+; below that it stacks above the content,
    // where a jump-list is just one more block to scroll past.
    <div className="hidden md:block">
      <SidebarCard title="On this page">
        <ul className="flex flex-col">
          {present.map((s) => {
            const active = s.id === activeId;
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={active ? "location" : undefined}
                  onClick={(e) => {
                    const el = document.getElementById(s.id);
                    if (!el) return; // fall back to the browser's own jump
                    e.preventDefault();
                    const reduce = window.matchMedia(
                      "(prefers-reduced-motion: reduce)",
                    ).matches;
                    el.scrollIntoView({
                      behavior: reduce ? "auto" : "smooth",
                      block: "start",
                    });
                    // Keep the URL shareable without re-triggering a hash jump.
                    history.replaceState(null, "", `#${s.id}`);
                  }}
                  className={
                    active
                      ? "block border-l-2 border-[var(--color-primary-cornell-red)] py-1.5 pl-3 text-[13px] font-medium leading-tight text-[var(--color-primary-cornell-red)] transition-colors"
                      : "text-muted-foreground hover:text-foreground block border-l-2 border-transparent py-1.5 pl-3 text-[13px] leading-tight transition-colors"
                  }
                >
                  {s.label}
                </a>
              </li>
            );
          })}
        </ul>
      </SidebarCard>
    </div>
  );
}
