/**
 * `components/publication/pub-html.tsx` — the SINGLE sanctioned render path for
 * PubMed-sourced publication strings (title / journal / abstract). #946.
 *
 * PubMed strings carry inline scientific markup — italicized Latin/gene names
 * (`<i>BRCA1</i>`), chemical formulae (`H<sub>2</sub>O`, `CO<sup>2</sup>`),
 * emphasis (`<b>`/`<strong>`/`<em>`). Rendering them as plain JSX text escapes
 * the angle brackets so the user sees literal `<i>` markup; rendering them raw
 * via `dangerouslySetInnerHTML` without sanitizing is an injection vector.
 *
 * These components funnel every publication-string render through
 * `sanitizePubmedHtml` (the existing whitelist sanitizer in `@/lib/utils`) and
 * then `dangerouslySetInnerHTML`, so the markup is honored but anything outside
 * the `<i>/<em>/<b>/<strong>/<sup>/<sub>` whitelist (scripts, attributes,
 * event handlers, arbitrary tags) is stripped.
 *
 * This is a client-safe presentational module — no `server-only` imports — so
 * both server and client components can consume it.
 *
 * The guardrail test `tests/unit/pub-html-guard.test.ts` enforces that
 * publication title/journal/abstract render sites go through this component and
 * never inline `{pub.title}` / `<em>{pub.journal}</em>` etc.
 */
import * as React from "react";
import { cn, htmlToPlainText, sanitizePubmedHtml } from "@/lib/utils";

/**
 * Any intrinsic element tag (`"span"`, `"p"`, `"em"`, `"h2"`, …). Restricting
 * to intrinsics keeps the sanitized HTML attached to a real DOM element and
 * avoids passing `dangerouslySetInnerHTML` to a custom component that might not
 * forward it.
 */
type IntrinsicTag = keyof React.JSX.IntrinsicElements;

interface PubHtmlBaseProps {
  /**
   * The raw publication string (may contain PubMed inline markup). `null` /
   * `undefined` / empty render nothing.
   */
  value: string | null | undefined;
  /** className passthrough — REQUIRED for line-through/muted/font-medium etc. */
  className?: string;
  /**
   * `title` attribute passthrough (e.g. request-a-change-dialog's
   * `title={itemLabel}` tooltip). Stays a plain-text attribute — not sanitized
   * markup — so the browser shows the bare string on hover.
   */
  title?: string;
  /** Optional test id passthrough. */
  "data-testid"?: string;
}

interface PubHtmlProps extends PubHtmlBaseProps {
  /** The element tag to render. */
  as: IntrinsicTag;
}

/**
 * Low-level primitive: sanitize `value` with `sanitizePubmedHtml` and render it
 * into the chosen element via `dangerouslySetInnerHTML`. Renders `null` (no DOM
 * node) when the value is null/undefined/empty, so callers can drop their own
 * `value ? (...) : null` guards.
 *
 * Prefer the semantic wrappers (`PubTitle`, `PubJournal`, `PubAbstract`) over
 * this primitive at call sites; reach for `PubHtml` directly only when you need
 * an element tag the wrappers don't default to.
 */
export function PubHtml({ as, value, className, title, ...rest }: PubHtmlProps) {
  if (value == null || value === "") return null;
  const Tag = as as React.ElementType;
  return (
    <Tag
      className={className}
      title={title}
      data-testid={rest["data-testid"]}
      dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(value) }}
    />
  );
}

/**
 * Publication TITLE. Defaults to a `<span>` so it composes inside headings,
 * buttons, and flex rows without forcing block layout. Override with `as` when
 * the title needs to BE the block element (e.g. publications-card's `<p>` that
 * also carries the conditional `line-through` classes).
 *
 * @example
 *   <PubTitle as="p" className={cn("font-medium", isHidden && "line-through")} value={pub.title} />
 *   <PubTitle value={p.title} className="text-sm font-medium" />
 */
export function PubTitle({ as = "span", ...props }: PubHtmlBaseProps & { as?: IntrinsicTag }) {
  return <PubHtml as={as} {...props} />;
}

/**
 * Publication JOURNAL. Defaults to `<em>` to match the existing sanitized
 * journal sites (profile/publication-row, topic/method feeds). Pass
 * `className="not-italic"` where the design wants the `<em>` non-italic
 * (search rows, citing-pub rows).
 *
 * @example
 *   <PubJournal value={pub.journal} />
 *   <PubJournal value={hit.journal} className="not-italic" />
 *   <PubJournal as="span" value={p.journal} className="text-muted-foreground text-xs" />
 */
export function PubJournal({ as = "em", ...props }: PubHtmlBaseProps & { as?: IntrinsicTag }) {
  return <PubHtml as={as} {...props} />;
}

/**
 * Publication ABSTRACT (and abstract-shaped long text). Defaults to `<div>`
 * because abstracts are block-level. Uses the same `sanitizePubmedHtml`
 * whitelist as title/journal.
 *
 * @example
 *   <PubAbstract value={pub.abstract} className="prose text-sm" />
 */
export function PubAbstract({ as = "div", ...props }: PubHtmlBaseProps & { as?: IntrinsicTag }) {
  return <PubHtml as={as} {...props} />;
}

/**
 * Visible + announced stand-in for a publication that has no usable title
 * (#2209). Deliberately a human sentence, not `(untitled, pmid 12345)`: it is
 * what a screen reader reads out and what a sighted user sees on the row.
 */
export const UNTITLED_PUBLICATION = "Untitled publication";

/** Muted italic so the stand-in never reads as the paper's actual title. */
const UNTITLED_CLASS = "text-muted-foreground font-normal italic";

/**
 * Plain-text accessible name for a publication title. GUARANTEED non-empty —
 * falls back to {@link UNTITLED_PUBLICATION} when the title is missing, blank,
 * or nothing but markup.
 */
export function pubTitleAccessibleName(titleHtml: string | null | undefined): string {
  return htmlToPlainText(titleHtml ?? "", Number.POSITIVE_INFINITY) || UNTITLED_PUBLICATION;
}

/**
 * Props for the element that RENDERS a publication title as its whole content —
 * the `<button>` that opens the detail modal, an `<a>` to PubMed, the modal's
 * own `<h2>` (which names the dialog via `aria-labelledby`).
 *
 * Two guarantees, both of which #2209 broke in prod:
 *
 *  1. **A discernible accessible name, always.** Those elements name themselves
 *     from their own content, so a blank title produced a button with NO
 *     accessible name — a WCAG 4.1.2 failure, and the button's entire purpose
 *     is to open the detail modal. The `aria-label` is set unconditionally, so
 *     the name is a property of the component rather than an accident of
 *     whether that row's title happens to be populated. It is the plain text of
 *     the very markup being rendered, so WCAG 2.5.3 (Label in Name) holds.
 *  2. **Never an empty box.** A title-less publication renders the stand-in
 *     text instead of collapsing to a zero-height, unlabeled click target.
 *
 * `titleHtml` must ALREADY be sanitized — `sanitizePubTitle` for a plain title,
 * `highlightedTitleHtml` for a search fragment. Re-sanitizing here would strip
 * the `<mark>` pills the highlight path exists to produce.
 *
 * @example
 *   <button type="button" aria-haspopup="dialog" onClick={…}
 *           {...pubTitleProps(titleHtml, "text-left hover:underline")} />
 */
export function pubTitleProps(
  titleHtml: string | null | undefined,
  className?: string,
): {
  className?: string;
  "aria-label": string;
  dangerouslySetInnerHTML: { __html: string };
} {
  const plain = htmlToPlainText(titleHtml ?? "", Number.POSITIVE_INFINITY);
  const untitled = plain === "";
  return {
    className: untitled ? cn(className, UNTITLED_CLASS) : className,
    "aria-label": untitled ? UNTITLED_PUBLICATION : plain,
    // The stand-in is a plain ASCII literal, so it needs no escaping; the real
    // title arrives pre-sanitized (see above).
    dangerouslySetInnerHTML: { __html: untitled ? UNTITLED_PUBLICATION : (titleHtml as string) },
  };
}
