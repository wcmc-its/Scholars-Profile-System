import { Fragment, type ReactNode } from "react";

/** Escape a string for safe interpolation into a RegExp (the term is data). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #917 — render `text` with each verbatim, case-insensitive occurrence of `term`
 * wrapped in a `<mark>`, so a reader sees exactly where the term is named inside a
 * usage snippet. The highlighted text keeps the SNIPPET's own casing. When the
 * term does not appear verbatim (e.g. an acronym the sentence spells out), `text`
 * renders unchanged — no mark.
 *
 * `markClassName` defaults to the always-dark-tooltip style (white-on-dark, used by
 * the publication modal's `HoverTooltip`); pass a theme-aware class for surfaces
 * whose tooltip flips with the color scheme (e.g. the Radix `TooltipContent` on the
 * profile methods panel uses `bg-foreground text-background`).
 */
export function markTermInText(
  text: string,
  term: string,
  markClassName = "rounded-[2px] bg-white/20 px-0.5 font-medium text-white not-italic",
): ReactNode {
  const t = term.trim();
  if (!t) return text;
  // Capturing group → split keeps the matched substrings at odd indices.
  const parts = text.split(new RegExp(`(${escapeRegExp(t)})`, "gi"));
  if (parts.length === 1) return text; // no occurrence
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={markClassName}>
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
