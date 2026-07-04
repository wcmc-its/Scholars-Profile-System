import type { ResultEvidence } from "@/lib/api/result-evidence";
import { MatchAwareReason, LesserReason, CountFirst } from "@/components/search/match-reason";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import { ConceptChipRow } from "@/components/search/concept-chip-row";

/**
 * #1366 follow-up Part B — a PRIMARY lead whose matched-pub share of the scholar's
 * output (`count / pubCount`) falls below this gets a "· X% of output" coverage cue
 * and is fainted. Tunable. 2% structurally only fires for high-output scholars (a
 * 1-pub match needs >50 pubs to dip under it), so it self-guards against tiny
 * denominators: it separates a 1-of-538 lead (0.2%, fires) from a 4-of-98 (4.1%) or
 * 3-of-44 (6.8%) lead (don't).
 */
const COVERAGE_CUE_THRESHOLD = 0.02;

/** #1381 follow-up — the subtle dotted underline that marks a matched entity for every
 *  kind EXCEPT a literal keyword/mention (method family, research area, concept term,
 *  clinical specialty, funding-tagged concept). */
const ENTITY_UNDERLINE =
  "underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]";

/** #1366 follow-up Part B — the "X.X% of output" coverage figure, rounded to one
 *  decimal; a share that rounds below 0.1% reads "<0.1%" rather than a misleading
 *  "0.0%". */
function coveragePct(count: number, total: number): string {
  const rounded = Math.round((1000 * count) / total) / 10;
  return rounded === 0 ? "<0.1%" : `${rounded}%`;
}

/**
 * #824 follow-up Phase 1 — the ONE renderer for the coherent search-result
 * evidence model (`lib/api/result-evidence.ts`, handoff §4). Given the single
 * `ResultEvidence` the server selected, render exactly that — the card never
 * re-derives priority. Mirrors `docs/mockups/search-snippet/snippet-cases.html`.
 *
 * Areas use the E2 treatment (handoff §5#1, settled by the 2026-06-16
 * fall-through measurement = 6% blank ≪ 15% gate): the match slot shows an
 * honest-empty line and the self-reported areas render BELOW it as a separate,
 * clearly-labeled "Areas" hint that is NOT styled as a match reason — separating
 * "why this matched" from "who is this".
 */

// Mockup token: italic, very light — an honest "nothing matched" line, never a
// fabricated reason.
function EmptyMatchLine() {
  return (
    <div className="mt-2 text-[12px] italic leading-snug text-[#bdbdbd]">
      &mdash; no specific match for this query &mdash;
    </div>
  );
}

// Mockup `.identity`: a labeled, boxed "who is this" hint, bounded to the
// server-capped labels with a "+N more" tail. The middot carries real spacing
// (handoff §3b — `· label`, not `·label`).
function AreasHint({ labels, total }: { labels: string[]; total: number }) {
  const more = total - labels.length;
  return (
    <div className="mt-2 flex min-w-0 items-baseline gap-2 rounded-md border border-[#e3e2dd] bg-[#f7f6f3] px-2.5 py-1.5 text-[12px] text-muted-foreground">
      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#9a958a]">
        Areas
      </span>
      <span className="min-w-0 truncate text-[#4a4a4a]">
        {labels.map((label, i) => (
          <span key={`${label}-${i}`}>
            {i > 0 ? <span className="px-1.5 text-[#c9c4ba]">·</span> : null}
            {label}
          </span>
        ))}
        {more > 0 ? <span className="ml-1 font-semibold text-[#9a958a]">+{more} more</span> : null}
      </span>
    </div>
  );
}

export function ResultEvidence({
  evidence,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
  hasQuery = true,
  slug,
  pubCount,
  stacked = false,
  tier = "primary",
}: {
  evidence: ResultEvidence;
  /** Rep-papers disclosure — when true and the evidence is a method/topic/
   *  publications match, the reason row shows a clickable chevron `<button>`
   *  controlling the representative-papers panel `panelId`. The card owns the
   *  state + the lazy fetch (method/topic) or the inline pubs (publications). */
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
  /** #1381 — DEPRECATED / ignored. The publications reason row is now the count-first
   *  dot layout for all callers (the §4.7 flavor pill was removed), so this no longer
   *  gates anything; kept only so existing callers keep type-checking. */
  badged?: boolean;
  /** True when there is an active query. The honest-empty match line ("— no
   *  specific match for this query —") only makes sense when something was being
   *  matched; on the no-query Browse page it is suppressed for the identity
   *  kinds (areas/concepts/none), which carry no match snippet to hide. */
  hasQuery?: boolean;
  /** Scholar slug — used to build the `concepts` chip deep-links
   *  (`/{slug}?mesh=<ui>#publications`). Required wherever a concepts evidence
   *  can render (the People card always passes it). */
  slug?: string;
  /** #1366 — the scholar's total pub count (M), paired with `evidence.count` (N)
   *  to render the "· N of M publications" suffix on method/area lines. Absent ⇒
   *  no suffix (the single-evidence path passes no count, so this stays label-only). */
  pubCount?: number;
  /** #1366 follow-up — true only in the tiered (`evidenceLines`) context. The Part B
   *  relevance cues are scoped to it so the single-evidence path stays visually frozen,
   *  matching the `stacked`-gated C/D tiering and Part A's panel relabel. */
  stacked?: boolean;
  /** #1366 follow-up — "primary" = the prominent lead signal (today's full badge);
   *  "lesser" = a compact "Also matched" dot row. Identity-fallback kinds are always
   *  solo, so they only ever render as "primary". */
  tier?: "primary" | "lesser";
}) {

  // #1366 follow-up — compact "Also matched" dot rows: the dot is always FILLED in
  // the category color (Part C); a literal keyword mention's weakness is carried by
  // muted/italic text (`weak`) + the MentionNote, not the dot. Count is abbreviated
  // ("· N of M", no "publications" word). The disclosure panel is the SAME (rep
  // papers); only this summary row restyles.
  if (tier === "lesser") {
    const lesserCount = (count: number | undefined): string | undefined =>
      count != null && pubCount != null ? ` · ${count} of ${pubCount} publications` : undefined;
    switch (evidence.kind) {
      case "method":
        return (
          <LesserReason
            dotClassName="bg-[#8B4A2F]"
            suffix={lesserCount(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className="font-medium text-[#8B4A2F]">Method</span> ·{" "}
            <span className={`font-[450] text-[#3a3a3a] ${ENTITY_UNDERLINE}`}>{evidence.family}</span>
          </LesserReason>
        );
      case "topic":
        return (
          <LesserReason
            dotClassName="bg-[#2563eb]"
            suffix={lesserCount(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className="font-medium text-[#1d4ed8]">Research area</span> ·{" "}
            <span className={`font-[450] text-[#3a3a3a] ${ENTITY_UNDERLINE}`}>{evidence.label}</span>
          </LesserReason>
        );
      case "clinical":
        return (
          <LesserReason
            dotClassName="bg-[#0891b2]"
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className="font-medium text-[#0e7490]">Clinical</span> ·{" "}
            {evidence.boardCertified ? (
              <>
                Board certified in{" "}
                <span className={`font-[450] text-[#3a3a3a] ${ENTITY_UNDERLINE}`}>{evidence.specialty}</span>
              </>
            ) : (
              <span className={`font-[450] text-[#3a3a3a] ${ENTITY_UNDERLINE}`}>{evidence.specialty}</span>
            )}
          </LesserReason>
        );
      case "publications": {
        const mention = evidence.strength === "mention";
        return (
          <LesserReason
            // #1366 follow-up Part C — dots are always FILLED in the category color; a
            // mention's weakness is carried by `weak` (muted/italic text) + the
            // MentionNote, not a hollow dot.
            dotClassName={mention ? "bg-[#64748b]" : "bg-[#7c3aed]"}
            weak={mention}
            suffix={lesserCount(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className={`font-medium ${mention ? "text-[#475569]" : "text-[#6d28d9]"}`}>
              {mention ? "Keyword" : "Concept"}
            </span>
            {evidence.term ? (
              <>
                {" · "}
                <span
                  className={
                    mention
                      ? "font-[450] text-[#3a3a3a]"
                      : `font-[450] text-[#3a3a3a] ${ENTITY_UNDERLINE}`
                  }
                >
                  {evidence.term}
                </span>
              </>
            ) : null}
          </LesserReason>
        );
      }
      default:
        // Identity fallbacks (concepts/areas/none) are always solo ⇒ never lesser.
        return null;
    }
  }

  // #1366 follow-up Part B — relevance cues on the PRIMARY lead. Two independent
  // caveats, both also FAINT the lead (`dim`): a low-coverage cue when the matched
  // pubs are a tiny share of the scholar's output, and a "keyword-only" type cue when
  // the lead is a literal mention. PRECEDENCE: keyword-only wins (the stronger
  // weakness signal); never stack both. Funding-promoted + identity-fallback primaries
  // are handled elsewhere / have no pub coverage, so they carry no cue. Scoped to the
  // tiered (`stacked`) context — the single-evidence path stays frozen (matches C/D).
  const primaryCount =
    evidence.kind === "method" ||
    evidence.kind === "topic" ||
    evidence.kind === "publications"
      ? evidence.count
      : undefined;
  const lowCoverage =
    primaryCount != null &&
    pubCount != null &&
    pubCount > 0 &&
    primaryCount / pubCount < COVERAGE_CUE_THRESHOLD;
  const keywordOnly = evidence.kind === "publications" && evidence.strength === "mention";
  const cue = !stacked
    ? undefined
    : keywordOnly
      ? " · term match only"
      : lowCoverage
        ? ` · ${coveragePct(primaryCount!, pubCount!)} of output`
        : undefined;
  const dim = cue != null;

  switch (evidence.kind) {
    case "method":
      return (
        <MatchAwareReason
          kind="method"
          cue={cue}
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          <CountFirst
            n={evidence.count}
            m={pubCount}
            thing="publications"
            relation="used"
            entity={evidence.family}
            underline
            dim={dim}
          />
        </MatchAwareReason>
      );
    case "topic":
      return (
        <MatchAwareReason
          kind="topic"
          cue={cue}
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          <CountFirst
            n={evidence.count}
            m={pubCount}
            thing="publications"
            relation="in"
            entity={evidence.label}
            underline
            dim={dim}
          />
        </MatchAwareReason>
      );
    case "clinical":
      // No count — the dotted underline (every kind but keyword) marks the specialty.
      return (
        <MatchAwareReason
          kind="clinical"
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {evidence.boardCertified ? <span className="text-[#8c8c8c]">Board certified in </span> : null}
          <CountFirst entity={evidence.specialty} underline />
        </MatchAwareReason>
      );
    case "publications": {
      // §4.5 flavor: a MeSH-descriptor hit IS a concept (tagged/concept → "Concept"); a
      // literal mention → "Keyword". Count-first emphasis: bold the leading matched count
      // in the server phrase ("N of M publications tagged/mention"), keep the rest muted,
      // then the term. The dotted underline marks a system-resolved concept — a literal
      // keyword/mention term stays plain (semibold, no underline).
      const mention = evidence.strength === "mention";
      const anchor = dim ? "text-[#9a958a]" : "text-[#1a1a1a]";
      const muted = dim ? "text-[#9a958a]" : "text-[#8c8c8c]";
      const lead = evidence.text.match(/^(\d[\d,]*)(\s[\s\S]*)$/);
      return (
        <MatchAwareReason
          kind={mention ? "keyword" : "concept"}
          cue={cue}
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {lead ? (
            <>
              <span className={`font-semibold ${anchor}`}>{lead[1]}</span>
              <span className={muted}>{lead[2]}</span>
            </>
          ) : (
            <span className={muted}>{evidence.text}</span>
          )}
          {evidence.term ? (
            <>
              {" "}
              {/* #1361 — the matched term is semibold; the dotted underline (§4.5) is
                  added ONLY for a system-resolved concept (tagged/concept), never a
                  literal `mention`. */}
              <span className={mention ? `font-semibold ${anchor}` : `font-semibold ${anchor} ${ENTITY_UNDERLINE}`}>
                {evidence.term}
              </span>
              {/* #1355 — the narrower descendant term(s) the scholar actually carries. */}
              {evidence.descendantTerms && evidence.descendantTerms.length > 0 ? (
                <span className="text-[#6b7280]">
                  {" "}
                  (matched {evidence.descendantTerms.slice(0, 2).join(", ")}
                  {evidence.descendantTerms.length > 2
                    ? `, +${evidence.descendantTerms.length - 2} more`
                    : ""}
                  )
                </span>
              ) : null}
            </>
          ) : null}
        </MatchAwareReason>
      );
    }
    case "name":
      // Strongest signal — render the matched name fragment, term bold.
      return (
        <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "selfDescription":
      return (
        <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "affiliation":
      // Weak/organizational (handoff Edge G) — lighter than a real reason.
      return (
        <div className="mt-2 text-[12.5px] leading-snug text-[#777]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "concepts":
      // SEARCH_PEOPLE_CONCEPT_HINT — the top-MeSH identity hint, a single-line
      // fit-to-width row of deep-linking chips behind a tag glyph. Same E2
      // treatment as areas: an honest-empty match line ABOVE the row when there
      // is a query, the row alone on the no-query Browse page.
      return (
        <>
          {hasQuery ? <EmptyMatchLine /> : null}
          <ConceptChipRow items={evidence.items} slug={slug ?? ""} />
        </>
      );
    case "areas":
      // E2 — honest-empty match line + the separate "Areas" identity hint.
      return (
        <>
          {hasQuery ? <EmptyMatchLine /> : null}
          <AreasHint labels={evidence.labels} total={evidence.total} />
        </>
      );
    case "none":
      return hasQuery ? <EmptyMatchLine /> : null;
    default:
      // Phase-2 stub kinds (fundingRole / awardAmount) are not produced on the
      // People tab yet; render nothing rather than guess a treatment.
      return null;
  }
}
