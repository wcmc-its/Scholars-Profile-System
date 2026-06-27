"use client";

/**
 * Small inline prestige pill for funding-opportunity cards on `/edit`.
 *
 * Renders only the prestige LABEL, with the producer's rationale as the
 * hover/title tooltip (omitted when null). Per the shared contract, this badge
 * deliberately does NOT surface per-topic scores; the funding mechanism and
 * award ceiling already render elsewhere on the card, so the badge is
 * label + rationale only.
 *
 * Reuses the shared `Badge` and the same `outline` + apollo-slate-tint styling
 * the sibling funding-card status pill ("Active"/"Past") uses, so the prestige
 * pill reads identically alongside it.
 */
import { Badge } from "@/components/ui/badge";
import type { Prestige } from "@/lib/funding/prestige";

export function PrestigeBadge({ prestige }: { prestige: Prestige | null | undefined }) {
  if (!prestige) return null;
  return (
    <Badge
      variant="outline"
      className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
      title={prestige.rationale ?? undefined}
    >
      {prestige.label}
    </Badge>
  );
}
