"use client";

/**
 * Reusable author-chip row for publication cards across surfaces.
 *
 * Shows up to CHIP_CAP WCM coauthors as small rounded chips with headshot +
 * preferred name. Border color signals authorship role per design spec v1.7.1:
 *   - first author  → slate-blue border (--color-accent-slate)
 *   - senior author → amber/bronze border (last position)
 *   - co-author     → neutral zinc border
 * Tooltip on hover/focus reveals the role label. Overflow beyond CHIP_CAP is
 * shown as a "+N more →" pill (no link target — non-blocking visual cue).
 *
 * Used by:
 *   - components/topic/publication-feed.tsx (topic page paginated feed)
 *   - app/(public)/search/page.tsx (publication search results)
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { PersonPopover } from "@/components/scholar/person-popover";

export type AuthorChip = {
  name: string;
  cwid?: string | null;
  slug?: string | null;
  identityImageEndpoint?: string | null;
  isFirst: boolean;
  isLast: boolean;
};

const CHIP_CAP = 5;

function chipBorderClass(isFirst: boolean, isLast: boolean): string {
  // Last takes precedence over first when both are true (single-author paper)
  // because senior-author signal is more specific than first-author signal.
  if (isLast) return "border-amber-700/70 hover:bg-amber-50";
  if (isFirst) return "border-[var(--color-accent-slate)] hover:bg-[rgba(44,79,110,0.06)]";
  return "border-zinc-300 hover:bg-zinc-50";
}

function chipRoleLabel(
  isFirst: boolean,
  isLast: boolean,
  firstCount: number,
  lastCount: number,
): string {
  // Co-first / co-last: when ≥2 authors on the same publication share the
  // flag, surface "co-first author" / "co-last author" in the tooltip. (#18)
  if (isFirst && isLast) return "First and senior author";
  if (isFirst) return firstCount > 1 ? "Co-first author" : "First author";
  if (isLast) return lastCount > 1 ? "Co-last author" : "Senior author";
  return "Co-author";
}

export function AuthorChipRow({
  authors,
  pinnedCwids,
  pmid,
  currentProfileCwid,
}: {
  authors: AuthorChip[];
  /** CWIDs that must always render visibly regardless of the CHIP_CAP
   *  truncation. Surface-specific load-bearing authors (e.g. the
   *  mentor and mentee on the co-pubs page) are promoted to the front
   *  of the visible slice; non-pinned authors fill the rest, preserving
   *  their original (authorship) order. */
  pinnedCwids?: ReadonlyArray<string>;
  /** Pub PMID for #242 — drives the authorship-role pill and "recent pubs"
   *  fetch inside PersonPopover. When absent, the popover still renders but
   *  without the role pill. */
  pmid?: string;
  /** Scholar whose profile the chip row is rendered on, when applicable —
   *  enables PersonPopover's self-hover guard + co-pub action. */
  currentProfileCwid?: string;
}) {
  if (authors.length === 0) return null;
  // A chip needs a cwid to render the headshot identity. Linked authors
  // (slug + cwid) wrap in an anchor to the profile; unlinked WCM authors
  // — primarily alumni without a Scholar row — render as a static span
  // so they still appear in the author row. Non-WCM authors (no cwid)
  // are dropped: they have no chip identity and live in the unstructured
  // authorsString instead. (#186)
  const renderable = authors.filter((a) => a.cwid);
  if (renderable.length === 0) return null;

  // Promote pinned CWIDs to the front while preserving the pin-order
  // declared by the caller, then append remaining authors in their
  // original authorship-order. Without pins this is a no-op.
  const pinned = pinnedCwids ?? [];
  const ordered = pinned.length === 0
    ? renderable
    : [
        ...pinned
          .map((cwid) => renderable.find((a) => a.cwid === cwid))
          .filter((a): a is AuthorChip => a !== undefined),
        ...renderable.filter((a) => !pinned.includes(a.cwid!)),
      ];

  const visible = ordered.slice(0, CHIP_CAP);
  const overflow = ordered.length - CHIP_CAP;
  // Counts taken across the full author list (not just the visible slice) so
  // co-first / co-last labels are accurate even when some co-* authors are
  // hidden behind the +N overflow chip. (#18)
  const firstCount = authors.filter((a) => a.isFirst).length;
  const lastCount = authors.filter((a) => a.isLast).length;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {visible.map((a, i) => {
        const chipClass = `inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs text-foreground transition-colors ${chipBorderClass(
          a.isFirst,
          a.isLast,
        )}`;
        const inner = (
          <>
            <HeadshotAvatar
              size="sm"
              cwid={a.cwid!}
              preferredName={a.name}
              identityImageEndpoint={a.identityImageEndpoint ?? ""}
            />
            <span>{a.name}</span>
          </>
        );
        const tooltipText = chipRoleLabel(a.isFirst, a.isLast, firstCount, lastCount);
        const inlineChip = a.slug ? (
          <a href={`/scholars/${a.slug}`} className={chipClass}>
            {inner}
          </a>
        ) : (
          <span className={chipClass}>{inner}</span>
        );
        // PersonPopover supersedes HoverTooltip when we have authorship context
        // (the pmid + the author's cwid). Without context (no pmid passed by
        // the caller), fall back to the legacy tooltip — same as today.
        if (!pmid) {
          return (
            <HoverTooltip key={`${a.cwid}-${i}`} text={tooltipText}>
              {inlineChip}
            </HoverTooltip>
          );
        }
        const surface: "pub-chip" | "co-author" =
          currentProfileCwid && a.cwid !== currentProfileCwid ? "co-author" : "pub-chip";
        return (
          <PersonPopover
            key={`${a.cwid}-${i}`}
            cwid={a.cwid!}
            surface={surface}
            contextPubPmid={pmid}
            contextScholarCwid={
              surface === "co-author" ? currentProfileCwid : undefined
            }
            currentProfileCwid={currentProfileCwid}
          >
            {inlineChip}
          </PersonPopover>
        );
      })}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-full border border-zinc-300 bg-background px-2.5 py-0.5 text-xs text-muted-foreground">
          +{overflow} more →
        </span>
      )}
    </div>
  );
}
