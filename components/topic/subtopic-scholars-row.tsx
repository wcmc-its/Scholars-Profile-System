"use client";

/**
 * Subtopic researcher list (issue #172).
 *
 * Renders the researchers attributed to the currently selected subtopic as a
 * single inline middot-separated text list. Each name is a profile link that
 * opens a hover/focus preview popover showing the researcher's headshot,
 * title, department, and the subtopic-scoped vs. total publication counts —
 * the unique signal a user gets here that isn't surfaced on the chip view or
 * the profile page itself.
 *
 * Styling hierarchy: this list is intentionally lower-weight than the
 * page-level "Top Scholars in this area" chip row, because it represents a
 * filtered slice rather than the marquee identity for the whole research
 * area.
 *
 * Mobile: tap on a name navigates to the profile. The popover is desktop-only
 * (collapses to a hidden detail in narrow viewports, where rich page context
 * has scrolled away anyway).
 */

import { useEffect, useId, useRef, useState } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { ScholarPickList, type PickScholar } from "@/components/taxonomy/scholar-filter";
import { profilePath } from "@/lib/profile-url";
import type { SubtopicScholarRowData } from "@/lib/api/topics";

const INLINE_CAP = 10;

/** TAXONOMY_SCHOLAR_CARDS — when passed, the roster renders as pick-to-filter
 *  toggle cards (each with its own profile link) instead of name links. */
export type SubtopicScholarsPick = {
  selectedCwid: string | null;
  onToggle: (s: PickScholar) => void;
  onRosterLoaded: (roster: PickScholar[]) => void;
};

export function SubtopicScholarsRow({
  topicSlug,
  subtopicId,
  subtopicLabel,
  pick,
}: {
  topicSlug: string;
  subtopicId: string;
  subtopicLabel: string | null;
  pick?: SubtopicScholarsPick;
}) {
  const [scholars, setScholars] = useState<SubtopicScholarRowData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Read through a ref so a new callback identity never re-triggers the fetch.
  const onRosterLoadedRef = useRef(pick?.onRosterLoaded);
  onRosterLoadedRef.current = pick?.onRosterLoaded;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setScholars(null);
    setExpanded(false);
    fetch(
      `/api/topics/${encodeURIComponent(topicSlug)}/subtopics/${encodeURIComponent(subtopicId)}/scholars`,
    )
      .then((r) => (r.ok ? r.json() : { scholars: [] }))
      .then((data: { scholars: SubtopicScholarRowData[] }) => {
        if (!cancelled) {
          setScholars(data.scholars ?? []);
          setLoading(false);
          onRosterLoadedRef.current?.(data.scholars ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScholars([]);
          setLoading(false);
          onRosterLoadedRef.current?.([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [topicSlug, subtopicId]);

  if (loading || !scholars || scholars.length === 0) return null;

  const visible = expanded ? scholars : scholars.slice(0, INLINE_CAP);
  const overflow = scholars.length - visible.length;

  if (pick) {
    // Keep a picked scholar visible even when they sit past the inline cap.
    const pickedHidden =
      pick.selectedCwid !== null &&
      !visible.some((s) => s.cwid === pick.selectedCwid) &&
      scholars.some((s) => s.cwid === pick.selectedCwid);
    const cards = pickedHidden ? scholars : visible;
    const more = scholars.length - cards.length;
    return (
      <ScholarPickList
        heading={
          subtopicLabel
            ? `Researchers in ${subtopicLabel} · ${scholars.length}`
            : `Researchers in this subarea · ${scholars.length}`
        }
        scholars={cards}
        selectedCwid={pick.selectedCwid}
        onToggle={pick.onToggle}
        footer={
          more > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 inline-flex min-h-11 items-center text-[13.5px] text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
            >
              + {more} more →
            </button>
          ) : null
        }
      />
    );
  }

  return (
    <div className="mb-6">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {subtopicLabel
          ? `Researchers in ${subtopicLabel} · ${scholars.length}`
          : `Researchers in this subarea · ${scholars.length}`}
      </div>
      {/* Spec: text-[14px], weight 500 names, line-height 2 (`leading-loose`
          in Tailwind = 2). Middot is `--border` color (faint, structural
          punctuation — not text-tertiary which would compete with content)
          with 8px gutters either side. No whitespace between </span> and the
          middot span so wrap behavior stays tight. */}
      <div className="text-[14px] leading-loose">
        {visible.flatMap((s, i) => {
          const nodes: React.ReactNode[] = [
            <ResearcherNameLink key={s.cwid} scholar={s} />,
          ];
          if (i < visible.length - 1) {
            nodes.push(
              <span
                key={`mid-${s.cwid}`}
                aria-hidden="true"
                className="mx-2 select-none text-border"
              >
                ·
              </span>,
            );
          }
          return nodes;
        })}
        {overflow > 0 && (
          <>
            <span aria-hidden="true" className="mx-2 select-none text-border">
              ·
            </span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-[13.5px] text-[var(--color-accent-slate)] underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
            >
              + {overflow} more →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Profile link with hover/focus preview popover. Tooltip is anchored via a
 * sibling `<span>` so it can extend below the link without affecting the
 * inline flow. CSS-only open/close on `:hover` / `:focus-within` keeps
 * keyboard parity without an extra state machine.
 */
function ResearcherNameLink({ scholar }: { scholar: SubtopicScholarRowData }) {
  const id = useId();
  return (
    <span className="group relative inline-block">
      <a
        href={profilePath(scholar.slug)}
        aria-describedby={id}
        // Spec: weight 500 at rest; hover/focus shows a faint gray underline,
        // no color shift. `:focus-visible` gets a 2px slate ring with offset
        // so keyboard users see a clear focus indicator on both white and
        // neutral backgrounds.
        className="font-medium text-foreground underline-offset-4 decoration-border hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)] focus-visible:no-underline"
      >
        {scholar.preferredName}
      </a>
      <span
        id={id}
        role="tooltip"
        // Hidden on mobile (no hover affordance, rich context has scrolled away).
        // Desktop: shown via group-hover and group-focus-within; small open delay
        // avoids flicker as the cursor crosses adjacent names.
        className="
          pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-72
          opacity-0 transition-opacity duration-150 ease-out
          group-hover:opacity-100 group-focus-within:opacity-100
          group-hover:pointer-events-auto group-focus-within:pointer-events-auto
          md:block
        "
        style={{ transitionDelay: "var(--popover-delay, 180ms)" }}
      >
        <a
          href={profilePath(scholar.slug)}
          tabIndex={-1}
          className="block rounded-md border border-border bg-popover p-3.5 shadow-lg ring-1 ring-black/5"
        >
          <div className="flex items-start gap-3">
            <HeadshotAvatar
              size="md"
              cwid={scholar.cwid}
              preferredName={scholar.preferredName}
              identityImageEndpoint={scholar.identityImageEndpoint}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {scholar.preferredName}
              </div>
              {scholar.primaryTitle ? (
                <div className="text-xs text-muted-foreground">
                  {scholar.primaryTitle}
                </div>
              ) : null}
              {scholar.primaryDepartment ? (
                <div className="text-xs text-muted-foreground">
                  {scholar.primaryDepartment}
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 border-t border-border/60 pt-2.5 text-xs leading-relaxed">
            <div className="text-foreground">
              {scholar.pubCountInSubtopic.toLocaleString()} publications in this subarea
            </div>
            <div className="text-muted-foreground">
              {scholar.pubCountTotal.toLocaleString()} publications total
            </div>
          </div>
          <div className="mt-2 text-xs font-medium text-[var(--color-accent-slate)]">
            View profile →
          </div>
        </a>
      </span>
    </span>
  );
}
