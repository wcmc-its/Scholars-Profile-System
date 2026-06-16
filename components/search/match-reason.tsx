import type { ReactNode } from "react";
import { ChevronDown, FileText, Sparkles, Tag, Wrench } from "lucide-react";

/**
 * PLAN R4 — the kind of match a reason line explains, which picks the leading
 * icon (mockup mapping: document = publication-count evidence, tag = research
 * area, sparkle = concept expansion).
 */
export type MatchReasonKind = "concept" | "publications" | "area";

const ICONS: Record<MatchReasonKind, typeof Sparkles> = {
  concept: Sparkles,
  publications: FileText,
  area: Tag,
};

/**
 * PLAN R4 — one quiet "why this match" reason line, shared by the Publications,
 * Scholars, and Funding rows. Muted, single line, small leading icon by kind.
 * Replaces the #688/#702/#707 "Why this match" / "Matched in publications" /
 * "Matched on" surfaces. Shown only when the match isn't self-evident from the
 * row's own visible content (e.g. a highlighted title), never identical on
 * every row — the caller decides whether and what to render.
 */
export function MatchReason({
  kind,
  children,
  className = "",
}: {
  kind: MatchReasonKind;
  children: ReactNode;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <div
      className={`mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-snug text-muted-foreground ${className}`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      {/* Single line — clips an over-long reason (e.g. #967's representative-pub
          title) rather than wrapping. A no-op for the short count/concept
          reasons, which already fit. */}
      <span className="truncate">{children}</span>
    </div>
  );
}

/**
 * #824 follow-up — the match-aware "why" line in the approved mockup
 * (`docs/mockups/search-snippet/match-aware-snippet.html`). A small uppercase
 * badge (rust for method, blue for topic) with a leading lucide icon, then the
 * matched label in bold; the method variant trails up to 3 exemplar tool names,
 * muted and " · "-separated. Lives inside the result-card `<Link>`, so it is a
 * row of `<span>`s only (no nested interactive element); the icon is decorative
 * (`aria-hidden`). Colors are inlined from the mockup CSS variables.
 */
export function MatchAwareReason({
  kind,
  label,
  tools = [],
  expandable = false,
}: {
  kind: "method" | "topic";
  label: string;
  tools?: string[];
  /** #967 §7 — when true (method only), trail a muted ▾ cueing that hovering /
   *  focusing the row reveals the family's representative paper (the
   *  `MethodExemplarLine` below). Purely decorative; the reveal is driven by the
   *  card's `group` hover/focus, not by clicking this glyph (it can't be an
   *  interactive element — the whole card is one `<Link>`). */
  expandable?: boolean;
}) {
  // From the mockup: method bg #fbf4ea / border #ecdcc8 / ink #8a4a1f;
  // topic bg #eef2f6 / border #d8e2ec / ink #2c4f6e.
  const badge =
    kind === "method"
      ? "border-[#ecdcc8] bg-[#fbf4ea] text-[#8a4a1f]"
      : "border-[#d8e2ec] bg-[#eef2f6] text-[#2c4f6e]";
  // Method uses the SAME Wrench glyph as the "Methods and Tools" facet/chip row
  // (research-areas-row.tsx) and the /methods lens, so the concept reads with one
  // icon everywhere; topic keeps the Tag.
  const Icon = kind === "method" ? Wrench : Tag;
  const badgeText = kind === "method" ? "Method" : "Topic";
  return (
    // items-center (not baseline): the bordered pill and the bold label line up
    // on a shared center axis so the badge doesn't sit low next to the label.
    <div className="mt-2 flex min-w-0 items-center gap-2 text-[13px] leading-snug">
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.02em] ${badge}`}
      >
        <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
        {badgeText}
      </span>
      <span className="min-w-0 truncate">
        <strong className="font-semibold text-[#1a1a1a]">{label}</strong>
        {kind === "method" && tools.length > 0 ? (
          <span className="font-normal text-muted-foreground">
            {tools.map((t, i) => (
              <span key={`${t}-${i}`}>
                <span aria-hidden className="px-1.5 text-[#c9c4ba]">
                  ·
                </span>
                {t}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {expandable ? (
        // Rotates on row hover/focus (motion-safe only) to read as a disclosure;
        // shrink-0 so it stays visible while the label/tools span truncates.
        <ChevronDown
          aria-hidden
          strokeWidth={2}
          className="size-3 shrink-0 text-[#c9c4ba] motion-safe:transition-transform motion-safe:duration-150 group-hover:rotate-180 group-focus:rotate-180"
        />
      ) : null}
    </div>
  );
}

/** Fetch lifecycle of the lazily-loaded method exemplar (see `MethodExemplarLine`). */
export type ExemplarFetchStatus = "idle" | "loading" | "done";

/**
 * #967 §7 (Variant 2) — the row's representative-paper reveal for a method
 * match. Hidden at rest; shown when the result row (the `group` `<Link>` in
 * `people-result-card`) is hovered or keyboard-focused. The pub is fetched lazily
 * by the card on that same hover/focus (`/api/scholar/[cwid]/method-exemplar`), so
 * the cacheable results derive is untouched.
 *
 * No transition on the reveal itself — the handoff wants "show, don't animate",
 * which is also the reduced-motion-safe default. A row with no qualifying paper
 * renders nothing (handoff: "omitted, not blank").
 */
export function MethodExemplarLine({
  status,
  pub,
}: {
  status: ExemplarFetchStatus;
  pub: { title: string; year?: number | null } | null;
}) {
  // Once resolved with nothing to show, drop the line entirely.
  if (status === "done" && !pub) return null;
  return (
    <div className="mt-1 hidden pl-[1px] text-[12px] leading-snug group-hover:block group-focus:block">
      {pub ? (
        <span className="line-clamp-2 text-muted-foreground">
          <span aria-hidden className="text-[#c9c4ba]">
            ↳{" "}
          </span>
          Representative paper:{" "}
          <span className="italic text-[#4a4a4a]">&ldquo;{pub.title}&rdquo;</span>
          {pub.year ? <span className="text-[#777]"> ({pub.year})</span> : null}
        </span>
      ) : (
        // Transient visual placeholder only — aria-hidden so a screen reader
        // tabbing onto the row never reads "finding a representative paper…" as
        // part of the focused link's accessible name.
        <span aria-hidden className="text-[#9a958a]">
          ↳ finding a representative paper&hellip;
        </span>
      )}
    </div>
  );
}
