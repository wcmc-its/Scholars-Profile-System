"use client";

/**
 * Dotted-underline "defined term" hover for `/edit/data-sharing` — the
 * stakeholder asked for key terms defined "in the form of a hover"
 * (2026-08-16 v3 pass). Wraps `HoverTooltip` (wide, so a sentence-length
 * definition wraps instead of truncating) around a term whose definition
 * lives in `DATA_SHARING_TERMS` (`lib/edit/data-sharing-methods-doc.ts`) —
 * ONE glossary shared with the Methods dialog and the `?section=methods`
 * markdown export, so the hover text and the written methods can't drift.
 *
 * Client island on purpose: `HoverTooltip` is a Radix Tooltip, and the known
 * SSR trap is Radix `asChild` composed directly from a server component —
 * `HoverTooltip` wraps its children in its own trigger span instead, and this
 * file keeps the whole thing behind one client boundary anyway. Safe to
 * import from the server-rendered dashboard: `data-sharing-methods-doc` is a
 * pure module (type-only report import, no prisma/db — see its header), so
 * nothing here can drag the mariadb driver into the client bundle.
 */
import type { ReactNode } from "react";

import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { DATA_SHARING_TERMS } from "@/lib/edit/data-sharing-methods-doc";

export function DefinedTerm({
  term,
  caveat,
  children,
}: {
  /** Key into `DATA_SHARING_TERMS`. An unknown key degrades to showing the
   *  key itself as the tooltip rather than crashing the page over a glossary
   *  rename — but keep the two in sync; the degrade is a safety net, not a
   *  free-text escape hatch. */
  term: string;
  /** Extra sentence appended after the glossary definition — the §4
   *  Concerning/Foreign-hosted headers pass `CONCERNING_CAVEAT` here so the
   *  tier-only scope caveat (SPEC "Amended 08-13") survives the move from a
   *  `title=` attribute into this tooltip. Never drop it from those columns. */
  caveat?: string;
  /** The visible label — usually, but not necessarily, the term itself
   *  (e.g. "strict floor" lowercase on the §1 card). */
  children: ReactNode;
}) {
  const definition = DATA_SHARING_TERMS[term] ?? term;
  return (
    <HoverTooltip text={caveat ? `${definition} ${caveat}` : definition} wide>
      <span className="cursor-help underline decoration-dotted underline-offset-2">{children}</span>
    </HoverTooltip>
  );
}
