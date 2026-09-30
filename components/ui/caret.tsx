/**
 * The one disclosure caret. Replaces the browser's <details> triangle and the
 * ▶ ▸ ▾ ▴ glyphs the UI used to type inline.
 *
 * - Expand (default): chevron right, turns down when open.
 * - `dropdown`: chevron down, flips up when open (menus, "Show more ▾" links).
 *
 * Inside a <summary>, omit `open`: the caret follows its OWN <details>
 * (`details[open]>summary>&`), so nested disclosures don't all turn when an
 * outer one opens (`group-open:` would). Pair the summary with
 * `SUMMARY_NO_MARKER` to hide the native triangle.
 */
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/** Hides the native <details> marker (list-none for Chrome/Firefox, the
 *  webkit pseudo-element for Safari). */
export const SUMMARY_NO_MARKER = "list-none [&::-webkit-details-marker]:hidden";

export function Caret({
  open,
  dropdown = false,
  className,
}: {
  /** Controlled state for button toggles; omit inside a <summary>. */
  open?: boolean;
  dropdown?: boolean;
  className?: string;
}) {
  const Icon = dropdown ? ChevronDown : ChevronRight;
  const turn =
    open === undefined
      ? dropdown
        ? "[details[open]>summary>&]:rotate-180"
        : "[details[open]>summary>&]:rotate-90"
      : open && (dropdown ? "rotate-180" : "rotate-90");
  return (
    <Icon
      aria-hidden
      data-slot="caret"
      className={cn("size-3.5 shrink-0 transition-transform", turn, className)}
    />
  );
}
