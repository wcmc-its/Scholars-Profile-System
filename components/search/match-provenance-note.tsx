"use client";

import { useState } from "react";
import type { MatchProvenance } from "@/lib/api/match-provenance";

/**
 * Issue #688 / #702 / #707 — the "Why this match" note for a MeSH attribution
 * hit, shared by the Scholars and Publications tabs: the row surfaced because it
 * is tagged with the searched concept itself (`concept`) or a *narrower* term
 * (`narrower`, e.g. "Breast Cancer" → "Carcinoma, Ductal, Breast"). The
 * query-keyed highlighter can't explain that (the typed term isn't in the text),
 * so we spell it out.
 *
 * Terms are quoted because MeSH descriptor names are inverted and routinely
 * carry internal commas ("Carcinoma, Ductal, Breast") — an unquoted comma/"and"
 * join is unreadable. When more than `MAX` narrower terms match, the surplus is
 * collapsed behind an "and N more" control that expands the full list in place
 * on click/Enter (progressive disclosure; everything is still reachable on the
 * linked topic page).
 */
const MAX = 3;

export function MatchProvenanceNote({ provenance }: { provenance: MatchProvenance }) {
  return (
    <div className="mt-2 border-l-2 border-[#e3cfcf] pl-2.5 text-[13px] leading-snug text-[#4a4a4a]">
      <span className="mr-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#5f594d]">
        Why this match
      </span>
      {provenance.kind === "narrower" ? (
        <NarrowerTerms parentTerm={provenance.parentTerm} terms={provenance.descendantTerms} />
      ) : (
        <>
          tagged{" "}
          <strong className="font-semibold text-[#1a1a1a]">
            &ldquo;{provenance.parentTerm}&rdquo;
          </strong>
          .
        </>
      )}
    </div>
  );
}

function NarrowerTerms({ parentTerm, terms }: { parentTerm: string; terms: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? terms : terms.slice(0, MAX);
  const extra = terms.length - shown.length;
  const plural = terms.length > 1;

  // The card row is itself a link (Scholars tab); stop the click/keypress from
  // navigating so the control only toggles disclosure.
  const expand = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(true);
  };

  return (
    <>
      {shown.map((term, i) => {
        const isFinal = i === shown.length - 1 && extra === 0;
        const sep = i === 0 ? "" : isFinal ? " and " : ", ";
        return (
          <span key={i}>
            {sep}
            <strong className="font-semibold text-[#1a1a1a]">&ldquo;{term}&rdquo;</strong>
          </span>
        );
      })}
      {extra > 0 ? (
        <>
          {" "}
          and{" "}
          <span
            role="button"
            tabIndex={0}
            onClick={expand}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") expand(e);
            }}
            className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 hover:text-[#1a1a1a] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#8f1320]"
          >
            {extra} more
          </span>
        </>
      ) : null}
      {` — ${plural ? "narrower terms" : "a narrower term"} of `}
      <span>&ldquo;{parentTerm}&rdquo;</span>.
    </>
  );
}
