import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, FileText, Sparkles, Tag, Wrench } from "lucide-react";
import { PubTitle } from "@/components/publication/pub-html";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import type { EvidencePub } from "@/lib/api/result-evidence";

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
 * Rep-papers disclosure — the summary row IS the toggle (polish spec item 1).
 * Instead of a chevron marooned at the right edge, the whole
 * `[icon] [label] [chevron]` cluster is one content-width control. A native
 * `<button>` (implicit role=button, focusable, native Enter/Space) so it stays
 * keyboard-operable and announces its expanded state; `stopPropagation` so a
 * click never triggers the stretched name-link navigation (the whole card is a
 * stretched link), and `relative z-10` lifts it above the card's
 * `after:absolute inset-0` overlay. The accessible name is the cluster's text
 * (the count / method label) — an accordion-header pattern — with `aria-expanded`
 * for state. The negative inline margin lets the hover surface breathe ±8px
 * without shifting the content's left edge (`-mx-2` cancels `px-2`).
 */
function DisclosureRow({
  expanded,
  onToggle,
  panelId,
  className = "",
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  panelId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={expanded}
      // Only reference the panel while it exists — it is mounted (with id=panelId)
      // by the card only when expanded, so a collapsed-state aria-controls would
      // be a dangling reference.
      aria-controls={expanded ? panelId : undefined}
      className={`relative z-10 -mx-2 inline-flex max-w-full cursor-pointer items-center gap-[7px] rounded-md px-2 py-[5px] text-left align-top hover:bg-[#f0eeea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2c4f6e] focus-visible:ring-offset-1 ${className}`}
    >
      {children}
      {/* The visible cluster text (the count / method label) is the button's
          accessible name; this appends an explicit affordance so a screen reader
          announces what the disclosure reveals, while `aria-expanded` carries the
          state. */}
      <span className="sr-only"> representative papers</span>
      <ChevronDown
        aria-hidden
        strokeWidth={2}
        className={`size-3.5 shrink-0 text-[#9a958a] motion-safe:transition-transform motion-safe:duration-150 ${
          expanded ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

/**
 * PLAN R4 — one quiet "why this match" reason line, shared by the Publications,
 * Scholars, and Funding rows. Muted, single line, small leading icon by kind.
 * Replaces the #688/#702/#707 "Why this match" / "Matched in publications" /
 * "Matched on" surfaces. Shown only when the match isn't self-evident from the
 * row's own visible content (e.g. a highlighted title), never identical on
 * every row — the caller decides whether and what to render.
 *
 * Rep-papers disclosure — when `canExpand`, the row trails a real chevron
 * `<button>` opening the representative-papers panel `panelId`.
 */
export function MatchReason({
  kind,
  children,
  className = "",
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
}: {
  kind: MatchReasonKind;
  children: ReactNode;
  className?: string;
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
}) {
  const Icon = ICONS[kind];
  // Single line — clips an over-long reason (e.g. a representative-pub title)
  // rather than wrapping. A no-op for the short count/concept reasons.
  const inner = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  // Item 1 — when a panel can open, the whole [icon · count · chevron] cluster is
  // the toggle (content-width, left-aligned), not a chevron flush to the far edge.
  if (canExpand && onToggle) {
    return (
      <div className={`mt-2 text-[12.5px] leading-snug text-muted-foreground ${className}`}>
        <DisclosureRow expanded={expanded} onToggle={onToggle} panelId={panelId}>
          {inner}
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div
      className={`mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-snug text-muted-foreground ${className}`}
    >
      {inner}
    </div>
  );
}

/**
 * #824 follow-up — the match-aware "why" line in the approved mockup
 * (`docs/mockups/search-snippet/match-aware-snippet.html`). A small uppercase
 * badge (rust for method, blue for topic) with a leading lucide icon, then the
 * matched label in bold; the method variant trails up to 3 exemplar tool names,
 * muted and " · "-separated. Lives inside the result card's stretched-link
 * wrapper, so it is a row of `<span>`s plus (when `canExpand`) a real chevron
 * `<button>`; the icon is decorative (`aria-hidden`). Colors are inlined from
 * the mockup CSS variables.
 */
export function MatchAwareReason({
  kind,
  label,
  tools = [],
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
}: {
  kind: "method" | "topic";
  label: string;
  tools?: string[];
  /** Rep-papers disclosure — when true, trail a clickable chevron `<button>`
   *  that opens the representative-papers panel `panelId`. */
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
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
  const badgeText = kind === "method" ? "Method" : "Research area";
  // items-center (not baseline): the bordered pill and the bold label line up on
  // a shared center axis so the badge doesn't sit low next to the label.
  const inner = (
    <>
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
    </>
  );
  // Item 1 — the whole [badge · label · chevron] cluster is the toggle.
  if (canExpand && onToggle) {
    return (
      <div className="mt-2 text-[13px] leading-snug">
        <DisclosureRow expanded={expanded} onToggle={onToggle} panelId={panelId}>
          {inner}
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-[13px] leading-snug">
      {inner}
    </div>
  );
}

/** Fetch lifecycle of the lazily-loaded representative papers (method/topic). */
export type ExemplarFetchStatus = "idle" | "loading" | "done";

/**
 * Rep-papers disclosure — the mockup's `REP. PAPERS` block: a small uppercase
 * `REP. PAPERS` label above a column of up to 3 italic paper titles (rendered
 * through `PubTitle`, never raw — #946) with a muted ` (year)`, and a
 * `+{total - papers.length} more in profile →` link to `profileHref` when there
 * are more than shown. The link is `relative z-10` and stops propagation so it
 * never triggers the card's stretched name-link navigation. While `status` is
 * `"loading"` (a method/topic lazy fetch in flight) it shows a muted
 * "finding representative papers…" placeholder (aria-hidden so a screen reader
 * tabbing the row never reads it). Renders nothing when there are no papers and
 * the fetch has resolved.
 */
export function RepresentativePapers({
  papers,
  total,
  profileHref,
  status = "done",
  panelId,
}: {
  papers: EvidencePub[];
  total: number;
  profileHref: string;
  status?: ExemplarFetchStatus;
  panelId?: string;
}) {
  if (status === "loading" && papers.length === 0) {
    return (
      <div id={panelId} className="mt-1.5 pl-[1px] text-[12px] leading-snug">
        <span aria-hidden className="text-[#9a958a]">
          finding representative papers&hellip;
        </span>
      </div>
    );
  }
  if (papers.length === 0) return null;

  const more = total - papers.length;
  return (
    <div id={panelId} className="mt-1.5 pl-[1px]">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#9a958a]">
        {papers.length === 1 ? "Rep. paper" : "Rep. papers"}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 text-[12px] leading-snug">
        {papers.map((p) => (
          // Item 2 — bullet + hanging indent: the dot is its own flex item, so a
          // title that wraps aligns line 2 under the TITLE text (not the bullet).
          // The dot shares the title's line-height so it baselines with line 1.
          <li key={p.pmid} className="flex items-start gap-[9px] text-muted-foreground">
            <span aria-hidden className="shrink-0 leading-snug text-[#9a958a]">
              &bull;
            </span>
            <span className="min-w-0">
              {/* #946 — PubMed titles can carry markup (<i>, <sub>, …); render
                  through the sanctioned PubTitle (with a <mark>-aware variant when
                  the literal query appeared in the title), never raw. */}
              {p.titleHtml ? (
                <span className="italic text-[#4a4a4a]">
                  <HighlightedSnippet html={p.titleHtml} />
                </span>
              ) : (
                <PubTitle as="span" value={p.title} className="italic text-[#4a4a4a]" />
              )}
              {p.year ? <span className="text-[#777]"> ({p.year})</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <Link
          href={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 mt-1 inline-block text-[12px] font-medium text-[#1f51a8] no-underline hover:underline"
        >
          +{more} more in profile →
        </Link>
      ) : null}
    </div>
  );
}
