"use client";

import Link from "next/link";
import { Banknote } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { formatRoleCategory } from "@/lib/role-display";
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
    <span className="ml-2 inline-flex h-[16px] items-center rounded-sm bg-[#f0eeea] px-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#8a8377]">
      {role}
    </span>
  );
}

// Inline match highlight rendered as bold text — never the post-it-yellow
// background style the mockup explicitly calls out as an anti-pattern.
function HighlightedSnippet({ html }: { html: string }) {
  return (
    <>
      {html.split(/(<em>.*?<\/em>)/g).map((part, i) =>
        part.startsWith("<em>") ? (
          <strong key={i} className="font-semibold text-[#1a1a1a]">
            {part.replace(/<\/?em>/g, "")}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
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

  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.deptName ?? hit.primaryDepartment ?? ""}`.trim()
    : hit.deptName
      ? `Department of ${hit.deptName}`
      : hit.primaryDepartment ?? null;

  const roleLabel = hit.roleCategory ? formatRoleCategory(hit.roleCategory) : null;
  const snippet = hit.highlight && hit.highlight.length > 0 ? hit.highlight[0] : null;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  return (
    <Link
      href={`/scholars/${hit.slug}`}
      onClick={handleClick}
      className="grid grid-cols-[56px_1fr_auto] gap-4 border-b border-[#e3e2dd] py-5 no-underline hover:bg-[#fafaf8] hover:no-underline"
    >
      <HeadshotAvatar
        size="md"
        cwid={hit.cwid}
        preferredName={hit.preferredName}
        identityImageEndpoint={hit.identityImageEndpoint}
      />
      <div className="min-w-0">
        <div className="mb-[2px] flex flex-wrap items-baseline text-[16px] font-semibold leading-tight text-[#1a1a1a]">
          <span className="hover:text-[#2c4f6e]">{hit.preferredName}</span>
          {roleLabel ? <RoleTag role={roleLabel} /> : null}
        </div>
        {hit.primaryTitle ? (
          <div className="mb-[2px] text-[13px] leading-snug text-[#4a4a4a]">
            {hit.primaryTitle}
          </div>
        ) : null}
        {deptLine ? (
          <div className="mb-2 text-xs text-[#757575]">{deptLine}</div>
        ) : null}
        {snippet ? (
          <div className="text-[13px] leading-snug text-[#4a4a4a]">
            <HighlightedSnippet html={snippet} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-1 whitespace-nowrap text-right text-xs text-[#757575]">
        {hit.pubCount > 0 ? (
          <span>
            <span className="text-[16px] font-semibold tabular-nums text-[#1a1a1a]">
              {hit.pubCount.toLocaleString()}
            </span>{" "}
            {pubLabel}
          </span>
        ) : null}
        {hit.grantCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Banknote
              aria-hidden
              className="h-3 w-3 text-[#9aa19a]"
              strokeWidth={2}
            />
            <span>
              <span className="text-[16px] font-semibold tabular-nums text-[#1a1a1a]">
                {hit.grantCount.toLocaleString()}
              </span>{" "}
              {grantLabel}
            </span>
          </span>
        ) : null}
      </div>
    </Link>
  );
}
