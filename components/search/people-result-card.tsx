"use client";

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { formatRoleCategory } from "@/lib/role-display";
import { profilePath } from "@/lib/profile-url";
import {
  MatchReason,
  MatchAwareReason,
  CountFirst,
  LesserReason,
  KeyFunding,
} from "@/components/search/match-reason";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import { EvidenceLine } from "@/components/search/evidence-line";
import type { EvidenceGrant, ResultEvidence } from "@/lib/api/result-evidence";
import type { ActivityFilter, PeopleHit } from "@/lib/api/search";

/**
 * Search-results person row (issue #8 sketch-002-revised).
 * 56px avatar | name + title + dept + snippet | right column with stats.
 *
 * Phase 6 / ANALYTICS-02 (D-04, D-06): onClick `navigator.sendBeacon` CTR
 * telemetry. Fire-and-forget — navigation is not blocked. The Blob wrapper
 * around JSON.stringify is required to set the right Content-Type for
 * the route handler's request.json() (see RESEARCH.md Pitfall 1).
 */
/**
 * Search reason-from-doc — the per-search config the card needs to lazily fetch
 * the evidence-path key papers on first expand. `descriptorUis` is the resolved
 * concept's subtree (empty for a free-text-only query); `contentQuery` drives the
 * `<mark>` highlight. Null/absent ⇒ no lazy key paper (legacy inline path serves
 * the key paper eagerly via the streamed wrapper instead).
 */
export type KeyPaperConfig = {
  descriptorUis: string[];
  contentQuery: string;
  /** #1351 — resolved concept name, so a tagged key paper's title highlights the
   *  concept term (not just the literal query). Empty for a free-text-only query. */
  conceptLabel?: string;
  /** MATCHA_GLOSS_INWORDS — the gloss's distinctive terms, so the key paper's title also marks the
   *  sponsor's own phrasing. Matcha-only: the public search ships no gloss, so it stays undefined
   *  there and the request is unchanged. Highlight-only — it never widens which papers are admitted. */
  glossTerms?: string;
};

export type PeopleResultCardProps = {
  hit: PeopleHit;
  position: number;
  q: string;
  total: number;
  filters: {
    deptDiv: string[];
    personType: string[];
    activity: ActivityFilter[];
  };
  keyPaperConfig?: KeyPaperConfig | null;
  /** SEARCH_EVIDENCE_ROWS (server-resolved) — gates the lazy Funding evidence row
   *  and the publications flavor badge. Off ⇒ no `/grants` fetch, no Funding row,
   *  and the pub reason row keeps its shipped muted treatment (byte-identical). */
  evidenceRows?: boolean;
};

/**
 * #1366 follow-up Part D collapse — the per-category label for the collapsed
 * "Also matched" summary. Keyed by the lesser row's kind (publications splits into
 * concept vs keyword by strength). No counts here on purpose (see the call site).
 *
 * #1913 — was a FILLED dot plus the label in that same hue. Six hues, each one
 * duplicating a word sitting 5px to its right, and the colours read as links while
 * nothing in the group is individually clickable. The labels now share the row's
 * neutral tone and separate with a middot.
 */
const SECONDARY_LABEL: Record<string, string> = {
  method: "Method",
  topic: "Research area",
  clinical: "Clinical",
  concept: "Concept",
  keyword: "Keyword",
  funding: "Funding",
};

/** Uniform fold rule — a folded secondary is now a LABEL plus a subordinate detail
 *  ("Research area · 11 pubs"), so the count can be muted against the label instead of
 *  competing with it. `detail` null ⇒ a bare label, which is what an absent count must
 *  render as: `count` is optional on method/topic/publications, and "Method · undefined
 *  pubs" has to be unreachable. */
type SecondaryChip = { label: string; detail: string | null };

/** Same pluralisation rule as the card's own right-hand stat column (`pubLabel` /
 *  `grantLabel`), deliberately — the two numbers on one card must never disagree about
 *  grammar. */
const unit = (n: number | undefined, word: "pub" | "grant"): string | null =>
  n == null ? null : `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Smaller, lower-contrast version of the role tag — the previous variant
 * competed visually with the title underneath at the same line. Loses the
 * border, drops the background, and shrinks the type so the eye reads
 * name → title → role-affiliation in that order.
 */
function RoleTag({ role }: { role: string }) {
  return (
    <span className="ml-2 inline-flex h-[16px] items-center rounded-sm bg-[#f0eeea] px-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#5f594d]">
      {role}
    </span>
  );
}

// `HighlightedSnippet` (the <mark>→<strong> rewriter + HTML strip / entity
// decode, issue #20) now lives in `components/search/highlight-snippet.tsx`,
// shared with the `<ResultEvidence>` renderer.

// #824 follow-up — the humanized research-areas fallback (mockup ROW 5). Clean,
// comma-separated area LABELS (no under_scores; the matched area, if any, bold as
// a WHOLE label). Replaces today's raw `areas_of_interest` slug dump with
// mid-word bolding. Server already humanized the slugs (real Topic.label when
// known, else a sentence-cased slug) — this is pure presentation. LEGACY: used
// only on the pre-ResultEvidence path (`SEARCH_RESULT_EVIDENCE` off).
function HumanizedAreas({
  labels,
  matchedIndex,
}: {
  labels: string[];
  matchedIndex: number;
}) {
  return (
    <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
      {labels.map((label, i) => (
        <span key={`${label}-${i}`}>
          {i > 0 ? ", " : ""}
          {i === matchedIndex ? (
            <strong className="font-medium text-[#111]">{label}</strong>
          ) : (
            label
          )}
        </span>
      ))}
    </div>
  );
}

export function PeopleResultCard({
  hit,
  position,
  q,
  total,
  filters,
  keyPaperConfig = null,
  evidenceRows = false,
}: PeopleResultCardProps) {
  function handleClick() {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const payload = {
      event: "search_click",
      q,
      position,
      cwid: hit.cwid,
      resultType: "people",
      resultCount: total,
      filters,
      ts: Date.now(),
    };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }

  // #1366 follow-up Part D collapse — the "Also matched" group is collapsed to a
  // category summary line by default (expandable). Only used when ≥2 secondaries.
  const [alsoExpanded, setAlsoExpanded] = useState(false);
  const alsoPanelId = useId();

  // Funding evidence row (SEARCH_EVIDENCE_ROWS) — a scholar's TOPIC-matching grants.
  // #1412 — counts are EAGER, precomputed once per page by a single funding agg
  // (`grantMatchCount`/`grantMatchTaggedCount` on the hit) that replaced the old per-card
  // /grants fan-out. The row is presence-gated (hide-when-empty, §4.1/§5) on the eager
  // count, so it renders immediately with no mount fetch.
  //
  // #1732 — THE MATCHED SET IS MIXED, AND THE LINE MUST SAY SO. The funding query is an
  // OR (literal text OR concept tag), so `grantsTotal` counts both kinds. It therefore
  // cannot be captioned "tagged <Concept>" — that claims a tag for grants that merely
  // mention the query. This previously rendered "5 of 24 grants tagged Immunoconjugates"
  // for a scholar with ONE tagged grant, two PROSTATE awards outranking it.
  //
  // These two PARTITION `grantsTotal` and are rendered as separate clauses that add up.
  const grantsTotal = hit.grantMatchCount ?? 0;
  const grantsTagged = hit.grantMatchTaggedCount ?? 0;
  const grantsMentionOnly = Math.max(0, grantsTotal - grantsTagged);
  const hasFunding = grantsTotal > 0;
  // The top-N record LIST stays lazy — fetched from /grants only when the disclosure
  // opens (see the records effect below), so a page of grant-heavy PIs fires 0 grant
  // calls on nav instead of one per card.
  const [grants, setGrants] = useState<EvidenceGrant[]>([]);
  const grantsFetchedRef = useRef(false);
  const [fundingExpanded, setFundingExpanded] = useState(false);
  const fundingPanelId = useId();

  const qParam = (q ?? "").trim();

  // #1366 evidence-line-stale-cache — shared across this card's stacked evidence
  // lines for exemplar de-dup (representative papers stay globally disjoint
  // though counts may overlap). Result cards are keyed by cwid (see the search
  // page's `<li key={h.cwid}>`) and PERSIST across client-side query
  // navigations, so this must be a FRESH empty set per query: `useMemo` on
  // `qParam` mints a new Set during render (pure — unlike clearing a ref's
  // contents, which persists across React's discarded/StrictMode renders),
  // ready before the qParam-keyed EvidenceLine children re-claim into it. A
  // single-evidence card still gets an empty set ⇒ behaves exactly as before.
  // qParam is the intended "recreate on query change" key even though the
  // factory doesn't read it — this is useMemo-as-reset, not a computed value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const claimedPmids = useMemo(() => new Set<string>(), [qParam]);

  // #1366 evidence-line-stale-cache — each EvidenceLine's reset key. Baking
  // qParam into the key remounts the line on a query change, dropping its
  // one-shot exemplar/key-paper fetch guards + expand/exemplar state (which
  // would otherwise render the PREVIOUS query's papers). kind + its identity
  // field keep a card's sibling lines distinct within one query
  // (selectEvidenceLines emits at most one line per kind/discriminant).
  const lineKey = (ev: ResultEvidence, idx: number) =>
    `${qParam}:${ev.kind}:${
      ev.kind === "topic"
        ? ev.id
        : ev.kind === "method"
          ? ev.family
          : ev.kind === "publications"
            ? ev.strength
            : idx
    }`;

  // #1359 — the page-resolved concept (same source the key-paper fetch uses), threaded
  // so grants can match by concept tag. Empty for a free-text query ⇒ route stays
  // text-only. The server flag (SEARCH_FUNDING_CONCEPT_GRANTS) decides whether to act
  // on these, so passing them when off is harmless.
  const grantDescriptorUis = keyPaperConfig?.descriptorUis.join(",") ?? "";
  const grantConceptLabel = keyPaperConfig?.conceptLabel ?? "";

  // #1412 — cards are keyed by cwid and persist across query navigations, so drop a
  // prior query's lazily-loaded records (and re-arm the one-shot fetch guard) whenever
  // the query changes. The eager count/strength come off the hit, so they refresh with
  // the server response automatically — only the on-expand record list needs resetting.
  useEffect(() => {
    grantsFetchedRef.current = false;
    setGrants((prev) => (prev.length ? [] : prev));
  }, [qParam]);

  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.deptName ?? hit.primaryDepartment ?? ""}`.trim()
    : hit.deptName
      ? `Department of ${hit.deptName}`
      : hit.primaryDepartment ?? null;

  const roleLabel = hit.roleCategory ? formatRoleCategory(hit.roleCategory) : null;
  const snippet = hit.highlight && hit.highlight.length > 0 ? hit.highlight[0] : null;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  // The honest-empty match line only makes sense when a query is being matched;
  // on the no-query Browse page the identity hints (areas/concepts) stand alone.
  const hasQuery = qParam.length > 0;

  // #1366 — the evidence reason block. STACKED lines (`evidenceLines`, flag on),
  // else the single `evidence` object, else the legacy priority chain. The first
  // two render through one or more `<EvidenceLine>` (each owns its disclosure +
  // exemplar fetch); they share `claimedPmids` so representative papers stay
  // globally disjoint across stacked lines.
  // #1366 follow-up — `stacked` = the multi-line `evidenceLines` context (the flag on).
  // The PRIMARY / "Also matched" tiering is scoped to it; the single-`evidence` path
  // (the older, separately-flagged rendering) keeps its current single block + full
  // Funding row, so merging this doesn't restyle that surface where the flag is off.
  const stacked = !!(hit.evidenceLines && hit.evidenceLines.length > 0);
  const lines: ResultEvidence[] | undefined = stacked
    ? hit.evidenceLines
    : hit.evidence
      ? [hit.evidence]
      : undefined;

  // #1366 follow-up Part D — the "Also matched" group = the demoted stacked lines
  // (everything after the primary) plus the (demoted) Funding row. `singleSecondary`
  // (exactly one) still collapses under "Also matched" (#1381 follow-up), but the
  // umbrella toggle then expands straight to that secondary's records — one click.
  const lesserLines = lines ? lines.slice(1) : [];
  const secondaryCount = lesserLines.length + (hasFunding ? 1 : 0);
  const singleSecondary = secondaryCount === 1;

  // LEGACY priority chain — rendered ONLY when there are no stacked/single `lines`
  // (SEARCH_RESULT_EVIDENCE off). The `lines` path renders inline below with the
  // primary / "Also matched" tiering (#1366 follow-up, handoff Part 1).
  let legacyBlock: ReactNode = null;
  if (!lines) {
    // method > topic > (legacy concept/pub matchReason) > bio highlight > humanized
    // research areas. The method/topic kinds + humanized areas are produced by the
    // server only when SEARCH_PEOPLE_MATCH_AWARE_SNIPPET is on; off ⇒ legacy
    // `{ icon, text }` reason (or absent), rendering today's snippet exactly.
    const reason = hit.matchReason;
    if (reason && "kind" in reason) {
      // New match-aware badge reasons (method / topic).
      legacyBlock =
        reason.kind === "method" ? (
          <MatchAwareReason kind="method">
            <CountFirst entity={reason.family} underline />
          </MatchAwareReason>
        ) : (
          <MatchAwareReason kind="topic">
            <CountFirst entity={reason.label} underline />
          </MatchAwareReason>
        );
    } else if (reason) {
      // Legacy PLAN R4 (#688/#702/#967) pub-evidence / concept reason.
      legacyBlock = (
        <MatchReason kind={reason.icon}>
          {reason.text}
          {/* #967 — concrete proof behind the count: a representative matching
              publication. The title is <mark>-highlighted when the literal query
              appears in it, otherwise rendered plain. */}
          {reason.pub ? (
            <>
              {" — incl. "}
              <span className="italic">
                &ldquo;
                {reason.pub.titleHtml ? (
                  <HighlightedSnippet html={reason.pub.titleHtml} />
                ) : (
                  reason.pub.title
                )}
                &rdquo;
              </span>
              {reason.pub.year ? ` (${reason.pub.year})` : ""}
            </>
          ) : null}
        </MatchReason>
      );
    } else if (snippet) {
      // Self-evident bio/overview/areas highlight from a self-reported field.
      legacyBlock = (
        <div className="text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={snippet} />
        </div>
      );
    } else if (hit.humanizedAreas && hit.humanizedAreas.labels.length > 0) {
      // #824 follow-up — last-resort humanized research areas (no under_scores),
      // replacing today's raw slug dump. Only present when the flag is on.
      legacyBlock = (
        <HumanizedAreas
          labels={hit.humanizedAreas.labels}
          matchedIndex={hit.humanizedAreas.matchedIndex}
        />
      );
    }
  }

  // When a topic-matching grant IS the query match, drop the generic NO-MATCH
  // identity fallback (`concepts`/`areas`/`none`: the "— no specific match —" line +
  // the scholar's top-MeSH chips, which are who-is-this context, NOT query-specific —
  // e.g. infectious-disease chips on a "children's health" search). The Funding row
  // below is the honest, query-specific reason and would otherwise sit under a
  // contradictory "no specific match". Real matches (publications/method/clinical/
  // topic) are NOT suppressed — they coexist with the Funding row. In the stacked
  // path an identity kind is ONLY ever the sole fallback element (selectEvidenceLines
  // returns it alone), so a one-element list is the analogue of the single evidence.
  const fallbackEvidence: ResultEvidence | undefined =
    lines && lines.length === 1 ? lines[0] : undefined;
  const primaryIsIdentityFallback =
    fallbackEvidence != null &&
    (fallbackEvidence.kind === "concepts" ||
      fallbackEvidence.kind === "areas" ||
      fallbackEvidence.kind === "none");
  // #1366 follow-up — funding PROMOTES to the prominent primary slot ONLY when there
  // is no first-class pub evidence line (the strongest line is an identity fallback).
  // The branch data has no comparable cross-signal strength score, so "funding is the
  // strongest signal" is exactly this structural condition — a concept-tagged grant
  // does NOT preempt a real pub line (which would also jank, since grant strength
  // loads async). ponytail: structural promotion, known synchronously on first paint;
  // swap in a normalized relevance weight if/when one exists across pub + funding.
  const promoteFunding = hasFunding && primaryIsIdentityFallback;

  // Stretched-link card (rep-papers disclosure): the row is a `<div>` and the
  // NAME is the profile `<Link>` whose `after:absolute inset-0` overlay makes the
  // WHOLE card clickable (whole-card navigation preserved). The chevron button +
  // `+N more` link sit ABOVE that overlay with `relative z-10`, so a disclosure
  // click never navigates. The analytics beacon rides the name link.
  const profileHref = `${profilePath(hit.slug)}#publications`;

  // #1366 follow-up — Funding rendered ONCE in the slot its tier dictates: the full
  // badge when it leads (promoted, or the legacy non-tiered path), else a compact
  // "Also matched" dot row. Same KeyFunding panel + expand state across tiers. #1359 —
  // concept-tagged grants read "tagged <Concept>" (underlined term); a literal text
  // match reads "mention '<query>'" (the honesty note). The dot is always FILLED green
  // (Part C); strength is carried by the muted/italic text, not the dot fill.
  const fundingTagged = grantsTagged > 0 && grantConceptLabel.length > 0;
  // Full badge unless we're in the tiered (stacked) context and funding isn't promoted —
  // then it's a compact "Also matched" dot. The single-evidence / legacy paths (not
  // stacked) keep the full Funding row exactly as before.
  const fundingFull = promoteFunding || !stacked;
  // #1732 — the LEAD number is whatever the lead relation actually counts: the tagged
  // count under "tagged <Concept>", the OR total under "mention". `fundingMentionSuffix`
  // carries the remainder, so a mixed set states both and they sum to `grantsTotal`.
  // Both degenerate to today's exact strings when the set is all-tagged or all-mention.
  const fundingLead = fundingTagged ? grantsTagged : grantsTotal;
  const fundingCount = `${Math.min(fundingLead, hit.grantCount)} of ${hit.grantCount} grants`;
  // "· 7 mention “<q>”" read as a second, parallel claim, so a reader summed it with the
  // lead and got a universe that looked double-counted. It is a REMAINDER —
  // `grantsMentionOnly` is `grantsTotal - grantsTagged` — so "more" says so in the one
  // place the reader is doing the arithmetic, and "in text" names what the other axis
  // matched on without re-quoting a query already quoted in the clause before it.
  const fundingMentionSuffix =
    fundingTagged && grantsMentionOnly > 0 ? `${grantsMentionOnly} more mention it in text` : null;
  // #1381 follow-up — a lone demoted Funding secondary is the sole "Also matched" row:
  // the umbrella toggle is its only control (no inner chevron) and the grant records
  // render as soon as the group expands, so one click reveals funding.
  const fundingLoneDemoted = !fundingFull && singleSecondary;

  // #1412 — lazy records: fetch this scholar's top-N matching grants from /grants ONLY
  // when the Funding disclosure is actually OPEN. The control differs by tier: the full
  // badge has its own chevron (`fundingExpanded`); a demoted row lives behind the "Also
  // matched" umbrella (`alsoExpanded`), and when it's the lone secondary the umbrella IS
  // its only control. Gating on the structural `fundingLoneDemoted` alone would fetch on
  // mount — the whole point was to STOP the per-card fan-out — so the umbrella state is
  // required. Fires once per query (reset on qParam change above); the summary already
  // rendered from the eager count, so this only fills the record list.
  const fundingRecordsOpen =
    hasFunding &&
    (fundingFull ? fundingExpanded : alsoExpanded && (fundingLoneDemoted || fundingExpanded));
  useEffect(() => {
    if (!fundingRecordsOpen || grantsFetchedRef.current || !qParam) return;
    grantsFetchedRef.current = true;
    let alive = true;
    const params = new URLSearchParams({ q: qParam });
    if (grantDescriptorUis) {
      params.set("descriptorUis", grantDescriptorUis);
      params.set("label", grantConceptLabel);
    }
    fetch(`/api/scholar/${encodeURIComponent(hit.cwid)}/grants?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { grants: [] }))
      .then((d: { grants?: EvidenceGrant[] }) => {
        if (alive) setGrants(d?.grants ?? []);
      })
      .catch(() => {
        if (alive) setGrants([]);
      });
    return () => {
      alive = false;
    };
  }, [fundingRecordsOpen, qParam, hit.cwid, grantDescriptorUis, grantConceptLabel]);

  const fundingNode =
    hasFunding ? (
      <>
        {fundingFull ? (
          <MatchAwareReason
            kind="funding"
            canExpand
            expanded={fundingExpanded}
            onToggle={() => setFundingExpanded((v) => !v)}
            panelId={fundingPanelId}
          >
            <CountFirst
              n={Math.min(fundingLead, hit.grantCount)}
              m={hit.grantCount}
              thing="grants"
              relation={fundingTagged ? "tagged" : "mention"}
              entity={fundingTagged ? grantConceptLabel : `“${qParam}”`}
              underline={fundingTagged}
            />
            {/* #1732 — the mention-only remainder. Without it the tagged count would
                silently drop the other matched grants, and the row's number would no
                longer account for the records the disclosure lists. */}
            {fundingMentionSuffix ? (
              <span className="text-[var(--evidence-faint)]"> · {fundingMentionSuffix}</span>
            ) : null}
          </MatchAwareReason>
        ) : (
          <LesserReason
            // #1913 — no dot. A literal mention's weakness is carried by `weak`
            // (muted/italic text) + the MentionNote.
            weak={!fundingTagged}
            // No `suffix` — the count is NOT a tail here. Trailing it left the row reading
            // "Funding · tagged Ischemic Stroke · 7 more … · 8 of 25 grants", where the
            // first clause dangles unquantified until the last one arrives and the reader
            // retrofits it. Count first, like the promoted row's `CountFirst`, so the
            // clauses read left to right in one pass.
            // Lone demoted secondary → no inner chevron; the "Also matched" umbrella is
            // the sole control and the records show on its one click.
            canExpand={!fundingLoneDemoted}
            expanded={fundingLoneDemoted ? true : fundingExpanded}
            onToggle={fundingLoneDemoted ? undefined : () => setFundingExpanded((v) => !v)}
            panelId={fundingPanelId}
            srLabel="key funding"
          >
            <span className="font-medium">Funding</span> · {fundingCount}{" "}
            {fundingTagged ? (
              <>
                tagged{" "}
                <span className="font-[450] text-[#3a3a3a] underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]">
                  {grantConceptLabel}
                </span>
                {/* #1732 — same partition on the compact row. */}
                {fundingMentionSuffix ? (
                  <span className="text-[var(--evidence-faint)]"> · {fundingMentionSuffix}</span>
                ) : null}
              </>
            ) : (
              <>mention “{qParam}”</>
            )}
          </LesserReason>
        )}
        {(fundingLoneDemoted || fundingExpanded) && grants.length > 0 ? (
          <KeyFunding
            grants={grants}
            total={grantsTotal}
            profileHref={profileHref}
            panelId={fundingPanelId}
            mentionNote={!fundingFull && !fundingTagged}
          />
        ) : null}
      </>
    ) : null;

  // #1366 follow-up Part D collapse — one chip per secondary, entities still hidden
  // (expanding reveals the full lesser rows).
  //
  // Uniform fold rule — the chips now CARRY THEIR COUNTS. The old note here said counts
  // were withheld because they mix denominators (pub-share vs grant-share) and a bare
  // count line would invert real strength. That reasoning is why the count is a muted tail
  // on a chip that names its own unit — "Research area · 11 pubs · Funding · 1 grant" —
  // rather than a run of naked numbers: every number states what it counts, so there is
  // nothing to mistake one denominator for.
  const secondaryChips: SecondaryChip[] = lesserLines
    .map<SecondaryChip | null>((ev) => {
      switch (ev.kind) {
        case "method":
          return { label: SECONDARY_LABEL.method, detail: unit(ev.count, "pub") };
        case "topic":
          return { label: SECONDARY_LABEL.topic, detail: unit(ev.count, "pub") };
        case "publications":
          return {
            label: SECONDARY_LABEL[ev.strength === "mention" ? "keyword" : "concept"],
            detail: unit(ev.count, "pub"),
          };
        case "clinical":
          return {
            label: SECONDARY_LABEL.clinical,
            detail: ev.boardCertified ? "board certified" : null,
          };
        default:
          // Identity kinds (concepts/areas/none) are always solo ⇒ never lesser.
          return null;
      }
    })
    .filter((c): c is SecondaryChip => c != null);
  if (hasFunding) {
    // A COLLAPSED COUNT MUST NEVER BE SMALLER THAN WHAT OPENING IT REVEALS. This chip
    // used `fundingLead` — the row's lead clause — to keep chip and row stating one
    // figure. But per #1732 that lead is one HALF of a partition (8 tagged), while the
    // panel behind the fold lists the whole matched set (8 tagged + 7 mention-only = 15),
    // so "Funding · 8 grants" promised 8 and delivered 15. The union is the only number
    // that describes the thing being summarised; the row underneath still breaks it into
    // its two clauses, which is where the partition belongs.
    secondaryChips.push({
      label: SECONDARY_LABEL.funding,
      detail: unit(Math.min(grantsTotal, hit.grantCount), "grant"),
    });
  }
  // ponytail: 3 chips fit one line at typical widths now that each carries a count
  // ("Research area" 13 chars → "Research area · 11 pubs" 23), which is the same property
  // the cap of 4 encoded for bare labels; more collapse to "+N". Realistic secondary
  // counts are 2–3 (`selectEvidenceLines` emits at most one line per kind, plus funding),
  // so this rarely bites. Bump it if cards routinely carry more.
  const shownChips = secondaryChips.slice(0, 3);
  const chipOverflow = secondaryChips.length - shownChips.length;

  // The demoted "Also matched" rows — the lesser stacked lines + the (demoted) Funding
  // row. Rendered bare for a lone secondary, or behind the collapse toggle for ≥2.
  const secondaryRows = (
    <>
      {lesserLines.map((ev, i) => (
        <EvidenceLine
          key={lineKey(ev, i + 1)}
          evidence={ev}
          cwid={hit.cwid}
          slug={hit.slug}
          pubCount={hit.pubCount}
          q={q}
          keyPaperConfig={keyPaperConfig}
          hasQuery={hasQuery}
          badged={evidenceRows}
          claimedPmids={claimedPmids}
          stacked={stacked}
          tier="lesser"
          // A lone lesser secondary mounts pre-expanded so the "Also matched" umbrella
          // reveals its records in one click (matches the lone-funding behavior).
          defaultExpanded={singleSecondary}
        />
      ))}
      {hasFunding ? fundingNode : null}
    </>
  );

  return (
    <div className="group relative grid grid-cols-[56px_1fr_auto] gap-4 border-b border-[#e3e2dd] py-5 hover:bg-[#fafaf8]">
      <HeadshotAvatar
        size="md"
        cwid={hit.cwid}
        preferredName={hit.preferredName}
        identityImageEndpoint={hit.identityImageEndpoint}
      />
      <div className="min-w-0">
        <div className="mb-[2px] flex flex-wrap items-baseline text-[16px] font-semibold leading-tight text-[#1a1a1a]">
          {/* The name IS the stretched profile link: `after:absolute inset-0`
              spans the whole card so clicking anywhere (outside a `z-10` control)
              navigates. The analytics beacon fires here. */}
          <Link
            href={profilePath(hit.slug)}
            onClick={handleClick}
            className="text-[#1a1a1a] no-underline after:absolute after:inset-0 after:content-[''] hover:text-[#2c4f6e] hover:no-underline"
          >
            {hit.preferredName}
          </Link>
          {roleLabel ? <RoleTag role={roleLabel} /> : null}
        </div>
        {hit.primaryTitle ? (
          <div className="mb-[2px] text-[13px] leading-snug text-[#4a4a4a]">
            {hit.primaryTitle}
          </div>
        ) : null}
        {deptLine ? (
          <div className="mb-2 text-xs text-muted-foreground">{deptLine}</div>
        ) : null}
        {/* #1366 follow-up — tiered evidence: ONE prominent primary signal + a compact
            "Also matched" group (the demoted lesser stacked lines + the Funding row).
            Funding LEADS instead when it's the strongest signal (promoted — no
            first-class pub line). The legacy (flag-off) path renders its single block
            plus the full Funding row below, unchanged. */}
        {promoteFunding ? (
          fundingNode
        ) : (
          <>
            {lines ? (
              <EvidenceLine
                key={lineKey(lines[0], 0)}
                evidence={lines[0]}
                cwid={hit.cwid}
                slug={hit.slug}
                pubCount={hit.pubCount}
                q={q}
                keyPaperConfig={keyPaperConfig}
                hasQuery={hasQuery}
                badged={evidenceRows}
                claimedPmids={claimedPmids}
                stacked={stacked}
                tier="primary"
              />
            ) : (
              legacyBlock
            )}
            {/* "Also matched" — the demoted signals collapsed under one summary line.
                Only the STACKED (`evidenceLines`) context tiers; shown when there is ≥1
                lesser line or a (demoted) Funding row. A single secondary collapses the
                same way (#1381 follow-up) and expands to its records in one click. */}
            {stacked && lines && secondaryCount >= 1 ? (
              // Balanced 10px above/below the dotted rule so it sits centered in the
              // gap between the primary row and the "Also matched" group (not hugging
              // the primary). Supersedes the #1381 tightening now that there's a rule.
              <div className="mt-[10px] border-t border-dotted border-[#d5d5d5] pt-[10px]">
                {/* Collapse hybrid — one summary line by default (colored dot + category
                    label per secondary, no counts / entities), expandable to the full
                    lesser rows. The far-right chevron (ml-auto) distinguishes this
                    umbrella toggle from the primary's content-width rep-papers chevron. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setAlsoExpanded((v) => !v);
                      }}
                      aria-expanded={alsoExpanded}
                      aria-controls={alsoExpanded ? alsoPanelId : undefined}
                      // #1910 — `cursor-pointer` is explicit: Tailwind v4's preflight
                      // sets `button { cursor: default }`, so without it this working
                      // disclosure (and its chevron) offered no affordance on hover.
                      // `DisclosureRow` opts back in the same way.
                      className="relative z-10 -mx-2 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-[3px] text-left hover:bg-[#f0eeea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2c4f6e] focus-visible:ring-offset-1"
                    >
                      <span className="shrink-0 text-[11px] font-medium text-[var(--evidence-body)]">
                        Also matched
                      </span>
                      {
                        // Uniform fold rule — WRAPS instead of overflowing. This row had no
                        // wrap and no truncate, so on a narrow card even the old bare chips
                        // pushed the chevron out of the row; wider chips make that likely
                        // rather than latent. Wrapping degrades to a second line (tight
                        // `gap-y`, not the 10px the shorthand would give) and never clips
                        // mid-chip, which is the #1907 disease.
                        //
                        // The summary stays on EXPAND, dimmed. It used to unmount, so the
                        // toggle collapsed to the bare words "Also matched" and the focus
                        // ring outlined a mostly empty bar — the click target changed shape
                        // under the pointer that had just hit it, and keyboard focus landed
                        // on the one state where the control says least about what it
                        // controls. Dimming keeps it a legend for the rows now underneath
                        // it rather than a second copy of them.
                        <span
                          className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-[2px] text-[12px] ${alsoExpanded ? "opacity-55" : ""}`}
                        >
                          {/* #1913 — labels neutral, middot-separated. The dot-plus-
                              same-hue-word pairing is gone, and so is the false link
                              affordance the coloured labels carried. */}
                          {shownChips.map((c, i) => (
                            <span key={i} className="inline-flex items-center gap-2.5">
                              {i > 0 ? (
                                <span aria-hidden className="text-[var(--evidence-faint)]">
                                  ·
                                </span>
                              ) : null}
                              <span>
                                <span className="font-medium text-[var(--evidence-body)]">
                                  {c.label}
                                </span>
                                {c.detail ? (
                                  <span className="text-[var(--evidence-faint)]">
                                    {" · "}
                                    {c.detail}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          ))}
                          {chipOverflow > 0 ? (
                            <span className="text-[var(--evidence-faint)]">+{chipOverflow}</span>
                          ) : null}
                        </span>
                      }
                      <ChevronDown
                        aria-hidden
                        strokeWidth={2.5}
                        className={`ml-auto mr-[3px] size-3.5 shrink-0 text-[var(--evidence-faint)] motion-safe:transition-transform motion-safe:duration-150 ${
                          alsoExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {alsoExpanded ? (
                      <div id={alsoPanelId} className="mt-1">
                        {secondaryRows}
                      </div>
                    ) : null}
              </div>
            ) : null}
            {/* Non-stacked (single-evidence + legacy) keeps the full Funding row below
                the block, unchanged from before the tiered redesign. */}
            {!stacked && hasFunding ? fundingNode : null}
          </>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 whitespace-nowrap text-right text-xs text-muted-foreground">
        {hit.pubCount > 0 ? (
          <span>
            <span className="text-[16px] font-semibold tabular-nums text-[#1a1a1a]">
              {hit.pubCount.toLocaleString()}
            </span>{" "}
            {pubLabel}
          </span>
        ) : null}
        {hit.grantCount > 0 ? (
          <span>
            <span className="text-[16px] font-semibold tabular-nums text-[#1a1a1a]">
              {hit.grantCount.toLocaleString()}
            </span>{" "}
            {grantLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
