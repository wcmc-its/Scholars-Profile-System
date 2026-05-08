"use client";

import { funderVerbose } from "@/lib/sponsor-lookup";

/**
 * Renders a funder for the eyebrow line on result cards. Verbose mode —
 * shows the full canonical name (e.g. "National Cancer Institute") rather
 * than the short code. Falls back to the bare short when the sponsor
 * isn't in the canonical lookup. (issue #80, follow-up)
 */
export function FunderEyebrow({
  short,
  className,
}: {
  short: string;
  className?: string;
}) {
  return <span className={className}>{funderVerbose(short)}</span>;
}
