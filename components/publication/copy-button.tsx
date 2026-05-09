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
}: {
  value: string;
  label: string;
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
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      className="ml-1 inline-flex items-center align-middle text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
