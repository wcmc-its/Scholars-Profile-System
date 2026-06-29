import type { ReactNode } from "react";
import Link from "next/link";
import { Banknote, ChevronDown, FileText, Quote, Shapes, Stethoscope, Waypoints, Wrench } from "lucide-react";
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
const FLAVOR_BADGE: Record<PubFlavor, { cls: string; icon: typeof FileText; text: string }> = {
  area: { cls: "border-[#d8e2ec] bg-[#eef2f6] text-[#2c4f6e]", icon: Shapes, text: "Research area" },
  concept: { cls: "border-[#d2d6f0] bg-[#e6e8f7] text-[#34408a]", icon: Waypoints, text: "Concept" },
  keyword: { cls: "border-[#e4e4e7] bg-[#f4f4f5] text-[#52525b]", icon: Quote, text: "Keyword" },
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
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  panelId?: string;
  className?: string;
  /** What the disclosure reveals, for the sr-only affordance (e.g. "key funding"). */
  srLabel?: string;
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
      <span className="sr-only"> {srLabel}</span>
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
  badged = false,
  flavor,
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
}) {
  const Icon = ICONS[kind];
  const pill = badged
    ? FLAVOR_BADGE[flavor ?? (kind === "concept" ? "concept" : kind === "area" ? "area" : "keyword")]
    : null;
  // Single line — clips an over-long reason (e.g. a representative-pub title)
  // rather than wrapping. A no-op for the short count/concept reasons.
  const inner = pill ? (
    (() => {
      const PillIcon = pill.icon;
      return (
        <>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.02em] ${pill.cls}`}
          >
            <PillIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
            {pill.text}
          </span>
          {/* #1350 — the count prefix reads in normal weight; the resolved concept
              term (appended by the caller) carries its own subtle underline. */}
          <span className="min-w-0 truncate text-[#3a3a3a]">{children}</span>
        </>
      );
    })()
  ) : (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 truncate">{children}</span>
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
      className={`${badged ? "mt-1" : "mt-2"} flex min-w-0 items-center leading-snug ${badged ? "gap-2 text-[13px]" : "gap-1.5 text-[12.5px] text-muted-foreground"} ${className}`}
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
export function MatchAwareReason({
  kind,
  label,
  prefix,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
}: {
  kind: "method" | "topic" | "clinical" | "funding";
  label: string;
  /** #1361 — an optional normal-weight count prefix rendered before the semibold
   *  term (e.g. "3 of 5 grants mention" + **"radiosurgery"**). Omitted for the pure
   *  label matches (method/topic/clinical), which have no "N of M" count. */
  prefix?: string;
  /** Rep-papers disclosure — when true, trail a clickable chevron `<button>`
   *  that opens the representative-papers panel `panelId`. */
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
}) {
  // From the mockup: method bg #fbf4ea / border #ecdcc8 / ink #8a4a1f;
  // topic bg #eef2f6 / border #d8e2ec / ink #2c4f6e;
  // clinical bg #e8f4f8 / border #c5e4eb / ink #1a5f7a;
  // funding bg #eef6ef / border #cfe3d3 / ink #2f6b3a (WCAG-AA 5.80:1 at 10px).
  const badge =
    kind === "method"
      ? "border-[#ecdcc8] bg-[#fbf4ea] text-[#8a4a1f]"
      : kind === "clinical"
        ? "border-[#c5e4eb] bg-[#e8f4f8] text-[#1a5f7a]"
        : kind === "funding"
          ? "border-[#cfe3d3] bg-[#eef6ef] text-[#2f6b3a]"
          : "border-[#d8e2ec] bg-[#eef2f6] text-[#2c4f6e]";
  // One content-type glyph per notion across every surface (#1073): method = the
  // SAME Wrench as the "Methods and Tools" chip row + /methods lens; research area
  // = the SAME Shapes as the Research Areas chip row (research-areas-row.tsx),
  // replacing Tag (which now means only profile Topics/MeSH); clinical = Stethoscope;
  // funding = Banknote (Landmark collides with Building2 = org units — handoff §4.2).
  const Icon =
    kind === "method"
      ? Wrench
      : kind === "clinical"
        ? Stethoscope
        : kind === "funding"
          ? Banknote
          : Shapes;
  const badgeText =
    kind === "method"
      ? "Method"
      : kind === "clinical"
        ? "Clinical"
        : kind === "funding"
          ? "Funding"
          : "Research area";
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
        {prefix ? <span className="font-normal text-[#3a3a3a]">{prefix} </span> : null}
        <strong className="font-semibold text-[#1a1a1a]">{label}</strong>
      </span>
    </>
  );
  // Item 1 — the whole [badge · label · chevron] cluster is the toggle.
  if (canExpand && onToggle) {
    return (
      <div className="mt-1.5 text-[13px] leading-snug">
        <DisclosureRow
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
    <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] leading-snug">
      {inner}
    </div>
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
}: {
  papers: EvidencePub[];
  total: number;
  profileHref: string;
  status?: ExemplarFetchStatus;
  panelId?: string;
  /** When a method/topic exemplar fetch resolves with NO renderable paper (rare —
   *  every family/topic pub is suppressed or non-renderable), degrade to this
   *  profile-section link instead of retracting the chevron into a dead control;
   *  the badge firing guarantees the scholar has the section. Undefined for the
   *  publications key-paper path (its chevron is count-gated, so empty ⇒ nothing). */
  fallback?: { href: string; label: string };
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
    <div id={panelId} className="mt-1.5 pl-[1px]">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#9a958a]">
        {papers.length === 1 ? "Key paper" : "Key papers"}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 text-[13px] leading-snug">
        {papers.map((p) => (
          // Bullet + hanging indent: the dot is its own flex item, so a title that
          // wraps aligns line 2 under the TITLE text (not the bullet); the dot
          // shares the title's line-height so it baselines with line 1. Titles are
          // roman at 13px and NEVER truncate — the full article title always wraps.
          <li key={p.pmid} className="flex items-start gap-[6px] text-muted-foreground">
            <span aria-hidden className="shrink-0 leading-snug text-[#9a958a]">
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
                  className="text-[#4a4a4a]"
                  dangerouslySetInnerHTML={{ __html: highlightedTitleHtml(p.titleHtml) }}
                />
              ) : (
                <PubTitle as="span" value={p.title} className="text-[#4a4a4a]" />
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
}: {
  grants: EvidenceGrant[];
  total: number;
  profileHref: string;
  status?: ExemplarFetchStatus;
  panelId?: string;
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
    <div id={panelId} className="mt-1.5 pl-[1px]">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#9a958a]">
        {grants.length === 1 ? "Key grant" : "Key funding"}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 text-[13px] leading-snug">
        {grants.map((g) => {
          const meta = fundingMeta(g);
          return (
            <li key={g.projectId} className="flex items-start gap-[6px] text-muted-foreground">
              <span aria-hidden className="shrink-0 leading-snug text-[#9a958a]">
                &bull;
              </span>
              <span className="min-w-0">
                <span className="block text-[#4a4a4a]">{g.title}</span>
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
