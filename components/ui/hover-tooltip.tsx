"use client";

/**
 * Hover/focus tooltip wrapper used across chip-style elements (author chips,
 * grant role chips, publication-meta rows, etc.). Dark zinc-900 pill, 11px
 * white text, arrow indicator. Default behavior: 200ms delay on mouse-enter,
 * immediate on focus.
 *
 * Built on the Radix Tooltip primitive (the same one components/ui/tooltip.tsx
 * wraps) so the bubble is portaled and collision-aware — near a viewport or
 * container edge it shifts to stay on-screen instead of overflowing and getting
 * clipped (#1376). A TooltipProvider is self-contained here, so call sites need
 * no surrounding provider.
 *
 * Optional `immediate` skips the mouse-enter delay (issue #259 §1.11 — the
 * MeSH-concept chip's scope note should surface without waiting). Optional
 * `wide` lets the tooltip wrap paragraph-length text (default
 * `whitespace-nowrap` is right for short labels but truncates sentences).
 *
 * Optional `triggerClassName` / `triggerStyle` style the WRAPPER span. They exist
 * because the wrapper — not the child — is what the surrounding layout sizes: wrap
 * a flex item and the wrapper becomes the flex item, so a child carrying
 * `flexGrow`/`flexBasis` silently loses them and collapses to its min-width. Matcha's
 * coverage strip is exactly that case — each segment's width IS its concept's weight —
 * and the collapse is invisible to tests (pure pixels). Both default to undefined, so
 * every existing call site renders byte-identically.
 */
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export function HoverTooltip({
  text,
  body,
  children,
  immediate = false,
  wide = false,
  placement = "top",
  triggerClassName,
  triggerStyle,
}: {
  text: string;
  /** Optional rich tooltip body rendered in place of `text` (e.g. a snippet with
   *  the matched term `<mark>`-highlighted). `text` stays required as the plain
   *  fallback / accessible string; pass both and `body` wins for the visual. */
  body?: React.ReactNode;
  children: React.ReactNode;
  /** Show on mouse-enter with no 200ms delay. Always immediate on focus. */
  immediate?: boolean;
  /** Allow wrapping + cap width — for sentence-length text such as MeSH
   *  scope notes. Defaults off so existing short-label callers are
   *  unaffected. */
  wide?: boolean;
  /** Side to render the pill on. Defaults `"top"` (the original behavior).
   *  Use `"bottom"` when the trigger sits near the page header — the
   *  resolved-concept chip at the top of /search clips against the page
   *  chrome otherwise. */
  placement?: "top" | "bottom";
  /** Classes for the wrapper span. Merged after `relative inline-flex`, so a
   *  conflicting utility (a width, a `shrink-0`) wins via tailwind-merge. */
  triggerClassName?: string;
  /** Inline style for the wrapper span — for geometry no utility expresses, such as
   *  the coverage strip's per-segment `flexGrow: weight`. */
  triggerStyle?: React.CSSProperties;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={immediate ? 0 : 200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span className={cn("relative inline-flex", triggerClassName)} style={triggerStyle}>
            {children}
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={placement}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              "pointer-events-none z-50 rounded bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow",
              wide
                ? "w-max max-w-[320px] whitespace-normal leading-snug"
                : "whitespace-nowrap",
            )}
          >
            {body ?? text}
            <TooltipPrimitive.Arrow className="fill-zinc-900" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
