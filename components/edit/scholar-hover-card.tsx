"use client";

/**
 * The shared /edit scholar hover card (~300ms): larger headshot, cwid, email,
 * person type, current titles, an overview excerpt, and a public-profile link.
 * Given just a cwid, so any roster or report can wrap a name in it —
 * `<ScholarHoverCard cwid={r.cwid}>{r.name}</ScholarHoverCard>`. The data
 * comes from `GET /api/edit/scholar-card/[cwid]`, prefetched on pointer-enter
 * so it has usually landed by the time the card opens, and cached per page.
 *
 * A client module on purpose: composing Radix HoverCard inside a server
 * component drops the subtree at SSR (see `components/edit/matcha-tab.tsx`).
 *
 * Hover-only by design — phones get no card, and a link inside the trigger
 * must still work there: Radix's trigger preventDefaults `touchstart`, which on
 * iOS cancels the link's click, so the roster name re-issues it on
 * `onTouchEnd` (the #2588 pattern in matcha-tab).
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { ScholarCard } from "@/lib/api/data-quality";
import { identityImageEndpoint } from "@/lib/headshot";
import { profilePath } from "@/lib/profile-url";
import { cn, initials } from "@/lib/utils";

// ponytail: per-page-load cache, never invalidated — a card edited in another
// tab shows stale until reload, which is fine for a hover summary.
const cache = new Map<string, Promise<ScholarCard | null>>();

function fetchCard(cwid: string): Promise<ScholarCard | null> {
  let p = cache.get(cwid);
  if (!p) {
    p = fetch(`/api/edit/scholar-card/${encodeURIComponent(cwid)}`).then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`scholar-card ${r.status}`);
      return r.json() as Promise<ScholarCard>;
    });
    p.catch(() => cache.delete(cwid)); // a blip retries on the next hover
    cache.set(cwid, p);
  }
  return p;
}

type CardState = { status: "idle" | "loading" | "missing" | "error" } | { status: "ok"; card: ScholarCard };

/**
 * Headshot circle, fetched lazily (only rows on screen load). No photo on file —
 * or not yet probed — is a dashed circle with initials, so a gap never looks
 * like a photo.
 * ponytail: the directory API serves one size; add a sized variant if it ever
 * takes one (the plan was 72px for the 36px circle on retina).
 */
export function Headshot({
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function ScholarHoverCard({
  cwid,
  children,
  side = "right",
  sideOffset = 8,
}: {
  cwid: string;
  /** The trigger — a name, or a whole name cell. Must accept a ref (an element, not a string). */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}) {
  const [state, setState] = useState<CardState>({ status: "idle" });
  const load = () => {
    if (state.status !== "idle" && state.status !== "error") return;
    setState({ status: "loading" });
    fetchCard(cwid).then(
      (card) => setState(card ? { status: "ok", card } : { status: "missing" }),
      () => setState({ status: "error" }),
    );
  };

  return (
    <HoverCard openDelay={300} onOpenChange={(open) => open && load()}>
      <HoverCardTrigger asChild onPointerEnter={load}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align="center"
        sideOffset={sideOffset}
        className="text-apollo-ink w-[22rem] overflow-hidden p-0"
        data-testid={`scholar-card-${cwid}`}
      >
        {state.status === "ok" ? (
          <CardBody c={state.card} />
        ) : (
          <p className="text-muted-foreground p-4 text-sm">
            {state.status === "missing"
              ? "Not in Scholars."
              : state.status === "error"
                ? "Couldn't load this profile."
                : "Loading…"}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function CardBody({ c }: { c: ScholarCard }) {
  return (
    <>
      <div className="flex items-center gap-4 p-4">
        <Headshot cwid={c.cwid} name={c.name} present={c.hasHeadshot} px={96} />
        <div className="min-w-0">
          <div className="text-base font-semibold">{c.name}</div>
          <div className="text-muted-foreground font-mono text-sm">{c.cwid}</div>
          {c.email && (
            <a
              href={`mailto:${c.email}`}
              className="text-apollo-maroon block truncate text-sm hover:underline"
              data-testid={`scholar-card-email-${c.cwid}`}
            >
              {c.email}
            </a>
          )}
          {!c.hasHeadshot && <Pill>No headshot</Pill>}
        </div>
      </div>

      {c.personType && (
        <div className={SECTION}>
          <div className={LABEL}>Person type</div>
          <span className="bg-muted rounded px-2 py-0.5 text-sm">{c.personType}</span>
        </div>
      )}

      {c.titles.length > 0 && (
        <div className={SECTION}>
          <div className={LABEL}>Titles</div>
          <ul className="flex flex-col gap-2 text-sm">
            {c.titles.map((t, i) => (
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
          {c.hasOverview && (
            <span className="text-muted-foreground text-xs">
              {c.overviewUpdatedAt ? `Edited ${formatDate(c.overviewUpdatedAt)}` : "Imported"}
            </span>
          )}
        </div>
        {c.hasOverview && c.overviewExcerpt ? (
          <p className="line-clamp-3 text-sm">{c.overviewExcerpt}</p>
        ) : (
          <Pill>No overview</Pill>
        )}
      </div>

      {c.isVisible && (
        <div className="bg-apollo-surface-2 border-apollo-border flex justify-end gap-4 border-t px-4 py-2.5 text-sm">
          <Link href={profilePath(c.slug)} className="text-apollo-maroon hover:underline">
            Public profile
          </Link>
        </div>
      )}
    </>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber mt-1 inline-block rounded-full border px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

export type RosterScholarCellProps = {
  cwid: string;
  name: string;
  editHref: string;
  hasHeadshot: boolean;
  isVisible: boolean;
  leadership: string | null;
  /** "Title · Unit" line under the name. */
  subtitle: string | null;
};

/** The Profiles roster's scholar cell: headshot + name, wrapped in the card. */
export function RosterScholarCell(p: RosterScholarCellProps) {
  // The trigger is w-fit: the card anchors to it, and at full cell width the
  // card opened past the cell's right edge, far from the name being hovered.
  // The negative offset overlaps the trigger a little: a wrapped subtitle makes
  // the trigger as wide as the cell, which left a gap between text and card.
  return (
    <ScholarHoverCard cwid={p.cwid} sideOffset={-40}>
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
            <span className="bg-muted text-apollo-ink-2 ml-2 rounded px-1.5 py-0.5 text-xs">{p.leadership}</span>
          )}
          {p.subtitle && <div className="text-muted-foreground text-xs">{p.subtitle}</div>}
        </div>
      </div>
    </ScholarHoverCard>
  );
}
