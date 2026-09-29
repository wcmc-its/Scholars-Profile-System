"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Small icon-only copy-to-clipboard button (#87). Sits next to a linked
 * identifier, copies the bare value, swaps to a checkmark for ~1500ms,
 * fails silently when the Clipboard API is unavailable. Always visible
 * (rather than hover-only) so touch surfaces and keyboard users get the
 * same affordance.
 */
export function CopyButton({
  value,
  label,
  showLabel = false,
}: {
  value: string;
  label: string;
  /** Also show a visible "Copied" word beside the check while confirmed
   *  (publication-modal header identifiers). Default stays icon-only. */
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — degrade silently; the link beside us still works.
    }
  };

  return (
    // 24x24 CSS-px hit area so the icon-only button meets WCAG 2.5.8 Target Size
    // (Minimum), AA in 2.2 (#586). The 12px glyph stays centered and visually
    // put; symmetric negative margins (-my/-mr-1.5, -ml-0.5) absorb the extra
    // box back to the original ~12px footprint, so publication-row density is
    // unchanged (verified: row height 20px before and after; axe target-size 0).
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      className={
        showLabel
          ? `-my-1.5 -ml-0.5 inline-flex h-6 min-w-6 items-center justify-center gap-[3px] px-0.5 align-middle text-xs hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-ring rounded-sm ${
              copied ? "text-foreground" : "text-muted-foreground"
            }`
          : "-my-1.5 -ml-0.5 -mr-1.5 inline-flex h-6 w-6 items-center justify-center align-middle text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-ring rounded-sm"
      }
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
      {showLabel && copied ? <span aria-hidden="true">Copied</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
