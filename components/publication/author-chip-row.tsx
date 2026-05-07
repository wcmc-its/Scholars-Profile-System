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
import { useEffect, useRef, useState } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

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

function chipRoleLabel(isFirst: boolean, isLast: boolean): string {
  if (isFirst && isLast) return "First and senior author";
  if (isFirst) return "First author";
  if (isLast) return "Senior author";
  return "Co-author";
}

function ChipWithTooltip({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showDelayed = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(true), 200);
  };
  const showNow = () => {
    if (timer.current) clearTimeout(timer.current);
    setVisible(true);
  };
  const hide = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setVisible(false);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div
      className="relative"
      onMouseEnter={showDelayed}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow"
        >
          {text}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-zinc-900"
            style={{ width: 0, height: 0 }}
          />
        </div>
      )}
    </div>
  );
}

export function AuthorChipRow({ authors }: { authors: AuthorChip[] }) {
  if (authors.length === 0) return null;
  const visible = authors.slice(0, CHIP_CAP);
  const overflow = authors.length - CHIP_CAP;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {visible.map((a, i) =>
        a.slug && a.cwid ? (
          <ChipWithTooltip key={`${a.cwid}-${i}`} text={chipRoleLabel(a.isFirst, a.isLast)}>
            <a
              href={`/scholars/${a.slug}`}
              className={`inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs text-foreground transition-colors ${chipBorderClass(
                a.isFirst,
                a.isLast,
              )}`}
            >
              <HeadshotAvatar
                size="sm"
                cwid={a.cwid}
                preferredName={a.name}
                identityImageEndpoint={a.identityImageEndpoint ?? ""}
              />
              <span>{a.name}</span>
            </a>
          </ChipWithTooltip>
        ) : null,
      )}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-full border border-zinc-300 bg-background px-2.5 py-0.5 text-xs text-muted-foreground">
          +{overflow} more →
        </span>
      )}
    </div>
  );
}
