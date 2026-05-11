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

import { useEffect, useId, useState } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { SubtopicScholarRowData } from "@/lib/api/topics";

const INLINE_CAP = 10;

export function SubtopicScholarsRow({
  topicSlug,
  subtopicId,
  subtopicLabel,
}: {
  topicSlug: string;
  subtopicId: string;
  subtopicLabel: string | null;
}) {
  const [scholars, setScholars] = useState<SubtopicScholarRowData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

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
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScholars([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [topicSlug, subtopicId]);

  if (loading || !scholars || scholars.length === 0) return null;

  const visible = expanded ? scholars : scholars.slice(0, INLINE_CAP);
  const overflow = scholars.length - visible.length;

  return (
    <div className="mb-6">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {subtopicLabel
          ? `Researchers in ${subtopicLabel} · ${scholars.length}`
          : `Researchers in this subtopic · ${scholars.length}`}
      </div>
      <div className="text-sm leading-relaxed">
        {visible.map((s, i) => (
          <span key={s.cwid}>
            <ResearcherNameLink scholar={s} />
            {i < visible.length - 1 ? (
              <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">
                ·
              </span>
            ) : null}
          </span>
        ))}
        {overflow > 0 && (
          <>
            <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">
              ·
            </span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline"
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
        href={`/scholars/${scholar.slug}`}
        aria-describedby={id}
        className="text-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
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
          href={`/scholars/${scholar.slug}`}
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
                <div className="text-xs text-muted-foreground/80">
                  {scholar.primaryDepartment}
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 border-t border-border/60 pt-2.5 text-xs leading-relaxed">
            <div className="text-foreground">
              {scholar.pubCountInSubtopic.toLocaleString()} publications in this subtopic
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
