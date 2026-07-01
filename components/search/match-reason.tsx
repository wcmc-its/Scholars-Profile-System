import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, FileText, Shapes, Waypoints } from "lucide-react";
import { PubTitle } from "@/components/publication/pub-html";
import { highlightedTitleHtml } from "@/lib/search/highlight-title";
import type { EvidenceGrant, EvidencePub } from "@/lib/api/result-evidence";

/**
 * PLAN R4 — the kind of match a reason line explains, which picks the leading
 * icon. Icon namespaces (#1073): research area = the `Shapes` content-type glyph
 * (shared with the chip row + the match badge); publications = document;
 * concept = `Waypoints`, the search-mechanic marker for a MeSH-expansion match
 * ("connected related nodes"). `Sparkles` was retired here — it now means only
 * "AI did something" (the overview generator).
 */
export type MatchReasonKind = "concept" | "publications" | "area";

const ICONS: Record<MatchReasonKind, typeof FileText> = {
  concept: Waypoints,
  publications: FileText,
  area: Shapes,
};

/**
 * §4.5/§4.7 — opt-in flavor pill for the publications reason row. A MeSH-descriptor
 * hit IS a concept, so the pub strength tier maps: tagged (exact descriptor) →
 * "Concept", concept (expanded MeSH) → "Concept", mention (literal) → "Keyword".
 * Colors per handoff §4.2. ("Research area" is reserved for the topic-taxonomy
 * match — the `topic` MatchAwareReason — not a MeSH tag.)
 * #1350 — the §4.5 dotted underline on the concept descriptor text now ships: the
 * caller appends the resolved term as an underlined span (see `ResultEvidence` /
 * `PublicationResultRow`), so the badged row no longer force-bolds its children.
 */
export type PubFlavor = "area" | "concept" | "keyword";
// #1381 follow-up — the primary publications reason is now a colored dot + type word
// (matching the "Also matched" secondaries + the approved lead mock), NOT a bordered
// pill/icon. Bright FILLED dot + the AA-safe dark label tone, keyed by flavor.
const FLAVOR_DOT: Record<PubFlavor, { dot: string; text: string; color: string }> = {
  area: { dot: "bg-[#2563eb]", text: "Research area", color: "text-[#1d4ed8]" },
  concept: { dot: "bg-[#7c3aed]", text: "Concept", color: "text-[#6d28d9]" },
  keyword: { dot: "bg-[#64748b]", text: "Keyword", color: "text-[#475569]" },
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
  srLabel = "key papers",
  compact = false,
  wide = false,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  panelId?: string;
  className?: string;
  /** What the disclosure reveals, for the sr-only affordance (e.g. "key funding"). */
  srLabel?: string;
  /** Tighter vertical padding for the compact "Also matched" lesser rows. */
  compact?: boolean;
  /** #1381 follow-up — full-width row with the chevron pushed to the far right (the
   *  column-aligned primary lead). Default is the content-width inline cluster. */
  wide?: boolean;
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
      className={`relative z-10 -mx-2 ${wide ? "flex w-full" : "inline-flex max-w-full"} cursor-pointer items-center gap-[7px] rounded-md px-2 ${compact ? "py-[1px]" : "py-[5px]"} text-left align-top hover:bg-[#f0eeea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2c4f6e] focus-visible:ring-offset-1 ${className}`}
    >
      {children}
      {/* The visible cluster text (the count / method label) is the button's
          accessible name; this appends an explicit affordance so a screen reader
          announces what the disclosure reveals, while `aria-expanded` carries the
          state. */}
      <span className="sr-only"> {srLabel}</span>
      <ChevronDown
        aria-hidden
        strokeWidth={2.5}
        className={`shrink-0 ${wide ? "size-5 ml-auto" : "size-3.5"} text-[#9a958a] motion-safe:transition-transform motion-safe:duration-150 ${
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
  badged = false,
  flavor,
  cue,
  dim = false,
}: {
  kind: MatchReasonKind;
  children: ReactNode;
  className?: string;
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
  /** §4.7 — render as a flavor badge pill instead of the muted icon row. Opt-in,
   *  threaded only via `<ResultEvidence>` (Scholars card); other surfaces leave it
   *  false and keep the shipped muted row unchanged. */
  badged?: boolean;
  /** Which flavor pill when `badged`; defaults from kind. */
  flavor?: PubFlavor;
  /** #1366 follow-up Part B — an italic, muted relevance caveat appended after the
   *  reason text (e.g. " · term match only" for a keyword-only lead). */
  cue?: string;
  /** #1366 follow-up Part B — faint the lead (mute the pill + reason text). */
  dim?: boolean;
}) {
  const Icon = ICONS[kind];
  const pill = badged
    ? FLAVOR_DOT[flavor ?? (kind === "concept" ? "concept" : kind === "area" ? "area" : "keyword")]
    : null;
  // Single line — clips an over-long reason (e.g. a representative-pub title)
  // rather than wrapping. A no-op for the short count/concept reasons.
  // #1366 follow-up Part B — the relevance caveat (italic muted) trailing the reason
  // text; `dim` mutes the pill + reason text so a low-relevance lead reads quieter.
  const cueSpan = cue ? <span className="font-normal italic text-[#9a958a]">{cue}</span> : null;
  const inner = pill ? (
    // #1381 — dot + colored type word (no pill / icon), so the primary reads like the
    // "Also matched" secondaries and the approved lead mock. The count prefix reads in
    // normal weight; the resolved concept term (appended by the caller) keeps its own
    // subtle underline.
    <>
      <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${pill.dot}`} />
      <span className={`min-w-0 truncate ${dim ? "text-[#9a958a]" : "text-[#8c8c8c]"}`}>
        <span className={`font-medium ${dim ? "text-[#9a958a]" : pill.color}`}>{pill.text}</span>
        {" · "}
        {children}
        {cueSpan}
      </span>
    </>
  ) : (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className={`min-w-0 truncate${dim ? " text-[#9a958a]" : ""}`}>
        {children}
        {cueSpan}
      </span>
    </>
  );
  // Item 1 — when a panel can open, the whole [icon · count · chevron] cluster is
  // the toggle (content-width, left-aligned), not a chevron flush to the far edge.
  if (canExpand && onToggle) {
    return (
      <div
        className={`${badged ? "mt-1" : "mt-2"} leading-snug ${badged ? "text-[13px]" : "text-[12.5px] text-muted-foreground"} ${className}`}
      >
        <DisclosureRow expanded={expanded} onToggle={onToggle} panelId={panelId}>
          {inner}
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div
      className={`${badged ? "mt-1" : "mt-2"} flex min-w-0 items-center leading-snug ${badged ? "gap-[7px] text-[13px]" : "gap-1.5 text-[12.5px] text-muted-foreground"} ${className}`}
    >
      {inner}
    </div>
  );
}

/**
 * #824 follow-up — the match-aware "why" line. A small uppercase badge (rust for
 * method, blue for topic, teal for clinical) with a leading lucide icon, then the
 * matched label in bold. The method family name now stands ALONE — the muted
 * exemplar-tool trail was dropped: the rep-papers list below does the evidentiary
 * work, and the bare name reads as a confident, unambiguous label with no
 * casing/truncation to maintain. (The `tools` data is still on the evidence object,
 * so a curated 1–2 terms could be reinstated later without re-deriving anything.)
 * Lives inside the result card's stretched-link wrapper, so it is a row of
 * `<span>`s plus (when `canExpand`) a real chevron `<button>`; the icon is
 * decorative (`aria-hidden`).
 */
/** #1381 follow-up — per-kind primary tokens: the FILLED dot color, the AA-safe dark
 *  type-word color, and the type word itself. Method = burnt umber (was red). Concept/
 *  keyword are folded in so the publications lead shares the one column-aligned chrome. */
const PRIMARY_KIND: Record<
  "method" | "topic" | "clinical" | "funding" | "concept" | "keyword",
  { dot: string; type: string; word: string }
> = {
  method: { dot: "bg-[#8B4A2F]", type: "text-[#8B4A2F]", word: "Method" },
  topic: { dot: "bg-[#2563eb]", type: "text-[#1d4ed8]", word: "Research area" },
  clinical: { dot: "bg-[#0891b2]", type: "text-[#0e7490]", word: "Clinical" },
  funding: { dot: "bg-[#16a34a]", type: "text-[#166534]", word: "Funding" },
  concept: { dot: "bg-[#7c3aed]", type: "text-[#6d28d9]", word: "Concept" },
  keyword: { dot: "bg-[#64748b]", type: "text-[#475569]", word: "Keyword" },
};

/**
 * #1381 follow-up — the count-first primary phrase: the matched **N** is the emphasized
 * anchor, then a muted "of M <thing> <relation>", then the entity. The entity carries a
 * subtle dotted underline for every kind EXCEPT a literal keyword/mention (`underline`).
 * When there is no count (the single-evidence path, or clinical) it renders the entity
 * alone. `dim` faints the whole phrase for a low-relevance lead.
 */
export function CountFirst({
  n,
  m,
  thing,
  relation,
  entity,
  underline,
  dim = false,
}: {
  n?: number;
  m?: number;
  thing?: string;
  relation?: string;
  entity: ReactNode;
  underline: boolean;
  dim?: boolean;
}) {
  const anchor = dim ? "text-[#9a958a]" : "text-[#1a1a1a]";
  const muted = dim ? "text-[#9a958a]" : "text-[#8c8c8c]";
  const hasCount = n != null && m != null;
  return (
    <>
      {hasCount ? (
        <>
          <span className={`font-semibold ${anchor}`}>{n}</span>{" "}
          <span className={muted}>
            of {m} {thing} {relation}{" "}
          </span>
        </>
      ) : null}
      <span
        className={
          underline
            ? `font-[450] ${anchor} underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]`
            : `font-[450] ${anchor}`
        }
      >
        {entity}
      </span>
    </>
  );
}

export function MatchAwareReason({
  kind,
  children,
  cue,
  dim = false,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
}: {
  kind: "method" | "topic" | "clinical" | "funding" | "concept" | "keyword";
  /** #1381 follow-up — the count-first evidence phrase, built by the caller
   *  (`ResultEvidence` / `people-result-card`) via {@link CountFirst}. */
  children: ReactNode;
  /** #1366 follow-up Part B — an italic, muted relevance caveat appended AFTER the
   *  phrase (e.g. " · 0.2% of output" or " · term match only"). Funding never has one. */
  cue?: string;
  /** #1366 follow-up Part B — faint the lead (mute the type word + phrase). */
  dim?: boolean;
  /** Rep-papers disclosure — when true, trail a clickable chevron `<button>`
   *  that opens the representative-papers panel `panelId`. */
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
}) {
  const k = PRIMARY_KIND[kind];
  // #1381 follow-up — the type word sits in a fixed-width column so the phrases align
  // across cards; the chevron (via DisclosureRow `wide`) is pushed to the far right.
  const inner = (
    <>
      <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${k.dot}`} />
      <span className={`w-[124px] shrink-0 font-medium ${dim ? "text-[#9a958a]" : k.type}`}>
        {k.word}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {children}
        {cue ? <span className="font-normal italic text-[#9a958a]">{cue}</span> : null}
      </span>
    </>
  );
  if (canExpand && onToggle) {
    return (
      <div className="mt-1.5 text-[13px] leading-snug">
        <DisclosureRow
          wide
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
          srLabel={kind === "funding" ? "key funding" : "key papers"}
        >
          {inner}
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex w-full items-center gap-[7px] text-[13px] leading-snug">
      {inner}
    </div>
  );
}

/**
 * #1366 follow-up — the honesty note shown inside a literal-MENTION "Also matched"
 * row's expanded panel: the match is a text mention, not a curated tag. Dots are now
 * always FILLED in the category color, so strength is carried by the muted/italic
 * text — this note does the honesty work the (dropped) hollow dot used to. The win
 * the flat co-equal stack lacked.
 */
export function MentionNote() {
  return (
    <p className="mb-1.5 text-[11px] italic leading-snug text-[#9a958a]">
      text mention in the abstract, not a curated tag
    </p>
  );
}

/**
 * #1366 follow-up — a compact "Also matched" row: a small FILLED dot in the category
 * color, a muted label, an abbreviated "· N of M" count, and the same chevron
 * disclosure. The visually-subordinate sibling of {@link MatchReason}/
 * {@link MatchAwareReason}: the ONE primary signal keeps its full badge, the rest
 * demote here (tiered card, handoff Part 1). `dotClassName` carries the per-kind
 * FILLED color (`bg-…`); a literal-mention row's weakness is carried by `weak`
 * (muted/italic text) + the {@link MentionNote}, never by the dot fill.
 */
export function LesserReason({
  dotClassName,
  children,
  suffix,
  weak = false,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
  srLabel = "key papers",
}: {
  dotClassName: string;
  children: ReactNode;
  /** Abbreviated "· N of M" count (no "publications" word); omitted ⇒ label-only. */
  suffix?: string;
  /** Extra-muted treatment for the literal-mention (hollow) rows. */
  weak?: boolean;
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
  srLabel?: string;
}) {
  const inner = (
    <>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClassName}`} />
      <span className={`min-w-0 truncate text-[12px] ${weak ? "text-[#9a958a]" : "text-[#6b675e]"}`}>
        {children}
        {suffix ? <span className="text-[#a9a399]">{suffix}</span> : null}
      </span>
    </>
  );
  if (canExpand && onToggle) {
    return (
      <div className="mt-1 leading-snug">
        <DisclosureRow
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
          srLabel={srLabel}
          compact
        >
          {inner}
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-[9px] py-[1px] leading-snug">{inner}</div>
  );
}

/** Fetch lifecycle of the lazily-loaded representative papers (method/topic). */
export type ExemplarFetchStatus = "idle" | "loading" | "done";

/**
 * Rep-papers disclosure — the mockup's `REP. PAPERS` block: a small uppercase
 * `REP. PAPER(S)` label above a column of up to 3 roman 15px paper titles (full,
 * never truncated; rendered through `PubTitle`, never raw — #946; matched keyword
 * highlighted 600/primary) with a muted ` (year)`, and a
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
  fallback,
  mentionNote = false,
  panelLabel,
  panelSubtitle,
  railClassName = "pl-[1px]",
}: {
  papers: EvidencePub[];
  total: number;
  profileHref: string;
  status?: ExemplarFetchStatus;
  panelId?: string;
  /** #1366 follow-up — prepend the "text mention, not a curated tag" honesty note
   *  (literal-mention lesser rows). */
  mentionNote?: boolean;
  /** #1366 follow-up Part A — the panel header (the honesty relabel). The caller
   *  (`EvidenceLine`) derives it from the line kind: method/publications →
   *  "Matching publications"; topic → "Representative papers". Omitted ⇒ the legacy
   *  singular/plural "Key paper(s)" (the chevron-as-count semantics, still used by
   *  the direct-component callers). */
  panelLabel?: string;
  /** #1366 follow-up Part A — an italic, muted clarifying line under the header
   *  (the research-area panel: "top papers in this area — not matched to your
   *  search"). Omitted ⇒ no subtitle. */
  panelSubtitle?: string;
  /** When a method/topic exemplar fetch resolves with NO renderable paper (rare —
   *  every family/topic pub is suppressed or non-renderable), degrade to this
   *  profile-section link instead of retracting the chevron into a dead control;
   *  the badge firing guarantees the scholar has the section. Undefined for the
   *  publications key-paper path (its chevron is count-gated, so empty ⇒ nothing). */
  fallback?: { href: string; label: string };
  /** Signal-colored left rail on the panel (blue = research area, green = funding,
   *  per-kind for the rest). Defaults to the flush `pl-[1px]` = no rail. */
  railClassName?: string;
}) {
  if (status === "loading" && papers.length === 0) {
    return (
      <div id={panelId} className="mt-1.5 pl-[1px] text-[12px] leading-snug">
        <span aria-hidden className="text-[#9a958a]">
          finding key papers&hellip;
        </span>
      </div>
    );
  }
  if (papers.length === 0) {
    if (status === "done" && fallback) {
      return (
        <div id={panelId} className="mt-1.5 pl-[1px]">
          <Link
            href={fallback.href}
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 inline-block text-[12px] font-medium text-[#1f51a8] no-underline hover:underline"
          >
            {fallback.label} →
          </Link>
        </div>
      );
    }
    return null;
  }

  const more = total - papers.length;
  return (
    <div id={panelId} className={`mt-1.5 ${railClassName}`}>
      {mentionNote ? <MentionNote /> : null}
      {/* #1366 follow-up Part A — honesty relabel: the caller-supplied header
          ("Matching publications" / "Representative papers") replaces the legacy
          "Key paper(s)" string. Sentence-case with the clarifying caveat folded in
          (" · not from your search") — no separate count (the "+N more" link carries
          the total). */}
      <div className="mb-1.5 text-[11.5px] font-medium leading-snug text-[#3a3a3a]">
        {panelLabel ?? (papers.length === 1 ? "Key paper" : "Key papers")}
        {panelSubtitle ? (
          <span className="font-normal text-[#8c8c8c]"> · {panelSubtitle}</span>
        ) : null}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 text-[13px] leading-snug">
        {papers.map((p) => (
          // Bullet + hanging indent: the dot is its own flex item, so a title that
          // wraps aligns line 2 under the TITLE text (not the bullet); the dot
          // shares the title's line-height so it baselines with line 1. Titles are
          // roman at 13px and NEVER truncate — the full article title always wraps.
          <li key={p.pmid} className="flex items-start gap-[9px] text-muted-foreground">
            <span aria-hidden className="shrink-0 text-[16px] leading-[1.1] text-[#9a958a]">
              &bull;
            </span>
            <span className="min-w-0">
              {/* #946 — PubMed titles can carry markup (<i>, <sub>, …); render
                  through the sanctioned path, never raw. When the query appeared
                  in the title (`titleHtml` carries <mark>s, from OpenSearch for a
                  tagged-pub match or the term-wrap for a topic/method exemplar),
                  style them with the SAME light-red pill as the Publications tab
                  (highlightedTitleHtml). Otherwise the plain sanitized title. */}
              {p.titleHtml ? (
                <span
                  className="text-[#1a1a1a]"
                  dangerouslySetInnerHTML={{ __html: highlightedTitleHtml(p.titleHtml) }}
                />
              ) : (
                <PubTitle as="span" value={p.title} className="text-[#1a1a1a]" />
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
          className="relative z-10 mt-1.5 inline-block text-[12px] font-medium text-[#1f51a8] no-underline hover:underline"
        >
          +{more} more in profile →
        </Link>
      ) : null}
    </div>
  );
}

/** Sponsor · year-range meta line for a grant (muted, normal weight — handoff §4.6). */
function fundingMeta(g: EvidenceGrant): string {
  const years =
    g.startYear && g.endYear
      ? g.startYear === g.endYear
        ? `${g.startYear}`
        : `${g.startYear}–${g.endYear}`
      : g.endYear
        ? `${g.endYear}`
        : g.startYear
          ? `${g.startYear}`
          : "";
  return [g.sponsor || "", years].filter(Boolean).join(" · ");
}

/**
 * "Key funding" disclosure — the funding analogue of {@link RepresentativePapers}:
 * the same chrome (uppercase label, hanging-indent bullets, `+N more` profile link)
 * with grant records instead of papers. A sibling, not a generalized record-panel:
 * the papers panel is pub-specific (PubTitle / highlightedTitleHtml / pmid) and
 * shipped — overloading it for grants buys nothing but regression risk.
 * ponytail: sibling panel; merge the two only if a 3rd record type (trials) lands
 * and the duplication actually bites.
 *
 * Funding rows are presence-gated by the caller (only mounted when ≥1 grant matched),
 * so an empty resolved state renders nothing — there is no fallback-link branch.
 */
export function KeyFunding({
  grants,
  total,
  profileHref,
  status = "done",
  panelId,
  mentionNote = false,
}: {
  grants: EvidenceGrant[];
  total: number;
  profileHref: string;
  status?: ExemplarFetchStatus;
  panelId?: string;
  /** #1366 follow-up — prepend the "text mention, not a curated tag" honesty note
   *  (a literal-mention funding row demoted to "Also matched"). */
  mentionNote?: boolean;
}) {
  if (status === "loading" && grants.length === 0) {
    return (
      <div id={panelId} className="mt-1.5 pl-[1px] text-[12px] leading-snug">
        <span aria-hidden className="text-[#9a958a]">
          finding key funding&hellip;
        </span>
      </div>
    );
  }
  if (grants.length === 0) {
    return null;
  }

  const more = total - grants.length;
  return (
    <div id={panelId} className="mt-1.5 border-l-2 border-[#16a34a] pl-[14px]">
      {mentionNote ? <MentionNote /> : null}
      {/* Sentence-case, no count (the "+N more" link carries the total). */}
      <div className="mb-1.5 text-[11.5px] font-medium leading-snug text-[#3a3a3a]">
        {grants.length === 1 ? "Key grant" : "Key funding"}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 text-[13px] leading-snug">
        {grants.map((g) => {
          const meta = fundingMeta(g);
          return (
            <li key={g.projectId} className="flex items-start gap-[9px] text-muted-foreground">
              <span aria-hidden className="shrink-0 text-[16px] leading-[1.1] text-[#9a958a]">
                &bull;
              </span>
              <span className="min-w-0">
                {/* #1359 — when the query matched in the grant title, style the marks
                    with the SAME light-red pill as key papers (highlightedTitleHtml);
                    otherwise the plain title. */}
                {g.titleHighlight ? (
                  <span
                    className="block text-[#1a1a1a]"
                    dangerouslySetInnerHTML={{ __html: highlightedTitleHtml(g.titleHighlight) }}
                  />
                ) : (
                  <span className="block text-[#1a1a1a]">{g.title}</span>
                )}
                {meta ? <span className="block text-[12px] text-[#777]">{meta}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <Link
          href={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 mt-1.5 inline-block text-[12px] font-medium text-[#1f51a8] no-underline hover:underline"
        >
          +{more} more in profile →
        </Link>
      ) : null}
    </div>
  );
}
