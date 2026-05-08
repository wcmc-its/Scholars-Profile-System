"use client";

import { AbbrTooltip } from "@/components/ui/abbr-tooltip";
import { expandMechanism } from "@/lib/mechanism-lookup";

/**
 * Render an NIH activity-code mechanism (e.g. "R01", "K23") with hover /
 * focus expansion. Falls through to a plain span when the code isn't in
 * the canonical mechanism lookup (issue #78 F4).
 */
export function MechanismAbbr({ code, className }: { code: string; className?: string }) {
  return <AbbrTooltip short={code} expand={expandMechanism(code)} className={className} />;
}
