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
/**
 * #1913 — the flavor's WORD, and only the word.
 *
 * This was a per-flavor hue plus a filled dot in that same hue, sitting immediately
 * before the word that already said "Concept" / "Research area" / "Keyword". The dot
 * carried nothing the word did not, and neither did the colour: sampled across 120
 * cards, the primary lead is Concept 69% of the time and Method 29%, so a five-hue
 * legend was distinguishing two values in 98% of rows, in a column already 124px wide.
 *
 * Retiring the axis also settles #1912. The category labels were the only part of the
 * row clearing WCAG AA while the sentence they annotate failed it; the contrast budget
 * now goes to the sentence.
 */
const FLAVOR_WORD: Record<PubFlavor, string> = {
  area: "Research area",
  concept: "Concept",
  keyword: "Keyword",
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
      className={`relative z-10 -mx-2 ${wide || compact ? "flex w-full" : "inline-flex max-w-full"} cursor-pointer items-center gap-[7px] rounded-md px-2 ${compact ? "py-[1px]" : "py-[5px]"} text-left align-top hover:bg-[#f0eeea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2c4f6e] focus-visible:ring-offset-1 ${className}`}
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
        className={`shrink-0 ${wide ? "size-5 ml-auto" : compact ? "size-3.5 ml-auto mr-[3px]" : "size-3.5"} text-[var(--evidence-faint)] motion-safe:transition-transform motion-safe:duration-150 ${
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
  const flavorWord = badged
    ? FLAVOR_WORD[flavor ?? (kind === "concept" ? "concept" : kind === "area" ? "area" : "keyword")]
    : null;
  // Single line — clips an over-long reason (e.g. a representative-pub title)
  // rather than wrapping. A no-op for the short count/concept reasons.
  // #1366 follow-up Part B — the relevance caveat (italic muted) trailing the reason
  // text; `dim` mutes the pill + reason text so a low-relevance lead reads quieter.
  const cueSpan = cue ? (
    <span className="font-normal italic text-[var(--evidence-faint)]">{cue}</span>
  ) : null;
  const inner = flavorWord ? (
    // #1913 — the type word alone, no dot and no per-flavor hue. The count prefix reads
    // in normal weight; the resolved concept term (appended by the caller) keeps its own
    // subtle underline, which is what marks the matched entity now.
    <>
      <span
        className={`min-w-0 truncate ${dim ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-body)]"}`}
      >
        <span className="font-medium">{flavorWord}</span>
        {" · "}
        {children}
        {cueSpan}
      </span>
    </>
  ) : (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className={`min-w-0 truncate${dim ? " text-[var(--evidence-faint)]" : ""}`}>
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
 * #824 follow-up — the match-aware "why" line. #1913 retired the per-kind badge
 * (rust/blue/teal) and its icon; what remains is the type word in a fixed-width
 * column, then the matched label. The method family name now stands ALONE — the muted
 * exemplar-tool trail was dropped: the rep-papers list below does the evidentiary
 * work, and the bare name reads as a confident, unambiguous label with no
 * casing/truncation to maintain. (The `tools` data is still on the evidence object,
 * so a curated 1–2 terms could be reinstated later without re-deriving anything.)
 * Lives inside the result card's stretched-link wrapper, so it is a row of
 * `<span>`s plus (when `canExpand`) a real chevron `<button>`; the icon is
 * decorative (`aria-hidden`).
 */
/** #1381 follow-up — the primary lead's type word, per kind; concept/keyword are folded
 *  in so the publications lead shares the one column-aligned chrome.
 *  #1913 — the record is the WORD and nothing else: the per-kind dot and the per-kind
 *  hue are gone. The word does carry one colour again — the single
 *  `--evidence-accent`, the same for every kind, and only on the primary lead. That is
 *  an emphasis, not the category taxonomy: it says "this is the match", not "this is a
 *  method". {@link FLAVOR_WORD} is the OTHER word list (the badged {@link MatchReason}
 *  path) and stays neutral — the two diverged here; do not "fix" one to match the other. */
const PRIMARY_KIND: Record<
  "method" | "topic" | "clinical" | "funding" | "concept" | "keyword",
  { word: string }
> = {
  method: { word: "Method" },
  topic: { word: "Research area" },
  clinical: { word: "Clinical" },
  funding: { word: "Funding" },
  concept: { word: "Concept" },
  keyword: { word: "Keyword" },
};

/**
 * #1381 follow-up — the count-first primary phrase: the matched **N** leads in the
 * accent (NOT the local `anchor`, which is now the entity's colour and only that),
 * then a muted "of M <thing> <relation>", then the entity. The entity carries a
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
  const anchor = dim
    ? "text-[var(--evidence-body)]"
    : "text-[var(--evidence-anchor)]";
  const muted = dim ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-body)]";
  // The matched count is the one accented datum in the phrase; the entity keeps
  // `anchor`, because two accents in one line is a legend again. A dim lead takes no
  // accent at all — a thin match must stay faint (the #1366 honesty signal).
  const count = dim ? "text-[var(--evidence-body)]" : "text-[var(--evidence-accent)]";
  const hasCount = n != null && m != null;
  return (
    <>
      {hasCount ? (
        <>
          <span className={`font-semibold ${count}`}>{n}</span>{" "}
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

/**
 * Uniform fold rule — the provenance pill. THREE values, and they answer "how do we know
 * this?", never "what category is this?": a subject tag, a bare keyword hit, or a held
 * credential. Every kind draws from the SAME two token pairs, which is the whole
 * difference from the axis #1913 retired — that one resolved a per-CATEGORY hue in a
 * column already naming the category, so it distinguished two values across 98% of rows.
 *
 * `--apollo-green-foreground`, NOT `--apollo-green`: the token literally named "semantic
 * green" is the obvious pick for green pill text and it scores 4.39:1 on its own tint,
 * which FAILS AA at 11px. The pair used here measures 6.92:1 (amber 5.28:1).
 *
 * `rounded-[3px]`, not a capsule: a pill-shaped token in a category colour is what the
 * retired per-category dot looked like, and the shape is the part a reader recognises
 * before the word. The 1px border is LOAD-BEARING, not trim — the green tint is only
 * ΔE76 5.01 against the row-hover fill #f0eeea, so on hover the border (ΔE 12.30) is what
 * keeps the pill a distinct object. Do not "simplify" it away.
 */
/** Badge the EXCEPTION, never the norm. There is no `subject-tagged` kind: it shipped in
 *  #1933 and was cut, because it appeared on 100% of the rows in its class and so carried
 *  zero bits — and it restated the `Concept` column three inches to its left, a concept
 *  match being curated by definition. Same test kills any future badge that a row's own
 *  kind column already implies.
 *
 *  What survives says something its label does not: `keyword only` (this is a string hit,
 *  not a curated tag) and `credential` (board certified — not implied by `Clinical`, and
 *  not carried by every clinical row). */
export type EvidencePillKind = "keyword-only" | "credential";

const PILL: Record<EvidencePillKind, { word: string; cls: string }> = {
  "keyword-only": {
    word: "keyword only",
    cls: "border-[var(--apollo-amber-tint-border)] bg-[var(--apollo-amber-tint)] text-[var(--apollo-amber)]",
  },
  credential: {
    word: "credential",
    cls: "border-[var(--apollo-green-tint-border)] bg-[var(--apollo-green-tint)] text-[var(--apollo-green-foreground)]",
  },
};

/** One component so the token mapping lives in exactly one place and the `shrink-0`
 *  contract (#1907 — see {@link MatchAwareReason}) cannot be lost at a call site.
 *
 *  `hideBelow` picks ONE display utility rather than appending `hidden` to the
 *  `inline-flex` already in the string: two unprefixed utilities for the same property
 *  resolve by generated-stylesheet order in Tailwind v4, not by class order, so which one
 *  won would not be readable here. Base-versus-variant is the ordering that IS defined. */
export function EvidencePill({
  kind,
  hideBelow,
}: {
  kind: EvidencePillKind;
  /** Below which breakpoint the pill is dropped, because the line it trails cannot hold
   *  it AND the phrase. The two rows need different answers, both measured in Chromium at
   *  a 56px avatar + 240px facet rail: the primary lead loses its whole third column at
   *  `lg` (see {@link MatchAwareReason}), so its pill goes with it; the lesser row is one
   *  truncating line that only truncates at all below ~480px, where the pill costs the
   *  phrase 73 of its 81px. Omitted ⇒ always shown. */
  hideBelow?: "sm" | "lg";
}) {
  const p = PILL[kind];
  const display =
    hideBelow === "lg"
      ? "hidden lg:inline-flex"
      : hideBelow === "sm"
        ? "hidden sm:inline-flex"
        : "inline-flex";
  return (
    <span
      className={`${display} shrink-0 items-center whitespace-nowrap rounded-[3px] border px-1.5 py-[1px] text-[11px] font-medium leading-[1.45] ${p.cls}`}
    >
      {p.word}
    </span>
  );
}

export function MatchAwareReason({
  kind,
  children,
  via,
  coverage,
  pill,
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
  /** Uniform fold rule — the narrower descendant term LIST (no "via" word: the copy and
   *  the typography of the line belong to the component that owns the line, matching how
   *  `descendantViaSummary` omits the wrapper). Renders as its own muted second line
   *  under the phrase. It cannot ride in `children`: those go INSIDE the truncating span,
   *  which is both a guaranteed single line and the #1907 clip by construction.
   *
   *  #1955 — `terms` is that list; `alsoParent` says whether the scholar ALSO carries the
   *  parent descriptor the list rolls up to, which is what selects the prefix below. It is
   *  a field of this object rather than a prop of its own precisely because the prefix is
   *  unsayable without it. */
  via?: { terms: string; alsoParent: boolean };
  /** Uniform fold rule — pre-formatted share of the scholar's output ("12.2%" / "<0.1%")
   *  for the right-hand tabular column, which is an `lg`-and-up column (see the narrow
   *  degradation note below). Absent ⇒ the column does not render at all (no reserved
   *  empty cell: the chevron is `ml-auto` and the body `flex-1`, so omitting it hands 64px
   *  back to the phrase and moves nothing) and the row drops its right pad with it. */
  coverage?: string;
  /** Uniform fold rule — the provenance pill trailing the phrase; `lg`-and-up like the %
   *  column, for the same measured reason. */
  pill?: EvidencePillKind;
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
  // across cards (from `lg` up — see NARROW DEGRADATION below); the chevron (via
  // DisclosureRow `wide`) is pushed to the far right.
  // #1913 — the column IS the category indicator now; the dot that used to precede it
  // repeated the word's own hue and is gone. What came back is one accent, not the
  // per-category axis: every kind gets the SAME `--evidence-accent`, and only here on
  // the primary lead, so the lead separates tonally from the neutral LesserReason rows
  // instead of the whole card reading as one flat warm grey. Dim is untouched.
  //
  // Uniform fold rule — the row is now four flex children: the kind column, a COLUMN body
  // (phrase + pill on line 1, the "via …" descendants on line 2), and the coverage cell.
  // The three single-line children take `self-start` rather than the container taking
  // `items-start`: `align-self` overrides `align-items` per item, whereas passing a second
  // same-property utility through `className` resolves by generated-stylesheet order (not
  // class-attribute order) in Tailwind v4, so which one won would not be readable off the
  // JSX. The chevron stays centred on a 2-line row — the standard accordion look, and
  // top-aligning it would mean editing `DisclosureRow`, which the compact lesser rows share.
  //
  // NARROW DEGRADATION — this three-column row is an `lg`-and-up layout, and everything
  // that makes it three columns is gated on `lg`. Measured in Chromium: the fixed chrome
  // is 124 (kind) + 7 + 7 (gaps) + 64 (% cell) + 20 + 7 (chevron) = 229px, and the card's
  // middle grid column is only 191px at a 390px viewport and 297px at 768px (the facet
  // rail costs 272px from `md` up, so the column is NARROWER at 768 than at 767). Every
  // shrink-0 addition therefore lands on the one item that can shrink — flexbox
  // distributes negative space only across non-zero shrink factors — and the phrase
  // measured 0px wide at both widths, with the pill overlapping the % cell by 93.5px and
  // overrunning the card's stats column. Below `lg`: the kind word takes a full line
  // (`w-full` + a wrapping row), the % cell is dropped, and the pill goes with it. That
  // buys the phrase 148px at 390 and 254px at 768 instead of 0.
  //
  // Nothing narrow-only is lost. The % is a rounding of "N of M", which the phrase states
  // in full and which is present whenever `coverage` is (the callers set them from the
  // same count/denominator pair). And the one surviving pill word restates the kind column
  // plus the phrase's own verb — "keyword only" against the `Keyword` column and
  // "publications mention" — which is the same redundancy that retired `subject-tagged`
  // outright; here it costs only a narrow viewport rather than every row.
  const inner = (
    <>
      <span
        className={`w-full shrink-0 self-start font-medium lg:w-[124px] ${dim ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-accent)]"}`}
      >
        {k.word}
      </span>
      {/* #1907 — anything trailing the phrase is a shrink-0 SIBLING of the truncating
          span, never its last child. Inside it, the old relevance cue was the first thing
          the pixel-boundary clip ate: a 2-of-114 lead rendered dim (the "this match is
          thin" signal) with the sentence that justified the dimming cut off. The pill and
          the coverage cell are the new occupants of that slot and inherit the invariant —
          flexbox distributes negative space only across items with a non-zero shrink
          factor, so the phrase is squeezed and they are laid out at max-content. The
          via-line does NOT carry `truncate` (pinned by result-evidence-card.test.tsx): it is
          the last content on its own line with nothing trailing it, so it wraps rather than
          clipping and can never eat a sibling — and `descendantViaSummary` budgets the whole
          rendered string, tail included, against this column's measured `lg` width, so at
          the layout this row was designed for it does not wrap either. Narrower than `lg`
          the row stacks and the line wraps, like any long text. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-[6px]">
          <span className="min-w-0 truncate">{children}</span>
          {pill ? <EvidencePill kind={pill} hideBelow="lg" /> : null}
        </span>
        {via ? (
          <span
            className={`mt-[2px] min-w-0 text-[11.5px] ${dim ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-detail)]"}`}
          >
            {/* "via X" made the reader infer the relationship — that the tag was a NARROWER
                term rolling up to their query. Naming it was right; naming it ONE way was
                not. "matched on narrower term" over-claimed, because
                `computeMatchProvenance` takes its `narrower` branch on the scholar CARRYING
                a descendant, not on the match having come through one — so the scholar
                tagged with both parent and child read as routed through the child (#1955).
                The provenance now carries `alsoParent`, and the two wordings it selects are
                NOT symmetric, because the predicate behind them is not:
                  true  — the parent tag IS in the scholar's indexed descriptor set, so the
                          descendants are additional to it and the additive wording holds.
                  false — the parent tag is absent FROM THAT INDEXED SET, which is weaker
                          than absent. `publicationMeshUi` is min-evidence filtered when the
                          people-doc is built (lib/search-index-docs.ts skips a descriptor
                          unless it appears on ≥2 pubs or on a first/last-author one), so a
                          scholar carrying the parent on exactly one middle-author paper is
                          missing from the field and still reads "matched on narrower term".
                          That cohort is a bounded over-claim and it is UNFIXED here: closing
                          it needs a second data source, which is a separate issue.
                Two strings still earn the branch — measured on staging against that same
                indexed field, only 28.8% of the scholars this line renders for carry the
                parent too.
                "also tagged", not "also includes": the subject a reader supplies for a
                subjectless clause is the nearest preceding noun phrase, and on this card
                that is the styled TERM that ENDS line 1. "also includes" therefore reads as
                a statement about the MeSH tree ("Leukemia also includes Leukemia, Hairy
                Cell") — true of every scholar on the page, and so a claim about none of
                them. Worse on the `concept` lead, which has no count and no publication set
                for any other reading to attach to. "tagged" echoes line 1's own verb, so the
                antecedent becomes this scholar's publications, and it asserts presence
                without asserting proportion — which it must, since nothing here splits line
                1's N between parent-tagged and descendant-tagged pubs.
                The line WRAPS rather than truncates either way. It is the last content on
                its own line with nothing trailing it, so wrapping costs a second line at
                worst and cannot eat a sibling; VIA_BUDGET's 2-term cap bounds it there,
                measured against the longer prefix. That is why the budget did not move. */}
            <span className="text-[var(--evidence-faint)]">
              {via.alsoParent ? "also tagged " : "matched on narrower term "}
            </span>
            {via.terms}
          </span>
        ) : null}
      </span>
      {/* Uniform fold rule — coverage is a neutral STAT in a fixed-width tabular column,
          not a caveat: it says "8% of this scholar's output", so wherever the column fits
          it is on for every count rather than only the thin ones, and it does NOT dim
          (#1907's lesson verbatim — the sentence that justifies the dimming has to survive
          it). `--evidence-body`, not the accent: the
          accent is the kind word + the matched count (#1922/#1928), and a third accented
          element rebuilds a legend. The visible number is `aria-hidden` with an sr-only
          sibling carrying the unit, so a bare "8%" is never announced as a match score;
          sr-only text also joins the enclosing button's accessible name, which `title`
          (not announced, needs a hover) and `aria-label` on a `role=generic` span (which
          AT may ignore) both fail to do. */}
      {/* The column reads as ONE scale, and it is not one: a keyword row's 5.2% and a
          concept row's 4.7% are shares of the same denominator but not the same kind of
          evidence, so ranking them against each other says the keyword scholar is the
          better match while the mechanism says the opposite. Keyword rows therefore take
          the faint ink — the number stays legible and comparable to other KEYWORD rows,
          and stops competing for the eye with the curated ones.
          This is provenance, NOT the `dim` axis, which still never touches this cell. */}
      {coverage ? (
        <span
          className={`hidden w-[64px] shrink-0 self-start pl-3 text-right tabular-nums lg:block ${kind === "keyword" ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-body)]"}`}
        >
          <span aria-hidden>{coverage}</span>
          <span className="sr-only">{coverage} of this scholar&rsquo;s output</span>
        </span>
      ) : null}
    </>
  );
  if (canExpand && onToggle) {
    return (
      <div className="mt-1.5 text-[13px] leading-snug">
        <DisclosureRow
          wide
          className="flex-wrap lg:flex-nowrap"
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
  // The pad that lines this row's % cell up with the expandable one's is 43px, and it is
  // NOT just that path's chevron plus gap.
  // `DisclosureRow` is `-mx-2 … w-full … px-2`: a block-level box with `width: 100%` and
  // two negative inline margins is over-constrained, so CSS 2.1 §10.3.3 drops the
  // margin-RIGHT (ltr) to solve the equation. The button therefore starts 8px left of this
  // wrapper and ends 8px SHORT of its right edge, i.e. its content box is 16px NARROWER on
  // the right, not wider. Measured at a 1024px viewport: the expandable row's % cell sits
  // 43px in from the middle column's right edge (16 lost to the dropped margin + 20 chevron
  // + 7 gap); an unpadded non-expandable row's sits at 0. Only `lg` needs the pad — below
  // it the % cell does not render at all.
  return (
    <div
      className={`mt-1.5 flex w-full flex-wrap items-center gap-[7px] text-[13px] leading-snug lg:flex-nowrap ${coverage ? "lg:pr-[43px]" : ""}`}
    >
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
    <p className="mb-1.5 text-[11px] italic leading-snug text-[var(--evidence-faint)]">
      text mention in the abstract, not a curated tag
    </p>
  );
}

/**
 * #1366 follow-up — a compact "Also matched" row: a muted label, an abbreviated
 * "· N of M" count, and the same chevron disclosure. The visually-subordinate sibling
 * of {@link MatchReason}/{@link MatchAwareReason}: the ONE primary signal keeps its
 * full badge, the rest demote here (tiered card, handoff Part 1).
 *
 * #1913 — the per-kind FILLED dot is gone. It sat immediately before a label in the
 * same hue, so it never distinguished anything the label did not, and the hue itself
 * was resolving two values in 98% of rows. A literal-mention row's weakness is still
 * carried by `weak` (muted/italic text) + the {@link MentionNote}, which is where that
 * signal always actually lived.
 */
export function LesserReason({
  label,
  children,
  suffix,
  pill,
  weak = false,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
  srLabel = "key papers",
}: {
  /** The kind word ("Research area", "Clinical", "Funding", …) — its OWN column, not the
   *  head of `children`. Required: a row without one has nothing holding the column open
   *  and would put its entity 108px left of every sibling. */
  label: ReactNode;
  children: ReactNode;
  /** Abbreviated "· N of M" count (no "publications" word); omitted ⇒ label-only. */
  suffix?: string;
  /** Uniform fold rule — the provenance pill, a shrink-0 SIBLING of the truncating span
   *  (#1907). This is the row the fold reveals, so it is where the `credential` pill for a
   *  board-certified clinical secondary lands. Dropped below `sm`: measured at a 320px
   *  viewport this row's text span is 81px wide and the pill takes 73 of them, leaving 8px
   *  of phrase. It costs the phrase nothing from ~480px up, which is why it is dropped at a
   *  narrower breakpoint than the primary lead's pill. */
  pill?: EvidencePillKind;
  /** Extra-muted treatment for the literal-mention rows. */
  weak?: boolean;
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
  srLabel?: string;
}) {
  const ink = weak ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-body)]";
  const inner = (
    <>
      {/* The kind word is a COLUMN, not a prefix. As inline text before a middot it ended
          wherever the word ended, so the three revealed rows started their entities at three
          different x positions — measured 40.1px apart, with nothing for the eye to run down.
          108px is not chosen for the label, it is chosen for what follows it: the 16px panel
          indent + 108 + the row's 7px gap equals the primary lead's 124 + 7, so "Prostate &
          Urologic Cancer" begins at exactly the same x as "168 of 529 publications tagged".
          The labels step in under the lead; everything right of them shares one column with it.
          Widen the widest label past 108px and that identity breaks — see the test. */}
      <span className={`shrink-0 text-[12px] font-medium lg:w-[108px] ${ink}`}>{label}</span>
      {/* Below `lg` there is no column (same narrow degradation as the lead's kind word), so
          the separator has to come back or label and entity read as one phrase across a 7px
          gap. It exists ONLY there. */}
      <span aria-hidden className={`shrink-0 text-[12px] lg:hidden ${ink}`}>
        ·
      </span>
      <span className={`min-w-0 truncate text-[12px] ${ink}`}>
        {children}
        {suffix ? <span className="text-[var(--evidence-faint)]">{suffix}</span> : null}
      </span>
      {pill ? <EvidencePill kind={pill} hideBelow="sm" /> : null}
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
  // `gap-[7px]`, matching `DisclosureRow`. It was 9px, which mattered for nothing while the
  // label was inline text and misaligns the column by 2px now that it is not — the clinical
  // row is the non-expandable one, so it would have been the single row out of line.
  return (
    <div className="mt-1 flex min-w-0 items-center gap-[7px] py-[1px] leading-snug">{inner}</div>
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
  dedupedEmpty = false,
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
  /** #1923 — this line's exemplar fetch came back empty BECAUSE a higher-priority
   *  sibling on the same card already claimed every paper (the `exclude=` de-dup).
   *  The papers are on screen, just not here, so the panel says so instead of
   *  rendering nothing. */
  dedupedEmpty?: boolean;
  /** Signal-colored left rail on the panel (blue = research area, green = funding,
   *  per-kind for the rest). Defaults to the flush `pl-[1px]` = no rail. */
  railClassName?: string;
}) {
  if (status === "loading" && papers.length === 0) {
    return (
      <div id={panelId} className="mt-1.5 pl-[1px] text-[12px] leading-snug">
        <span aria-hidden className="text-[var(--evidence-faint)]">
          finding key papers&hellip;
        </span>
      </div>
    );
  }
  if (papers.length === 0) {
    // #1923 — an expanded disclosure must never render nothing. Returning null here
    // meant a user clicked a chevron and got silence, which reads as a broken page.
    // Every branch below produces at least one line of honest text.
    return (
      <div id={panelId} className="mt-1.5 pl-[1px]">
        <p className="text-[12px] italic leading-snug text-[var(--evidence-faint)]">
          {dedupedEmpty
            ? // The de-dup case, and the useful one: this line's papers are not
              // missing, they are already listed under a stronger match on this same
              // card. Saying that is more informative than the papers would have been.
              "These papers are already listed above, under a stronger match."
            : "No separate papers to show for this match."}
        </p>
        {status === "done" && fallback ? (
          <Link
            href={fallback.href}
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 mt-1 inline-block text-[12px] font-medium text-[#1f51a8] no-underline hover:underline"
          >
            {fallback.label} →
          </Link>
        ) : null}
      </div>
    );
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
          <span className="font-normal text-[var(--evidence-faint)]"> · {panelSubtitle}</span>
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
        <span aria-hidden className="text-[var(--evidence-faint)]">
          finding key funding&hellip;
        </span>
      </div>
    );
  }
  if (grants.length === 0) {
    return null;
  }

  const more = total - grants.length;
  // #1913 — neutral rail, matching every other expanded panel. The rail's job is to tie
  // the panel to the row above it, which position already does.
  return (
    <div id={panelId} className="mt-1.5 border-l-2 border-[#a8a294] pl-[14px]">
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
