"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import { sanitizePubTitle } from "@/lib/utils";
import type { MenteeChip, CoPublication } from "@/lib/api/mentoring";

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
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
  const programLabel = formatProgramLabel(mentee.programType);
  const yearLabel = mentee.graduationYear ? `Class of ${mentee.graduationYear}` : null;
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

  // Resting container styling — same chip card as #184. When expanded
  // the chip spans the full grid row so the inline-preview content has
  // room to breathe and adjacent chips reflow below.
  const containerClasses = [
    isLinked
      ? "rounded-md border border-border bg-zinc-50 transition-colors has-[[data-mentee-body]:hover]:bg-zinc-100 dark:bg-zinc-900/40 dark:has-[[data-mentee-body]:hover]:bg-zinc-900/60"
      : "rounded-md border border-border border-dashed bg-transparent opacity-80",
    isExpanded ? "sm:col-span-2" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
      {isExpanded && count > 0 && (
        <CoPubInlinePanel
          panelId={panelId}
          mentee={mentee}
          mentorSlug={mentorSlug}
        />
      )}
    </li>
  );
}

function CoPubInlinePanel({
  panelId,
  mentee,
  mentorSlug,
}: {
  panelId: string;
  mentee: MenteeChip;
  mentorSlug: string;
}) {
  return (
    <div
      id={panelId}
      role="region"
      aria-label={`Publications co-authored with ${mentee.fullName}`}
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

/** Map raw `reporting_students_mentors.programType` codes to user-facing
 *  labels. AOC and AOC-2025 are the same scholarly-concentration program
 *  and collapse to the same "MD mentee" bucket — the AOC acronym is not
 *  exposed in the UI because it's not widely recognized outside the
 *  registrar / Grad School audience. */
function formatProgramLabel(programType: string | null): string | null {
  if (!programType) return null;
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD mentee";
  if (programType === "MDPHD") return "MD-PhD mentee";
  if (programType === "ECR") return "Early career mentee";
  return programType;
}
