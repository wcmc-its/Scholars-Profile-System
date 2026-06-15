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
import { sanitizePubmedHtml } from "@/lib/utils";

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
