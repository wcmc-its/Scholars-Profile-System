"use client";

import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { formatRoleCategory } from "@/lib/role-display";
import { profilePath } from "@/lib/profile-url";
import {
  MatchReason,
  MatchAwareReason,
  RepresentativePapers,
  type ExemplarFetchStatus,
} from "@/components/search/match-reason";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import { ResultEvidence } from "@/components/search/result-evidence";
import type { EvidencePub } from "@/lib/api/result-evidence";
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

  // Rep-papers disclosure — clickable, collapsed by default (replaces the #1060
  // hover reveal). State lives here; the chevron lives in the evidence row.
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  // method/topic kinds resolve their representative papers LAZILY (on the first
  // expand, not on hover) so the cacheable results derive stays untouched and the
  // lookup runs only for a row the viewer actually opens. The query string
  // selects which loader the (shared) route uses: `?family=` / `?topic=`.
  const exemplarQuery =
    hit.evidence?.kind === "method"
      ? `family=${encodeURIComponent(hit.evidence.family)}`
      : hit.evidence?.kind === "topic"
        ? `topic=${encodeURIComponent(hit.evidence.id)}`
        : null;
  const [exemplar, setExemplar] = useState<{ pubs: EvidencePub[]; total: number }>({
    pubs: [],
    total: 0,
  });
  const [exemplarStatus, setExemplarStatus] = useState<ExemplarFetchStatus>("idle");
  const exemplarFetched = useRef(false);

  const ensureExemplar = useCallback(() => {
    if (!exemplarQuery || exemplarFetched.current) return;
    exemplarFetched.current = true;
    setExemplarStatus("loading");
    fetch(`/api/scholar/${encodeURIComponent(hit.cwid)}/method-exemplar?${exemplarQuery}`)
      .then((r) => (r.ok ? r.json() : { pubs: [], total: 0 }))
      .then((d: { pubs: EvidencePub[]; total: number }) =>
        setExemplar({ pubs: d?.pubs ?? [], total: d?.total ?? 0 }),
      )
      .catch(() => setExemplar({ pubs: [], total: 0 }))
      .finally(() => setExemplarStatus("done"));
  }, [hit.cwid, exemplarQuery]);

  // publications kind: the representative papers are INLINE in the evidence
  // (`evidence.pubs`) — no fetch. method/topic: the lazily-fetched `exemplar`.
  const inlinePubs =
    hit.evidence?.kind === "publications" ? (hit.evidence.pubs ?? []) : null;
  const isLazyExemplar = !!exemplarQuery;
  const repPapers = inlinePubs ?? exemplar.pubs;
  const repTotal =
    inlinePubs != null
      ? (hit.evidence?.kind === "publications" ? hit.evidence.count : undefined) ??
        inlinePubs.length
      : exemplar.total;

  // A disclosure is offered when there is something to reveal. For inline pubs
  // that is `pubs.length > 0`. For a lazy method/topic exemplar it is optimistic
  // (`!!exemplarQuery`) until the fetch resolves; once it resolves with 0 papers
  // we drop the chevron so there is never a dead control.
  const canExpand =
    inlinePubs != null
      ? inlinePubs.length > 0
      : isLazyExemplar && !(exemplarStatus === "done" && exemplar.pubs.length === 0);

  const onToggle = useCallback(() => {
    if (isLazyExemplar) ensureExemplar();
    setExpanded((v) => !v);
  }, [isLazyExemplar, ensureExemplar]);

  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.deptName ?? hit.primaryDepartment ?? ""}`.trim()
    : hit.deptName
      ? `Department of ${hit.deptName}`
      : hit.primaryDepartment ?? null;

  const roleLabel = hit.roleCategory ? formatRoleCategory(hit.roleCategory) : null;
  const snippet = hit.highlight && hit.highlight.length > 0 ? hit.highlight[0] : null;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  // #824 follow-up Phase 1 — the coherent ResultEvidence model. When present
  // (`SEARCH_RESULT_EVIDENCE` on), the server already selected the ONE "why"
  // via one precedence function, so render it through one component and IGNORE
  // the legacy priority chain below. Absent ⇒ fall through to today's chain.
  // The disclosure props drive the clickable rep-papers chevron + panel.
  let snippetLine: ReactNode = null;
  if (hit.evidence) {
    snippetLine = (
      <ResultEvidence
        evidence={hit.evidence}
        canExpand={canExpand}
        expanded={expanded}
        onToggle={onToggle}
        panelId={panelId}
      />
    );
  } else {
    // LEGACY priority chain (pre-ResultEvidence): method > topic > (legacy
    // concept/pub matchReason) > bio highlight > humanized research areas. The
    // method/topic kinds + humanized areas are produced by the server only when
    // SEARCH_PEOPLE_MATCH_AWARE_SNIPPET is on; off ⇒ legacy `{ icon, text }`
    // reason (or absent) and no humanizedAreas, rendering today's snippet exactly.
    const reason = hit.matchReason;
    if (reason && "kind" in reason) {
      // New match-aware badge reasons (method / topic).
      snippetLine =
        reason.kind === "method" ? (
          <MatchAwareReason kind="method" label={reason.family} />
        ) : (
          <MatchAwareReason kind="topic" label={reason.label} />
        );
    } else if (reason) {
      // Legacy PLAN R4 (#688/#702/#967) pub-evidence / concept reason.
      snippetLine = (
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
      snippetLine = (
        <div className="text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={snippet} />
        </div>
      );
    } else if (hit.humanizedAreas && hit.humanizedAreas.labels.length > 0) {
      // #824 follow-up — last-resort humanized research areas (no under_scores),
      // replacing today's raw slug dump. Only present when the flag is on.
      snippetLine = (
        <HumanizedAreas
          labels={hit.humanizedAreas.labels}
          matchedIndex={hit.humanizedAreas.matchedIndex}
        />
      );
    }
  }

  // Stretched-link card (rep-papers disclosure): the row is a `<div>` and the
  // NAME is the profile `<Link>` whose `after:absolute inset-0` overlay makes the
  // WHOLE card clickable (whole-card navigation preserved). The chevron button +
  // `+N more` link sit ABOVE that overlay with `relative z-10`, so a disclosure
  // click never navigates. The analytics beacon rides the name link.
  const profileHref = `${profilePath(hit.slug)}#publications`;

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
        {/* #824 follow-up — one reason line per scholar: the ResultEvidence
            object when present, else the legacy priority chain. */}
        {snippetLine}
        {/* Rep-papers disclosure — the representative papers, shown when the row
            is expanded. Inline for the publications kind; lazily fetched for a
            method/topic match (the fetch is triggered on first toggle). */}
        {hit.evidence && expanded && canExpand ? (
          <RepresentativePapers
            papers={repPapers}
            total={repTotal}
            profileHref={profileHref}
            status={isLazyExemplar ? exemplarStatus : "done"}
            panelId={panelId}
          />
        ) : null}
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
