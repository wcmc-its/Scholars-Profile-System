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
 * join is unreadable. (Mirrors the people-result-card note; once #705 lands the
 * Scholars-tab copy will import this shared component too.)
 */
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
  const MAX = 3;
  const shown = terms.slice(0, MAX);
  const hidden = terms.slice(MAX);
  const extra = hidden.length;
  const plural = shown.length > 1 || extra > 0;
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
        <span
          title={hidden.join("; ")}
          className="cursor-help underline decoration-dotted underline-offset-2"
        >
          {" "}
          and {extra} more
        </span>
      ) : null}
      {` — ${plural ? "narrower terms" : "a narrower term"} of `}
      <span>&ldquo;{parentTerm}&rdquo;</span>.
    </>
  );
}
