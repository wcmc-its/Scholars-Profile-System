"use client";

/**
 * The Profiles roster's scholar cell: headshot + name, with a hover card
 * (~300ms) summarising the profile — larger headshot, person type, current
 * titles, an overview excerpt, and a public-profile link. A client module on
 * purpose: composing Radix HoverCard inside the server-rendered roster drops the
 * subtree at SSR (see `components/edit/matcha-tab.tsx` for the same rule).
 *
 * Hover-only by design — phones get no card, and the name link must still work
 * there: Radix's trigger preventDefaults `touchstart`, which on iOS cancels the
 * link's click, so `onTouchEnd` re-issues it (the #2588 pattern in matcha-tab).
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { identityImageEndpoint } from "@/lib/headshot";
import { profilePath } from "@/lib/profile-url";
import { cn, initials } from "@/lib/utils";

export type RosterCardTitle = { title: string; organization: string; isPrimary: boolean };

export type RosterScholarCellProps = {
  cwid: string;
  name: string;
  slug: string | null;
  editHref: string;
  hasHeadshot: boolean;
  isVisible: boolean;
  leadership: string | null;
  /** "Title · Unit" line under the name. */
  subtitle: string | null;
  /** Display label, formatted server-side. */
  personType: string | null;
  titles: ReadonlyArray<RosterCardTitle>;
  hasOverview: boolean;
  /** "Imported" / "Edited Jun 18, 2026" — formatted server-side (no TZ drift). */
  overviewLabel: string | null;
  overviewExcerpt: string | null;
};

/**
 * Headshot circle, fetched lazily (only rows on screen load). No photo on file —
 * or not yet probed — is a dashed circle with initials, so a gap never looks
 * like a photo.
 * ponytail: the directory API serves one size; add a sized variant if it ever
 * takes one (the plan was 72px for the 36px circle on retina).
 */
function Headshot({
  cwid,
  name,
  present,
  px,
}: {
  cwid: string;
  name: string;
  present: boolean;
  px: number;
}) {
  const style = { width: px, height: px };
  if (!present) {
    return (
      <span
        style={style}
        className={cn(
          "border-apollo-border-strong text-muted-foreground flex shrink-0 items-center justify-center rounded-full border border-dashed font-medium",
          px > 40 ? "text-2xl" : "text-[11px]",
        )}
        aria-label="No headshot"
        title="No headshot"
        data-testid={px > 40 ? undefined : `roster-avatar-missing-${cwid}`}
      >
        {initials(name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external directory image, lazy by design
    <img
      src={identityImageEndpoint(cwid)}
      alt=""
      loading="lazy"
      width={px}
      height={px}
      style={style}
      className="shrink-0 rounded-full object-cover object-top"
    />
  );
}

const SECTION = "border-apollo-border border-t px-4 py-3";
const LABEL = "text-apollo-ink-2 mb-2 text-[11px] font-semibold tracking-[0.08em] uppercase";

export function RosterScholarCell(p: RosterScholarCellProps) {
  // The trigger is w-fit: the card anchors to it, and at full cell width the
  // card opened past the cell's right edge, far from the name being hovered.
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <div className="flex w-fit max-w-full items-center gap-3">
          <Headshot cwid={p.cwid} name={p.name} present={p.hasHeadshot} px={36} />
          <div className="min-w-0">
            <Link
              href={p.editHref}
              onTouchEnd={(e) => {
                e.preventDefault();
                e.currentTarget.click();
              }}
              className="text-apollo-maroon font-medium hover:underline"
              data-testid={`roster-name-${p.cwid}`}
            >
              {p.name}
            </Link>{" "}
            <span className="text-muted-foreground font-mono text-xs">{p.cwid}</span>
            {!p.isVisible && (
              <span
                className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border ml-2 rounded-full border px-1.5 py-0.5 text-xs"
                data-testid={`roster-hidden-${p.cwid}`}
              >
                Hidden
              </span>
            )}
            {p.leadership && (
              <span className="bg-muted text-apollo-ink-2 ml-2 rounded px-1.5 py-0.5 text-xs">
                {p.leadership}
              </span>
            )}
            {p.subtitle && <div className="text-muted-foreground text-xs">{p.subtitle}</div>}
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        // Overlap the trigger a little: a wrapped subtitle makes the trigger as
        // wide as the cell, which left a gap between the text and the card.
        sideOffset={-40}
        className="text-apollo-ink w-[22rem] overflow-hidden p-0"
        data-testid={`roster-card-${p.cwid}`}
      >
        <div className="flex items-center gap-4 p-4">
          <Headshot cwid={p.cwid} name={p.name} present={p.hasHeadshot} px={96} />
          <div className="min-w-0">
            <div className="text-base font-semibold">{p.name}</div>
            <div className="text-muted-foreground font-mono text-sm">{p.cwid}</div>
            {!p.hasHeadshot && <Pill>No headshot</Pill>}
          </div>
        </div>

        {p.personType && (
          <div className={SECTION}>
            <div className={LABEL}>Person type</div>
            <span className="bg-muted rounded px-2 py-0.5 text-sm">{p.personType}</span>
          </div>
        )}

        {p.titles.length > 0 && (
          <div className={SECTION}>
            <div className={LABEL}>Titles</div>
            <ul className="flex flex-col gap-2 text-sm">
              {p.titles.map((t, i) => (
                <li key={`${t.title}-${t.organization}-${i}`}>
                  {t.title}
                  {t.isPrimary && <span className="text-muted-foreground ml-1.5 text-xs">Primary</span>}
                  <div className="text-muted-foreground text-xs">{t.organization}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={SECTION}>
          <div className="flex items-baseline justify-between">
            <div className={LABEL}>Overview</div>
            {p.hasOverview && p.overviewLabel && (
              <span className="text-muted-foreground text-xs">{p.overviewLabel}</span>
            )}
          </div>
          {p.hasOverview && p.overviewExcerpt ? (
            <p className="line-clamp-3 text-sm">{p.overviewExcerpt}</p>
          ) : (
            <Pill>No overview</Pill>
          )}
        </div>

        {p.isVisible && p.slug && (
          <div className="bg-apollo-surface-2 border-apollo-border flex justify-end gap-4 border-t px-4 py-2.5 text-sm">
            <Link href={profilePath(p.slug)} className="text-apollo-maroon hover:underline">
              Public profile
            </Link>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber mt-1 inline-block rounded-full border px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}
