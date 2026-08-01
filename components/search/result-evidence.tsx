import type { ResultEvidence } from "@/lib/api/result-evidence";
import type { EvidencePillKind } from "@/components/search/match-reason";
import { MatchAwareReason, LesserReason, CountFirst } from "@/components/search/match-reason";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import { ConceptChipRow } from "@/components/search/concept-chip-row";
import { descendantViaSummary } from "@/lib/search/descendant-summary";

/**
 * #1366 follow-up Part B — a PRIMARY lead whose matched-pub share of the scholar's
 * output (`count / pubCount`) falls below this is FAINTED. Tunable. 2% structurally only
 * fires for high-output scholars (a 1-pub match needs >50 pubs to dip under it), so it
 * self-guards against tiny denominators: it separates a 1-of-538 lead (0.2%, fires) from
 * a 4-of-98 (4.1%) or 3-of-44 (6.8%) lead (don't).
 *
 * Uniform fold rule — this used to gate the "· X% of output" cue STRING as well. The
 * percentage is now an always-on neutral column (see `coverage` below), so the threshold
 * gates the dim and nothing else. The name is kept: it is still the same judgement about
 * the same ratio.
 *
 * A METHOD LEAD IS MEASURED AGAINST A DIFFERENT POOL. Method extraction covers 2020+ BY
 * DESIGN, so a method numerator is drawn from the scholar's method-INDEXED publications
 * and not from `pubCount`. Dividing it by `pubCount` produced "11 of 923 … · 1.2%" for a
 * scholar with 27 method-indexed papers — an honest 41% — and at 1.2% this threshold then
 * dimmed their single strongest signal. Both the share and the dim now use
 * `methodPubCount` for method lines (see `denominator` below); no other kind changes.
 *
 * Note what is NOT here: a method EXEMPTION from the dim. With the right denominator the
 * dim simply stops firing on its own, and a method match that is genuinely thin against
 * its own eligible pool still deserves to be faint. The bug was the arithmetic, not the
 * judgement.
 */
const COVERAGE_CUE_THRESHOLD = 0.02;

/** #1381 follow-up — the subtle dotted underline that marks a matched entity for every
 *  kind EXCEPT a literal keyword/mention (method family, research area, concept term,
 *  clinical specialty, funding-tagged concept). */
const ENTITY_UNDERLINE =
  "underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]";

/** #1366 follow-up Part B — the coverage figure, rounded to one decimal; a share that
 *  rounds below 0.1% reads "<0.1%" rather than a misleading "0.0%". Uniform fold rule —
 *  the words " of output" moved to the sr-only copy in the column, so this returns the
 *  number alone. */
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
    <div className="mt-2 text-[12px] italic leading-snug text-[var(--evidence-faint)]">
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
      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.06em] text-[var(--evidence-body)]">
        Areas
      </span>
      <span className="min-w-0 truncate text-[#4a4a4a]">
        {labels.map((label, i) => (
          <span key={`${label}-${i}`}>
            {i > 0 ? <span className="px-1.5 text-[var(--evidence-faint)]">·</span> : null}
            {label}
          </span>
        ))}
        {more > 0 ? (
          <span className="ml-1 font-semibold text-[var(--evidence-body)]">+{more} more</span>
        ) : null}
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
  methodPubCount,
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
  /** The scholar's method-INDEXED publication count (`PeopleHit.methodPubCount`) — the
   *  denominator a METHOD line's "N of M" and its % column are measured against, because
   *  method extraction is post-2020 by design and `pubCount` is the whole career. Read
   *  ONLY for `evidence.kind === "method"`; every other kind keeps `pubCount` verbatim.
   *  Absent ⇒ the method line prints the count alone ("11 publications used …") with no
   *  "of M" and no % column. Do NOT fall back to `pubCount` here — that fallback IS the
   *  bug, and a wrong share reads as a verdict on the scholar. */
  methodPubCount?: number;
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
    // "N of M" is a SHARE, and a share is only meaningful when the numerator answers the
    // question the denominator frames — "how much of this scholar's output is about what I
    // searched for". Only the publications count does. `areaCounts` and `methodFamilyCounts`
    // are doc-precomputed at index time (`search-index-docs.ts`) and are NOT query-filtered:
    // the AREA is picked by the query, but its 27 is the scholar's total in that area and is
    // the same 27 whatever you searched. Framed as `27 of 529` beside `168 of 529` it reads
    // as 5.1% vs 31.8% — "the area signal is 6× weaker" — when it is really MeSH tagging and
    // topic assignment having different coverage. Two pipelines, one frame.
    //
    // So the scholar-scoped counts state a magnitude and no share. This also makes each row
    // agree with its own collapsed chip, which never had a denominator ("Research area · 27
    // pubs"); the expanded row was the only place the comparison was manufactured.
    const lesserShare = (count: number | undefined): string | undefined =>
      count != null && pubCount != null ? ` · ${count} of ${pubCount} publications` : undefined;
    const lesserOwn = (count: number | undefined): string | undefined =>
      count != null ? ` · ${count} publication${count === 1 ? "" : "s"}` : undefined;
    switch (evidence.kind) {
      case "method":
        return (
          <LesserReason
            label="Method"
            suffix={lesserOwn(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className={`font-[450] text-[var(--evidence-anchor)] ${ENTITY_UNDERLINE}`}>{evidence.family}</span>
          </LesserReason>
        );
      case "topic":
        return (
          <LesserReason
            label="Research area"
            suffix={lesserOwn(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            <span className={`font-[450] text-[var(--evidence-anchor)] ${ENTITY_UNDERLINE}`}>{evidence.label}</span>
          </LesserReason>
        );
      case "clinical":
        return (
          <LesserReason
            // Uniform fold rule — clinical is usually a SECONDARY, so this is the row the
            // fold reveals and the one the mockup pills. The prose stays: "Board certified
            // in X" names the specialty the certification is IN, which the pill does not.
            // No `stacked` guard here, unlike the primary clinical lead: `tier="lesser"` is
            // only ever passed from the card's stacked branch, so this row cannot reach the
            // frozen single-evidence surface in the first place.
            label="Clinical"
            pill={evidence.boardCertified ? "credential" : undefined}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            {evidence.boardCertified ? (
              <>
                Board certified in{" "}
                <span className={`font-[450] text-[var(--evidence-anchor)] ${ENTITY_UNDERLINE}`}>{evidence.specialty}</span>
              </>
            ) : (
              <span className={`font-[450] text-[var(--evidence-anchor)] ${ENTITY_UNDERLINE}`}>{evidence.specialty}</span>
            )}
          </LesserReason>
        );
      case "publications": {
        const mention = evidence.strength === "mention";
        return (
          <LesserReason
            // #1913 — no dot. A mention's weakness is carried by `weak` (muted/italic
            // text) + the MentionNote, which is where it always actually lived.
            label={mention ? "Keyword" : "Concept"}
            weak={mention}
            suffix={lesserShare(evidence.count)}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={onToggle}
            panelId={panelId}
          >
            {evidence.term ? (
              <>
                <span
                  className={
                    mention
                      ? "font-[450] text-[var(--evidence-anchor)]"
                      : `font-[450] text-[var(--evidence-anchor)] ${ENTITY_UNDERLINE}`
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

  // #1366 follow-up Part B — the PRIMARY lead FAINTS when the match is thin. Two
  // independent thinness tests: the matched pubs are a tiny share of the scholar's output,
  // or the lead is a literal mention. Funding-promoted + identity-fallback primaries are
  // handled elsewhere / have no pub coverage, so they never dim. Scoped to the tiered
  // (`stacked`) context — the single-evidence path stays frozen (matches C/D).
  //
  // Uniform fold rule — the coupling is BROKEN. `dim` was `cue != null`, i.e. the tone
  // depended on a caveat STRING existing; the two thinness tests are unchanged but they
  // are now read directly. The cue string is fully retired: the percentage became an
  // always-on neutral column and "keyword only" became the amber provenance pill, so
  // nothing is left for a lead to append to its phrase.
  //
  // That also drops the old PRECEDENCE rule (keyword-only beat low-coverage so the two
  // never stacked, because only one string fitted the slot). There is no shared slot now,
  // so a keyword-only lead that is ALSO low-coverage shows both signals — the pill and the
  // percentage. Strictly more honest, which is why the rule disappears rather than ports.
  const primaryCount =
    evidence.kind === "method" ||
    evidence.kind === "topic" ||
    evidence.kind === "publications"
      ? evidence.count
      : undefined;
  // THE DENOMINATOR THIS LEAD'S SHARE IS ACTUALLY A SHARE OF. Everything but `method`
  // measures against `pubCount`, verbatim and unchanged. A method count is drawn from the
  // scholar's method-INDEXED publications (extraction is post-2020 by design), so it is
  // measured against `methodPubCount` — and when the server could not compute that union
  // exactly it is UNDEFINED, which silences the "of M" clause and the % column together.
  // The two must move as one: a % with no fraction beside it is the unaccountable number
  // #1907's lesson is about, and a fraction against a pool the numerator did not come from
  // is the bug this fixes. Never `methodPubCount ?? pubCount`.
  //
  // The `tier === "lesser"` block above already made this argument and acted on it: it
  // gives method/topic `lesserOwn` (a magnitude, "· 3 publications") instead of
  // `lesserShare`, on the grounds that those counts and `pubCount` are "two pipelines, one
  // frame". The PRIMARY row was the last place still framing them together — and the one
  // place a searcher actually reads. The lesser rows answered it by withholding the share;
  // the primary row can now state it, because there is a denominator the numerator came
  // from.
  //
  // …AND `topic` JOINS `method` IN WITHHOLDING ONE. Measured on staging 2026-07-29, all
  // 2,422 scholars with >= 20 authored publications: only 12,129 of 245,135 authored pmids
  // (4.9%) carry ANY `PublicationTopic` row, the median scholar carries ZERO, and 1,446 of
  // the 2,422 (59.7%) have none at all. `areaCounts` is a distinct-pub count over THAT pool;
  // `pubCount` is the whole career. Dividing one by the other understates the area share by
  // roughly 20x — the Chair of Genetic Medicine has 36 topic-assigned pmids of 924, so his
  // "21 of 923 = 2.3%" is really 21 of a 36-pub eligible pool, and 2.3% is one publication
  // from `COVERAGE_CUE_THRESHOLD` greying the line out as a thin match. The topic-eligible
  // pool is not the fix either: it is a THIRD denominator kind in a column whose contract
  // (stated below) is one kind for every cell. So the topic line states a magnitude and no
  // share — which is what the `tier === "lesser"` block above already decided for exactly
  // this count, on exactly this argument. The primary row was the last place still framing
  // an index-time topic count against the career total.
  const denominator =
    evidence.kind === "method"
      ? methodPubCount
      : evidence.kind === "topic"
        ? undefined
        : pubCount;
  const lowCoverage =
    primaryCount != null &&
    denominator != null &&
    denominator > 0 &&
    primaryCount / denominator < COVERAGE_CUE_THRESHOLD;
  const keywordOnly = evidence.kind === "publications" && evidence.strength === "mention";
  const dim = stacked && (keywordOnly || lowCoverage);
  // Uniform fold rule — ALWAYS ON wherever there is a count, not threshold-gated: it is a
  // stat ("8% of this scholar's output"), not a caveat, and withholding it on the leads we
  // judged healthy is what made it read as a verdict. No count ⇒ no column, which is what
  // silences clinical (a specialty has no pub denominator).
  //
  // The single-evidence path is silenced by the `stacked` gate ALONE, and that gate is not
  // redundant: `selectEvidence` does set `count` there (lib/api/result-evidence.ts — both
  // `count: input.pub.tagged.count` and `count: input.pub.mention.count`), so without the
  // gate the % column would render on the frozen surface. `method`, `topic` and `concept`
  // are the ones that arrive there without a count. Do not "simplify" the gate away.
  // …BUT A METHOD LINE PUTS NOTHING IN THIS COLUMN. The column is a FIXED cell in the
  // same position, size and typeface on every card, which makes it a CROSS-CARD
  // comparison device whether or not it was meant as one — a searcher scans it down the
  // page. That only works if every cell divides by the same KIND of denominator. Method's
  // is the method-indexed pool; every other kind's is `pubCount`. Measured on staging for
  // `gene therapy`: Crystal led Concept 140/923 = 15.2%, Kiss led Method 3/13 = 23.1%,
  // Kaplitt led Concept 34/151 = 22.5% — so the column announced that Kiss's THREE
  // publications beat Crystal's HUNDRED AND FORTY. Two pipelines, one frame, again.
  //
  // The share is not lost, it moves into the sentence, where the base is stated in words
  // ("3 of 13 eligible publications") and cannot be read off against a neighbour's
  // cell. Withholding the cell is the honest option because this column's own contract,
  // stated above, is "% of this scholar's OUTPUT" — which a method ratio is not.
  //
  // `lowCoverage` above deliberately KEEPS the method denominator: dimming asks "is this
  // lead thin?", which is a within-card judgement with no cross-card frame, and 3 of 13
  // method-indexed is genuinely not thin. Same number, two uses, only one of them safe.
  const coverage =
    stacked &&
    evidence.kind !== "method" &&
    primaryCount != null &&
    denominator != null &&
    denominator > 0
      ? coveragePct(primaryCount, denominator)
      : undefined;

  switch (evidence.kind) {
    case "method":
      return (
        <MatchAwareReason
          kind="method"
          coverage={coverage}
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {/* "eligible publications", not "publications": the M is the size of the pool
              method extraction actually covers (post-2020 by design), so calling it
              "publications" would put the scholar's whole career behind a number that is
              only a slice of it — the same over-claim in the opposite direction. When
              `methodPubCount` is absent `CountFirst` drops the "of M" clause and keeps the
              count, so the line reads "11 publications used AAV gene-therapy vectors" —
              "eligible" names the denominator it qualifies (#2155). */}
          <CountFirst
            n={evidence.count}
            m={methodPubCount}
            thing={methodPubCount != null ? "eligible publications" : "publications"}
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
          coverage={coverage}
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {/* No `m`: see `denominator` above. `areaCounts` counts pubs that got a topic
              assignment at all (4.9% of authored pmids), so "of {pubCount}" frames it
              against a pool 20x the one it came from. `CountFirst` drops the clause and
              keeps the count — "21 publications in Gene & Cell Therapy". */}
          <CountFirst
            n={evidence.count}
            thing="publications"
            relation="in"
            entity={evidence.label}
            underline
            dim={dim}
          />
        </MatchAwareReason>
      );
    case "clinical": {
      // The dotted underline (every kind but keyword) marks the specialty, and there is
      // still no coverage % column (a specialty has no `pubCount`-shaped denominator —
      // `evidence.eligiblePubCount` below is a DIFFERENT, MeSH-tag-eligible pool, not a
      // share of the scholar's whole output).
      // Uniform fold rule — the `credential` pill is `stacked`-gated like the % column and
      // the two publications pills, because it is the same kind of thing: a NEW element on
      // a surface we froze, not a relocation of one already there. `selectEvidence` does
      // emit `clinical.boardCertified` on the single-evidence path, so the gate is what
      // keeps it off. The prose is what carries the fact on both paths — "Board certified
      // in X" also names the specialty the certification is IN, which the pill does not.
      // (The "via" line below is the one addition that is NOT gated, and deliberately: it
      // is where the pre-existing "(matched …)" parenthetical MOVED to, so gating it would
      // delete a datum this surface used to show rather than withhold a new one.)
      //
      // #1367 Gap 1 — the on-topic pub count is a SEPARATE clause appended after the
      // specialty, reusing `CountFirst` (the same component the method branch above uses)
      // for consistent numeral styling rather than hand-formatting "N of M" a second way in
      // this file. `entity=""` because the specialty name is already rendered by the first
      // `CountFirst` call above; this second call exists only for its count-clause half.
      // "eligible" (not "publications" / "on-topic") is a deliberate word choice, matching
      // the wording a separate, unrelated PR (#2156, unmerged) independently settled on for
      // the analogous method-line denominator — so a searcher who sees both count clauses
      // learns ONE word for "the pool this count was drawn from", not two. Both `count` and
      // `eligiblePubCount` must be present (see `lib/api/search.ts` — the pair travels
      // together) or nothing renders: the label reads exactly as it did before this change,
      // never a fabricated 0.
      const hasCount = evidence.count != null && evidence.eligiblePubCount != null;
      return (
        <MatchAwareReason
          kind="clinical"
          pill={stacked && evidence.boardCertified ? "credential" : undefined}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {evidence.boardCertified ? <span className="text-[var(--evidence-body)]">Board certified in </span> : null}
          <CountFirst entity={evidence.specialty} underline />
          {hasCount ? (
            <span className="text-[var(--evidence-body)]">
              {" "}
              &middot;{" "}
              <CountFirst
                n={evidence.count}
                m={evidence.eligiblePubCount}
                thing="eligible publications"
                entity=""
                underline={false}
              />
            </span>
          ) : null}
        </MatchAwareReason>
      );
    }
    case "publications": {
      // §4.5 flavor: a MeSH-descriptor hit IS a concept (tagged/concept → "Concept"); a
      // literal mention → "Keyword". Count-first emphasis: bold the leading matched count
      // in the server phrase ("N of M publications tagged/mention"), keep the rest muted,
      // then the term. The dotted underline marks a system-resolved concept — a literal
      // keyword/mention term stays plain (semibold, no underline).
      const mention = evidence.strength === "mention";
      const anchor = dim
        ? "text-[var(--evidence-body)]"
        : "text-[var(--evidence-anchor)]";
      const muted = dim ? "text-[var(--evidence-faint)]" : "text-[var(--evidence-body)]";
      // This branch builds the count-first phrase itself instead of going through
      // `CountFirst`, so it has to carry the same accent rule by hand: the matched count
      // is the one accented datum, the term keeps `anchor`, and a dim lead takes none.
      const count = dim ? "text-[var(--evidence-body)]" : "text-[var(--evidence-accent)]";
      const lead = evidence.text.match(/^(\d[\d,]*)(\s[\s\S]*)$/);
      // Uniform fold rule — the pill is keyed to PROVENANCE, never to category, and only
      // the EXCEPTION is badged (see {@link EvidencePillKind}). `tagged` is the norm on
      // this row and gets none; `concept` gets none either, because a MeSH-expansion text
      // variant is neither a subject tag nor a bare keyword and claiming either would be
      // false. Only `mention` is badged. Gated on `stacked` (a new signal, scoped like
      // every other Part B addition).
      const pill: EvidencePillKind | undefined =
        stacked && evidence.strength === "mention" ? "keyword-only" : undefined;
      return (
        <MatchAwareReason
          kind={mention ? "keyword" : "concept"}
          coverage={coverage}
          pill={pill}
          // #1355 — the narrower descendant term(s) the scholar actually carries.
          // Uniform fold rule — PROMOTED out of the inline "(matched X · Y)" parenthetical
          // onto its own line under the phrase. That parenthetical was the string #1907/#1908
          // had to budget precisely BECAUSE it sat inside the truncating span; on its own line
          // it is no longer racing the phrase for the same pixels. Deliberately not
          // `stacked`-gated — this relocates an existing datum rather than adding a signal,
          // and leaving the parenthetical on the single-evidence path would keep a known clip
          // bug alive on one surface while fixing it on the other.
          // #1955 — the summary and the parent flag go over as ONE prop because the line's
          // wording depends on both; splitting them into sibling props would let a caller
          // ship the terms without the fact that words them. `alsoParent` absent (an older
          // response, or a producer that never set it) reads as false, which is the
          // narrower-route wording — the pre-#1955 string, and the majority case.
          via={
            evidence.descendantTerms && evidence.descendantTerms.length > 0
              ? {
                  terms: descendantViaSummary(evidence.descendantTerms),
                  alsoParent: evidence.alsoParent === true,
                }
              : undefined
          }
          dim={dim}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        >
          {lead ? (
            <>
              <span className={`font-semibold ${count}`}>{lead[1]}</span>
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
