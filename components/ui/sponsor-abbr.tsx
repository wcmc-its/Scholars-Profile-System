"use client";

import { AbbrTooltip } from "@/components/ui/abbr-tooltip";
import { expandSponsor } from "@/lib/sponsor-lookup";

/**
 * Render a sponsor short name with hover/focus expansion to its full name.
 * Falls through to a plain span when the short name isn't in the canonical
 * sponsor lookup (issue #78 F4, F5).
 */
export function SponsorAbbr({ short, className }: { short: string; className?: string }) {
  return <AbbrTooltip short={short} expand={expandSponsor(short)} className={className} />;
}
