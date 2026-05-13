"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import { sanitizePubTitle } from "@/lib/utils";
import type { MenteeChip, CoPublication, MenteeSort } from "@/lib/api/mentoring";
import {
  MENTORING_GROUPED_THRESHOLD,
  MENTORING_TRUNCATE_THRESHOLD,
  MENTORING_TRUNCATE_LIMIT,
  formatProgramLabel,
  menteeTerminalYear,
  partitionMenteesByBucket,
  truncateGroupedMentees,
} from "@/lib/mentoring-labels";

export function MentoringSection({
  mentees,
  mentorSlug,
  currentSort = "copubs",
}: {
  mentees: MenteeChip[];
  /** Kept for telemetry symmetry with the mentee CWID even though the
   *  badge link / View-all link only need `mentorSlug` to build URLs. */
  mentorCwid: string;
  mentorSlug: string;
  /** Issue #201 (Slice B2) — current sort, resolved server-side from
   *  `?mentees-sort=` and passed down. The sort selector at the controlled
   *  tier reads it to highlight the active option; `getMenteesForMentor`
   *  has already ordered `mentees` accordingly. Below the truncate
   *  threshold the prop is informational only — no selector renders. */
  currentSort?: MenteeSort;
}) {
  // Single-expand-at-a-time: the chip whose badge is currently expanded.
  // null means no chip is expanded. Tracked on the section so opening one
  // chip implicitly closes another. (#185)
  const [expandedCwid, setExpandedCwid] = React.useState<string | null>(null);

  // Issue #201 (Slice B2) — at the controlled tier, the grid is truncated
  // to the top `MENTORING_TRUNCATE_LIMIT` chips by default. The "Show all
  // N →" affordance flips this to true; "Show fewer ↑" flips it back.
  // Not persisted (URL or storage) — purely local UI state.
  const [showAll, setShowAll] = React.useState(false);

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

  const toggleChip = (cwid: string) =>
    setExpandedCwid((cur) => (cur === cwid ? null : cwid));

  // Issue #201 SPEC §7.3 — sort change and truncation toggle both collapse
  // any expanded chip. The row that owned the expansion may no longer be
  // in the visible set, may have moved to a different bucket, or (in the
  // class-year → copubs flatten case) may have lost its grouping context
  // entirely. Cleanly closing is better than leaking the expanded state
  // into a re-rendered grid.
  const onSortChange = () => setExpandedCwid(null);
  const toggleShowAll = () => {
    setExpandedCwid(null);
    setShowAll((v) => !v);
  };

  const isControlledTier = mentees.length >= MENTORING_TRUNCATE_THRESHOLD;
  const isGroupedTier = mentees.length >= MENTORING_GROUPED_THRESHOLD;

  // Flat tier (N < 8) — no grouping, no controls. Unchanged from
  // pre-Slice-B render; the data layer has already sorted by `currentSort`.
  if (!isGroupedTier) {
    return (
      <ul className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        {mentees.map((m) => (
          <MenteeChipCard
            key={m.cwid}
            mentee={m}
            mentorSlug={mentorSlug}
            isExpanded={expandedCwid === m.cwid}
            onToggle={() => toggleChip(m.cwid)}
          />
        ))}
      </ul>
    );
  }

  // Controlled tier + sort = "copubs" — flat top-12 with truncation
  // affordance. Per SPEC §5.2, the copubs sort flattens grouping: a
  // chip's bucket would be implicit in `programName` on its subtitle
  // (already there), but the section-level grouping disappears so the
  // user sees a pure collaboration ranking.
  if (isControlledTier && currentSort === "copubs") {
    const visible = showAll
      ? mentees
      : mentees.slice(0, MENTORING_TRUNCATE_LIMIT);
    const hidden = mentees.length - visible.length;
    return (
      <div>
        <MentoringSortSelector
          currentSort={currentSort}
          mentorSlug={mentorSlug}
          onChange={onSortChange}
        />
        <ul className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
          {visible.map((m) => (
            <MenteeChipCard
              key={m.cwid}
              mentee={m}
              mentorSlug={mentorSlug}
              isExpanded={expandedCwid === m.cwid}
              onToggle={() => toggleChip(m.cwid)}
            />
          ))}
        </ul>
        {(hidden > 0 || showAll) && (
          <ShowAllToggle
            showAll={showAll}
            totalCount={mentees.length}
            onClick={toggleShowAll}
          />
        )}
      </div>
    );
  }

  // Grouped tier — applies at 8 ≤ N < 12 (no controls) and at N ≥ 12
  // when `currentSort` is "class-year". The data layer sort may be
  // "copubs" at the lower grouped tier (no selector → URL never carries
  // class-year there); re-sort within buckets so within-group order is
  // class-year-desc per SPEC §4.2 / §6.2 regardless of what the data
  // layer returned.
  const orderedForGrouping =
    currentSort === "copubs"
      ? [...mentees].sort((a, b) => {
          const byYear = menteeTerminalYear(b) - menteeTerminalYear(a);
          if (byYear !== 0) return byYear;
          return a.fullName.localeCompare(b.fullName);
        })
      : mentees;
  const allGroups = partitionMenteesByBucket(orderedForGrouping);

  // Truncation applies only at the controlled tier and only when
  // collapsed. Below the truncate threshold or when "Show all" is on,
  // every chip renders in full and no continuation indicators appear.
  const truncated =
    isControlledTier && !showAll
      ? truncateGroupedMentees(allGroups, MENTORING_TRUNCATE_LIMIT)
      : { visible: allGroups.map((g) => ({ ...g, hiddenInGroup: 0 })), totalHidden: 0 };

  return (
    <div>
      {isControlledTier && (
        <MentoringSortSelector
          currentSort={currentSort}
          mentorSlug={mentorSlug}
          onChange={onSortChange}
        />
      )}
      <div className="space-y-6">
        {truncated.visible.map((g) => (
          <div key={g.bucket} role="group" aria-label={`${g.bucket} mentees`}>
            <h3 className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
              {/* Bucket header count is always the TOTAL in this bucket
                  (visible + hidden). When the bucket is mid-cut,
                  `g.mentees.length` is just the visible chip count, so
                  add `hiddenInGroup` to recover the total. Buckets that
                  are entirely above the cut have hiddenInGroup=0, so the
                  arithmetic still gives the correct number there. */}
              {g.bucket} · {g.mentees.length + g.hiddenInGroup}
            </h3>
            <ul className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              {g.mentees.map((m) => (
                <MenteeChipCard
                  key={m.cwid}
                  mentee={m}
                  mentorSlug={mentorSlug}
                  isExpanded={expandedCwid === m.cwid}
                  onToggle={() => toggleChip(m.cwid)}
                />
              ))}
            </ul>
            {g.hiddenInGroup > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                … and {g.hiddenInGroup} more
              </p>
            )}
          </div>
        ))}
      </div>
      {isControlledTier && (truncated.totalHidden > 0 || showAll) && (
        <ShowAllToggle
          showAll={showAll}
          totalCount={mentees.length}
          onClick={toggleShowAll}
        />
      )}
    </div>
  );
}

function ShowAllToggle({
  showAll,
  totalCount,
  onClick,
}: {
  showAll: boolean;
  totalCount: number;
  onClick: () => void;
}) {
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onClick}
        className="text-sm font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
      >
        {showAll ? "Show fewer ↑" : `Show all ${totalCount} →`}
      </button>
    </div>
  );
}

/** Issue #201 (Slice B2) — sort selector. Custom popover-styled button to
 *  match Publications' `PositionMultiSelect` trigger so the two filters
 *  feel like the same family. Single-select; "Co-publications" is the
 *  default and stripped from the URL on selection, "Class year"
 *  serializes as `?mentees-sort=class-year`. */
function MentoringSortSelector({
  currentSort,
  mentorSlug,
  onChange,
}: {
  currentSort: MenteeSort;
  mentorSlug: string;
  onChange: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: MenteeSort) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next === currentSort) return;
    onChange();
    // `router.replace` keeps the operation out of the browser's history
    // stack — sort selection isn't a navigation the user should be able
    // to "back" into. Co-pubs is the default; strip the param so the
    // canonical URL is restored.
    const base = `/scholars/${mentorSlug}`;
    if (next === "copubs") {
      router.replace(base);
    } else {
      router.replace(`${base}?mentees-sort=class-year`);
    }
  };

  const summary = currentSort === "copubs" ? "Co-publications" : "Class year";

  return (
    <div ref={wrapperRef} className="relative mb-4 inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Mentee sort"
        onClick={() => setOpen((v) => !v)}
        className="border-border-strong inline-flex h-7 items-center gap-1 rounded-full border bg-background px-3 text-sm hover:border-[var(--color-accent-slate)]"
      >
        <span className="text-muted-foreground">Sort:</span>
        <span>{summary}</span>
        <ChevronDown
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-20 mt-1 w-[200px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {(
            [
              { key: "copubs", label: "Co-publications" },
              { key: "class-year", label: "Class year" },
            ] as const
          ).map(({ key, label }) => {
            const selected = key === currentSort;
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(key)}
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground ${
                  selected ? "font-medium" : ""
                }`}
              >
                <span>{label}</span>
                {selected ? <span aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
