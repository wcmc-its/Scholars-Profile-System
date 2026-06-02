"use client";

import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { formatRoleCategory } from "@/lib/role-display";
import { profilePath } from "@/lib/profile-url";
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

// Inline match highlight rendered as bold text — never the post-it-yellow
// background style the mockup explicitly calls out as an anti-pattern.
//
// The OpenSearch query in lib/api/search.ts wraps matches in <mark>; this
// renderer rewrites them as <strong> with the design's typographic weight.
// (Issue #20 — earlier code split on <em> and let <mark> tags fall through
// as literal text.) The `overview` field can contain raw HTML (<p>, <br>,
// &nbsp;, &amp;, etc.) from the source bios; strip non-mark tags and
// decode the common named/numeric entities so they don't render as literal
// text in the snippet.
function stripHtmlTags(s: string): string {
  return s.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return s
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, n) => named[n.toLowerCase()] ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function HighlightedSnippet({ html }: { html: string }) {
  const cleaned = decodeEntities(stripHtmlTags(html));
  return (
    <>
      {cleaned.split(/(<mark>.*?<\/mark>)/g).map((part, i) =>
        part.startsWith("<mark>") ? (
          <strong key={i} className="font-semibold text-[#1a1a1a]">
            {part.replace(/<\/?mark>/g, "")}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// Issue #688 / #702 — "why this match" note for a MeSH attribution hit: the
// scholar surfaced because a publication is tagged with the searched concept
// itself (`concept`) or a *narrower* term than the one searched (`narrower`,
// e.g. "Microbiome" → Mycobiome). The query-keyed <mark> highlighter can't
// explain this (the typed term isn't necessarily in their text), so we spell it
// out. Quiet left-rule aside; "Why this match" uses the role-tag micro-label so
// the eye lands on the bolded term, not the boilerplate.
function MatchProvenanceNote({
  provenance,
}: {
  provenance: NonNullable<PeopleHit["matchProvenance"]>;
}) {
  return (
    <div className="mt-2 border-l-2 border-[#e3cfcf] pl-2.5 text-[13px] leading-snug text-[#4a4a4a]">
      <span className="mr-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#5f594d]">
        Why this match
      </span>
      {provenance.kind === "narrower" ? (
        <NarrowerTerms parentTerm={provenance.parentTerm} terms={provenance.descendantTerms} />
      ) : (
        <>
          publications tagged{" "}
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
  const extra = terms.length - shown.length;
  const plural = shown.length > 1 || extra > 0;
  return (
    <>
      {shown.map((term, i) => (
        <span key={i}>
          {i === 0 ? "" : i === shown.length - 1 ? " and " : ", "}
          <strong className="font-semibold text-[#1a1a1a]">{term}</strong>
        </span>
      ))}
      {extra > 0 ? <span> +{extra} more</span> : null}
      {` — ${plural ? "narrower terms" : "a narrower term"} of `}
      <span>&ldquo;{parentTerm}&rdquo;</span>.
    </>
  );
}

// Issue #702 — a match whose only highlightable evidence is in the scholar's
// publications (title / MeSH label text). Labeled so the snippet reads as their
// publications, not self-reported bio. Routes through the same #20 sanitizers.
function PubMatchSnippet({ html }: { html: string }) {
  return (
    <div className="mt-1 text-[13px] leading-snug text-[#4a4a4a]">
      <span className="mr-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#5f594d]">
        Matched in publications
      </span>
      <HighlightedSnippet html={html} />
    </div>
  );
}

const MATCH_FIELD_LABELS: Record<
  NonNullable<PeopleHit["matchedOnFields"]>[number],
  string
> = {
  name: "name",
  title: "title",
  department: "department",
  interests: "research interests",
  overview: "overview",
  publications: "publications",
};

function joinFields(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Issue #702 — last-resort "Matched on …" chip, rendered only when there is no
// snippet and no MeSH note, so a topically-relevant card is never fully bare.
// Derived from which highlight fields actually fired (publication/dept/title/…).
function MatchedOnChip({ fields }: { fields: NonNullable<PeopleHit["matchedOnFields"]> }) {
  return (
    <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
      <span className="mr-1.5 text-[9.5px] font-medium uppercase tracking-[0.05em] text-[#5f594d]">
        Matched on
      </span>
      {joinFields(fields.map((f) => MATCH_FIELD_LABELS[f]))}
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

  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.deptName ?? hit.primaryDepartment ?? ""}`.trim()
    : hit.deptName
      ? `Department of ${hit.deptName}`
      : hit.primaryDepartment ?? null;

  const roleLabel = hit.roleCategory ? formatRoleCategory(hit.roleCategory) : null;
  const snippet = hit.highlight && hit.highlight.length > 0 ? hit.highlight[0] : null;
  // Issue #702 — explainability precedence: self-reported snippet → "Matched in
  // publications" snippet → "Why this match" MeSH note → "Matched on" chip. The
  // pub snippet and chip are only ever populated when SEARCH_PEOPLE_MATCH_EXPLAIN
  // is on, so with the flag off this is byte-identical to the pre-#702 render.
  const pubSnippet =
    !snippet && hit.pubHighlight && hit.pubHighlight.length > 0 ? hit.pubHighlight[0] : null;
  const matchedOn = hit.matchedOnFields;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  return (
    <Link
      href={profilePath(hit.slug)}
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
          <div className="mb-2 text-xs text-muted-foreground">{deptLine}</div>
        ) : null}
        {snippet ? (
          <div className="text-[13px] leading-snug text-[#4a4a4a]">
            <HighlightedSnippet html={snippet} />
          </div>
        ) : pubSnippet ? (
          <PubMatchSnippet html={pubSnippet} />
        ) : null}
        {hit.matchProvenance ? (
          <MatchProvenanceNote provenance={hit.matchProvenance} />
        ) : null}
        {!snippet && !pubSnippet && !hit.matchProvenance && matchedOn && matchedOn.length > 0 ? (
          <MatchedOnChip fields={matchedOn} />
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
    </Link>
  );
}
