"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { formatRoleCategory } from "@/lib/role-display";
import { profilePath } from "@/lib/profile-url";
import {
  MatchReason,
  MatchAwareReason,
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

  // #1366 — shared across this card's stacked evidence lines for exemplar de-dup
  // (representative papers stay globally disjoint though counts may overlap). A
  // single-evidence card gets a fresh empty set ⇒ behaves exactly as before.
  const claimedPmids = useRef(new Set<string>());

  // Funding evidence row (SEARCH_EVIDENCE_ROWS) — a scholar's TOPIC-matching grants.
  // Eager per-card fetch, gated on flag + active query + the scholar having ANY grant
  // (`grantCount`, already on the hit). The row is presence-gated (hide-when-empty,
  // §4.1/§5), so the match count must be known before render — not on expand. Records
  // are loaded here too, so expanding is instant. Flag-off / no-query / no-grants ⇒
  // no fetch. ponytail: per-card fetch reuses searchFunding; if the fan-out bites,
  // hoist presence to one funding terms-agg on the people path (see the /grants route).
  const [grants, setGrants] = useState<EvidenceGrant[]>([]);
  const [grantsTotal, setGrantsTotal] = useState(0);
  // #1359 — row reason strength from the route: "tagged" (concept axis) vs "mention"
  // (literal text). Server-derived (only it knows which grants are concept-tagged);
  // defaults "mention" so the flag-off / text-only payload reads exactly as before.
  const [grantsStrength, setGrantsStrength] = useState<"tagged" | "mention">("mention");
  const [fundingExpanded, setFundingExpanded] = useState(false);
  const fundingPanelId = useId();

  const qParam = (q ?? "").trim();

  // #1359 — the page-resolved concept (same source the key-paper fetch uses), threaded
  // so grants can match by concept tag. Empty for a free-text query ⇒ route stays
  // text-only. The server flag (SEARCH_FUNDING_CONCEPT_GRANTS) decides whether to act
  // on these, so passing them when off is harmless.
  const grantDescriptorUis = keyPaperConfig?.descriptorUis.join(",") ?? "";
  const grantConceptLabel = keyPaperConfig?.conceptLabel ?? "";

  useEffect(() => {
    if (!evidenceRows || !qParam || hit.grantCount <= 0) {
      // Card instances are keyed by cwid and persist across navigations, so a
      // query→browse transition (qParam → "") on a card that previously loaded
      // grants must DROP the now-stale row, not leave it rendering an old query's
      // grants. Functional reset avoids re-render churn when already empty.
      setGrants((prev) => (prev.length ? [] : prev));
      setGrantsTotal(0);
      setGrantsStrength("mention");
      return;
    }
    let alive = true;
    const params = new URLSearchParams({ q: qParam });
    if (grantDescriptorUis) {
      params.set("descriptorUis", grantDescriptorUis);
      params.set("label", grantConceptLabel);
    }
    fetch(`/api/scholar/${encodeURIComponent(hit.cwid)}/grants?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { grants: [], total: 0 }))
      .then((d: { grants?: EvidenceGrant[]; total?: number; strength?: "tagged" | "mention" }) => {
        if (!alive) return;
        setGrants(d?.grants ?? []);
        setGrantsTotal(d?.total ?? 0);
        setGrantsStrength(d?.strength ?? "mention");
      })
      .catch(() => {
        if (!alive) return;
        setGrants([]);
        setGrantsTotal(0);
        setGrantsStrength("mention");
      });
    return () => {
      alive = false;
    };
  }, [evidenceRows, qParam, hit.cwid, hit.grantCount, grantDescriptorUis, grantConceptLabel]);

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
          <MatchAwareReason kind="method" label={reason.family} />
        ) : (
          <MatchAwareReason kind="topic" label={reason.label} />
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
  const promoteFunding = grants.length > 0 && primaryIsIdentityFallback;

  // Stretched-link card (rep-papers disclosure): the row is a `<div>` and the
  // NAME is the profile `<Link>` whose `after:absolute inset-0` overlay makes the
  // WHOLE card clickable (whole-card navigation preserved). The chevron button +
  // `+N more` link sit ABOVE that overlay with `relative z-10`, so a disclosure
  // click never navigates. The analytics beacon rides the name link.
  const profileHref = `${profilePath(hit.slug)}#publications`;

  // #1366 follow-up — Funding rendered ONCE in the slot its tier dictates: the full
  // badge when it leads (promoted, or the legacy non-tiered path), else a compact
  // "Also matched" dot row. Same KeyFunding panel + expand state across tiers. #1359 —
  // concept-tagged grants read "tagged <Concept>" (filled dot / underline); a literal
  // text match reads "mention '<query>'" (hollow dot / honesty note).
  const fundingTagged = grantsStrength === "tagged" && grantConceptLabel.length > 0;
  // Full badge unless we're in the tiered (stacked) context and funding isn't promoted —
  // then it's a compact "Also matched" dot. The single-evidence / legacy paths (not
  // stacked) keep the full Funding row exactly as before.
  const fundingFull = promoteFunding || !stacked;
  const fundingCount = `${Math.min(grantsTotal, hit.grantCount)} of ${hit.grantCount} grants`;
  const fundingNode =
    grants.length > 0 ? (
      <>
        {fundingFull ? (
          <MatchAwareReason
            kind="funding"
            prefix={`${fundingCount} ${fundingTagged ? "tagged" : "mention"}`}
            label={fundingTagged ? grantConceptLabel : `“${qParam}”`}
            underline={fundingTagged}
            canExpand
            expanded={fundingExpanded}
            onToggle={() => setFundingExpanded((v) => !v)}
            panelId={fundingPanelId}
          />
        ) : (
          <LesserReason
            dotClassName={fundingTagged ? "bg-[#2f6b3a]" : "border-[1.5px] border-[#2f6b3a]"}
            weak={!fundingTagged}
            suffix={` · ${fundingCount}`}
            canExpand
            expanded={fundingExpanded}
            onToggle={() => setFundingExpanded((v) => !v)}
            panelId={fundingPanelId}
            srLabel="key funding"
          >
            <span className="font-medium text-[#52514a]">Funding</span> ·{" "}
            {fundingTagged ? <>tagged {grantConceptLabel}</> : <>mentions “{qParam}”</>}
          </LesserReason>
        )}
        {fundingExpanded ? (
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
                evidence={lines[0]}
                cwid={hit.cwid}
                slug={hit.slug}
                pubCount={hit.pubCount}
                q={q}
                keyPaperConfig={keyPaperConfig}
                hasQuery={hasQuery}
                badged={evidenceRows}
                claimedPmids={claimedPmids}
                tier="primary"
              />
            ) : (
              legacyBlock
            )}
            {/* "Also matched" — the demoted signals, under a dashed divider. Only the
                STACKED (`evidenceLines`) context tiers; shown when there is ≥1 lesser
                line or a (demoted) Funding row. */}
            {stacked && lines && (lines.length > 1 || grants.length > 0) ? (
              <div className="mt-3 border-t border-dashed border-[#e3e2dd] pt-2.5">
                <div className="mb-0.5 text-[11px] font-medium text-[#9a958a]">Also matched</div>
                {lines.slice(1).map((ev, i) => (
                  <EvidenceLine
                    key={i + 1}
                    evidence={ev}
                    cwid={hit.cwid}
                    slug={hit.slug}
                    pubCount={hit.pubCount}
                    q={q}
                    keyPaperConfig={keyPaperConfig}
                    hasQuery={hasQuery}
                    badged={evidenceRows}
                    claimedPmids={claimedPmids}
                    tier="lesser"
                  />
                ))}
                {grants.length > 0 ? fundingNode : null}
              </div>
            ) : null}
            {/* Non-stacked (single-evidence + legacy) keeps the full Funding row below
                the block, unchanged from before the tiered redesign. */}
            {!stacked && grants.length > 0 ? fundingNode : null}
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
