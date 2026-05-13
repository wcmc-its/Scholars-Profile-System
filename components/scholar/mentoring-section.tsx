"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import { sanitizePubTitle } from "@/lib/utils";
import type { MenteeChip, CoPublication } from "@/lib/api/mentoring";
import { formatProgramLabel } from "@/lib/mentoring-labels";

export function MentoringSection({
  mentees,
  mentorSlug,
}: {
  mentees: MenteeChip[];
  /** Kept for telemetry symmetry with the mentee CWID even though the
   *  badge link / View-all link only need `mentorSlug` to build URLs. */
  mentorCwid: string;
  mentorSlug: string;
}) {
  // Single-expand-at-a-time: the chip whose badge is currently expanded.
  // null means no chip is expanded. Tracked on the section so opening one
  // chip implicitly closes another. (#185)
  const [expandedCwid, setExpandedCwid] = React.useState<string | null>(null);

  // Escape closes whichever chip is open. We attach a single window-level
  // handler on the section rather than per chip so the listener count
  // stays at one regardless of mentee count.
  React.useEffect(() => {
    if (expandedCwid === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedCwid(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedCwid]);

  if (mentees.length === 0) return null;

  return (
    <ul className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
      {mentees.map((m) => (
        <MenteeChipCard
          key={m.cwid}
          mentee={m}
          mentorSlug={mentorSlug}
          isExpanded={expandedCwid === m.cwid}
          onToggle={() =>
            setExpandedCwid((cur) => (cur === m.cwid ? null : m.cwid))
          }
        />
      ))}
    </ul>
  );
}

function MenteeChipCard({
  mentee,
  mentorSlug,
  isExpanded,
  onToggle,
}: {
  mentee: MenteeChip;
  mentorSlug: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isLinked = mentee.scholar !== null;
  // Issue #195 — prefer the human-readable program name (ED authoritative,
  // Jenzabar fallback) over the degree-bucket label. When neither source
  // has a record, fall back to "PhD" / "MD-PhD" / "MD mentee" etc.
  const programLabel = mentee.programName ?? formatProgramLabel(mentee.programType);
  // "Class of N" for AOC/PhD mentees; "YYYY–YYYY" or "since YYYY" for
  // postdocs (issue #183). Postdocs don't graduate, so forcing them into
  // the "Class of" string was misleading; the appointmentRange field
  // carries the real date window from the SOR role record.
  const yearLabel = mentee.graduationYear
    ? `Class of ${mentee.graduationYear}`
    : mentee.appointmentRange
      ? mentee.appointmentRange.endYear
        ? `${mentee.appointmentRange.startYear}–${mentee.appointmentRange.endYear}`
        : `since ${mentee.appointmentRange.startYear}`
      : null;
  const displayName = mentee.scholar?.publishedName ?? mentee.fullName;
  const count = mentee.copublicationCount;
  const panelId = React.useId();

  const body = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <HeadshotAvatar
        size="sm"
        cwid={mentee.cwid}
        preferredName={mentee.fullName}
        identityImageEndpoint={mentee.identityImageEndpoint}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{displayName}</div>
        <div className="text-muted-foreground text-xs leading-snug">
          {[programLabel, yearLabel].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );

  // The badge is a button that toggles inline expansion. The dedicated
  // co-pubs page (#184) is reached via the "View all N →" link inside
  // the expanded panel — shown at every N so the page stays reachable
  // for export / sharing even when all rows are visible inline.
  const badge =
    count > 0 ? (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={`View ${count} publication${count === 1 ? "" : "s"} co-authored with ${mentee.fullName}`}
        className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Badge
          variant={isExpanded ? "default" : "secondary"}
          className="inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800"
        >
          {count} co-pub{count === 1 ? "" : "s"}
          <ChevronDown
            aria-hidden="true"
            className={`size-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          />
        </Badge>
      </button>
    ) : null;

  // Resting container styling — same chip card as #184. The chip stays
  // in its grid column when expanded; the inline panel grows below the
  // header via a grid-template-rows transition so siblings reflow
  // smoothly instead of snapping. (#185)
  const containerClasses = isLinked
    ? "rounded-md border border-border bg-zinc-50 transition-colors has-[[data-mentee-body]:hover]:bg-zinc-100 dark:bg-zinc-900/40 dark:has-[[data-mentee-body]:hover]:bg-zinc-900/60"
    : "rounded-md border border-border border-dashed bg-transparent opacity-80";

  return (
    <li className={containerClasses}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {isLinked ? (
          <a
            href={`/scholars/${mentee.scholar!.slug}`}
            data-mentee-body
            className="flex min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </a>
        ) : (
          body
        )}
        {badge}
      </div>
      {/*
        Animated height transition: an outer grid whose single row goes
        from `0fr` (collapsed) to `1fr` (expanded) animates from height 0
        to the natural content height without a fixed max-height. The
        inner `overflow-hidden` clips the content while the row is
        shorter than its natural height. (#185)
        The panel stays in the DOM at all times so CSS transitions fire;
        aria-hidden + inert keep it out of the accessibility tree and
        the tab order while collapsed.
      */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        aria-hidden={!isExpanded}
      >
        <div className="overflow-hidden">
          {count > 0 && (
            <CoPubInlinePanel
              panelId={panelId}
              mentee={mentee}
              mentorSlug={mentorSlug}
              isExpanded={isExpanded}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function CoPubInlinePanel({
  panelId,
  mentee,
  mentorSlug,
  isExpanded,
}: {
  panelId: string;
  mentee: MenteeChip;
  mentorSlug: string;
  isExpanded: boolean;
}) {
  return (
    <div
      id={panelId}
      role="region"
      aria-label={`Publications co-authored with ${mentee.fullName}`}
      // While collapsed the panel is height-zero and clipped by the
      // outer wrapper; mark it inert so its tab stops and pointer
      // targets don't leak into the closed state.
      inert={!isExpanded ? true : undefined}
      className="border-t border-border px-3 py-2.5"
    >
      <ul className="space-y-2">
        {mentee.copublicationPreview.map((p) => (
          <li key={p.pmid} className="text-xs leading-snug">
            <a
              href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium hover:underline"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(p.title) }}
            />
            {(p.journal || p.year) && (
              <div className="text-muted-foreground mt-0.5">
                {[p.journal, p.year].filter(Boolean).join(" · ")}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <a
          href={`/scholars/${mentorSlug}/co-pubs/${mentee.cwid}`}
          className="text-xs font-medium underline-offset-2 hover:underline"
        >
          View all {mentee.copublicationCount} →
        </a>
      </div>
    </div>
  );
}

