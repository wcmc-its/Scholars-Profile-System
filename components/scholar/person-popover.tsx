"use client";

/**
 * <PersonPopover> — context-aware hover-card for any person reference across
 * the directory (#242).
 *
 * Wraps a chip / row / link as a hover trigger. On hover-intent (200 ms) the
 * card fetches per-cwid context from /api/scholars/[cwid]/popover-context,
 * branching by `surface` + the optional context props.
 *
 * Body composition (top → bottom):
 *   - Header (avatar + name + title + dept)
 *   - Optional role pill (pub-chip / co-author)
 *   - Optional contextual line (co-pubs count, topic rank, total counts)
 *   - Optional "recent pubs" list
 *   - Action buttons (primary + secondary)
 *
 * Self-hover guard: when `currentProfileCwid === cwid`, the contextual line
 * is suppressed and the primary action falls back to a quiet
 * "You're already on this profile" note.
 */
import * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { PersonCardHeader } from "@/components/scholar/person-card-header";
import { PersonCardStats } from "@/components/scholar/person-card-stats";
import {
  PersonCardRolePill,
  authorshipRoleFromFlags,
  type AuthorshipRole,
} from "@/components/scholar/person-card-role-pill";
import { GrantRolePill } from "@/components/scholar/person-card-grant-role-pill";
import { profilePath } from "@/lib/profile-url";
import { sanitizePubmedHtml } from "@/lib/utils";

export type PersonPopoverSurface =
  | "facet"
  | "pub-chip"
  | "co-author"
  | "mentee"
  | "top-scholar"
  | "grant-investigator"
  | "grant-facet";

type ApiResponse = {
  header: {
    cwid: string;
    preferredName: string;
    postnominal: string | null;
    primaryTitle: string | null;
    primaryDepartment: string | null;
    slug: string | null;
    identityImageEndpoint: string;
    totalPubCount: number;
    totalGrantCount: number;
    topTopic: string | null;
  };
  authorship: {
    isFirst: boolean;
    isLast: boolean;
    firstCount: number;
    lastCount: number;
  } | null;
  coPubs: {
    count: number;
    mostRecentYear: number | null;
    roleDistribution: { first: number; senior: number; coAuthor: number } | null;
  } | null;
  topicRank: {
    rank: number;
    topicPubCount: number;
    recent: Array<{ pmid: string; title: string; year: number | null }>;
  } | null;
  recentPubs: Array<{ pmid: string; title: string; year: number | null }>;
  recentGrants: Array<{
    id: string;
    title: string;
    sponsor: string | null;
    endYear: number;
  }>;
  topSponsor: string | null;
  /** #853 — the hovered scholar's most-prominent method families. Populated only
   *  for /methods top-scholar popovers (`contextMethods=1`) when METHODS_LENS_PAGES
   *  is on; `[]` everywhere else, so topic/pub/grant surfaces are unaffected. */
  methodFamilies: Array<{
    supercategory: string;
    familyLabel: string;
    familyId: string;
    pmidCount: number;
    href: string;
  }>;
};

export type PersonPopoverProps = {
  cwid: string;
  surface: PersonPopoverSurface;
  /** Wrap an existing chip / row / link as the hover trigger. */
  children: React.ReactElement;

  /** Drives "N co-pubs with X" + role-distribution lookups. */
  contextScholarCwid?: string;
  /** Drives the role pill on pub-chip / co-author surfaces. */
  contextPubPmid?: string;
  /** Drives the topic-rank + "Recent in topic" rows on top-scholar surface. */
  contextTopicSlug?: string;
  /** When the popover is on the same scholar's profile as the trigger, the
   *  bottom rows are suppressed and a "You're already on this profile" note
   *  replaces them. */
  currentProfileCwid?: string;
  /** Display name for the contextual scholar (used in "co-pubs with {name}"
   *  line and the "Filter by {LastName}" primary action). */
  contextScholarName?: string;
  /** Label for the context topic, used in the bottom row ("Recent in
   *  {topicLabel}"). Optional — falls back to the slug. */
  contextTopicLabel?: string;
  /** Pre-computed rank for the top-scholar surface. When provided, overrides
   *  the API's rank value so the popover matches the chip-row's D-13/D-14
   *  position (#264). The API still supplies topicPubCount and recent pubs;
   *  only the rank semantics change. */
  contextTopicRank?: number;
  /** Pre-known filter match count for the facet surface ("N pubs match
   *  filters"). When present, replaces the all-time total pub count line. */
  filterMatchCount?: number;
  /** Filter-aware top topic ("most in {topic}"). When the caller has the
   *  filter state, it can compute this; otherwise the all-time top topic
   *  from the header is used. */
  filterTopTopic?: string;
  /** Optional href for the primary action button (e.g. facet toggleHref). */
  primaryActionHref?: string;
  /** Optional label for the primary action; if omitted, derived from surface. */
  primaryActionLabel?: string;
  /** #853 — on /methods top-scholar chips, request the hovered scholar's
   *  "Prominent method families" section (adds `contextMethods=1` to the fetch).
   *  Topic/pub/grant surfaces never set this, so the section can't leak onto them;
   *  the server still re-checks `surface==="top-scholar"` + METHODS_LENS_PAGES. */
  contextMethods?: boolean;
  /** Grant context for the grant-investigator surface — drives the role pill
   *  and the "Funded …" line, and excludes the hovered grant from the recent
   *  list. All values are already on the FundingHit (no API round-trip). */
  contextGrant?: {
    projectId: string;
    role: string;
    startYear: number | null;
    endYear: number | null;
    isMultiPi: boolean;
  };
};

const ROLE_FROM_FLAGS = (
  isFirst: boolean,
  isLast: boolean,
  firstCount: number,
  lastCount: number,
): AuthorshipRole =>
  authorshipRoleFromFlags(isFirst, isLast, firstCount, lastCount);

export function PersonPopover({
  cwid,
  surface,
  children,
  contextScholarCwid,
  contextPubPmid,
  contextTopicSlug,
  currentProfileCwid,
  contextScholarName,
  contextTopicLabel,
  contextTopicRank,
  filterMatchCount,
  filterTopTopic,
  primaryActionHref,
  primaryActionLabel,
  contextMethods,
  contextGrant,
}: PersonPopoverProps) {
  const [data, setData] = React.useState<ApiResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const fetchedKeyRef = React.useRef<string | null>(null);

  const fetchKey = `${cwid}|${surface}|${contextScholarCwid ?? ""}|${contextPubPmid ?? ""}|${contextTopicSlug ?? ""}|${contextGrant?.projectId ?? ""}|${contextMethods ? "1" : ""}`;

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) {
        abortRef.current?.abort();
        return;
      }

      // Telemetry — fire-and-forget on open.
      try {
        navigator.sendBeacon?.(
          "/api/analytics",
          JSON.stringify({
            event: "person_popover_open",
            cwid,
            surface,
            contextScholarCwid,
            contextPubPmid,
            contextTopicSlug,
            contextGrantProjectId: contextGrant?.projectId,
            ts: Date.now(),
          }),
        );
      } catch {
        // Telemetry must never break the interaction.
      }

      // Skip re-fetch if the same key already resolved.
      if (data && fetchedKeyRef.current === fetchKey) return;

      const ctl = new AbortController();
      abortRef.current = ctl;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ surface });
      if (contextScholarCwid) params.set("contextScholarCwid", contextScholarCwid);
      if (contextPubPmid) params.set("contextPubPmid", contextPubPmid);
      if (contextTopicSlug) params.set("contextTopicSlug", contextTopicSlug);
      if (contextGrant?.projectId)
        params.set("contextGrantProjectId", contextGrant.projectId);
      if (contextMethods) params.set("contextMethods", "1");

      fetch(`/api/scholars/${cwid}/popover-context?${params.toString()}`, {
        signal: ctl.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          return (await r.json()) as ApiResponse;
        })
        .then((d) => {
          fetchedKeyRef.current = fetchKey;
          setData(d);
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setError(e instanceof Error ? e.message : "fetch error");
        })
        .finally(() => setLoading(false));
    },
    [
      cwid,
      surface,
      contextScholarCwid,
      contextPubPmid,
      contextTopicSlug,
      contextGrant?.projectId,
      contextMethods,
      fetchKey,
      data,
    ],
  );

  const isSelf = currentProfileCwid != null && currentProfileCwid === cwid;

  return (
    <HoverCard onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        side="bottom"
        avoidCollisions
        className="w-80 p-3.5"
        // Keyboard: Escape on the content closes the popover and Radix returns
        // focus to the trigger automatically.
      >
        {loading && !data ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : error && !data ? (
          <div className="text-xs text-muted-foreground">
            Could not load preview.
          </div>
        ) : !data ? null : (
          <PersonPopoverBody
            data={data}
            surface={surface}
            isSelf={isSelf}
            contextGrant={contextGrant}
            contextScholarName={contextScholarName}
            contextTopicLabel={contextTopicLabel}
            contextTopicRank={contextTopicRank}
            filterMatchCount={filterMatchCount}
            filterTopTopic={filterTopTopic}
            primaryActionHref={primaryActionHref}
            primaryActionLabel={primaryActionLabel}
          />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function PersonPopoverBody({
  data,
  surface,
  isSelf,
  contextGrant,
  contextScholarName,
  contextTopicLabel,
  contextTopicRank,
  filterMatchCount,
  filterTopTopic,
  primaryActionHref,
  primaryActionLabel,
}: {
  data: ApiResponse;
  surface: PersonPopoverSurface;
  isSelf: boolean;
  contextGrant?: PersonPopoverProps["contextGrant"];
  contextScholarName?: string;
  contextTopicLabel?: string;
  contextTopicRank?: number;
  filterMatchCount?: number;
  filterTopTopic?: string;
  primaryActionHref?: string;
  primaryActionLabel?: string;
}) {
  const { header } = data;
  const displayName = header.postnominal
    ? `${header.preferredName}, ${header.postnominal}`
    : header.preferredName;

  // Role pill — the authorship pill on pub-chip / co-author surfaces, the
  // grant role pill on grant-investigator.
  let rolePill: React.ReactNode = null;
  if (data.authorship && (surface === "pub-chip" || surface === "co-author")) {
    rolePill = (
      <PersonCardRolePill
        role={ROLE_FROM_FLAGS(
          data.authorship.isFirst,
          data.authorship.isLast,
          data.authorship.firstCount,
          data.authorship.lastCount,
        )}
        onPub
      />
    );
  } else if (surface === "grant-investigator" && contextGrant) {
    rolePill = (
      <GrantRolePill
        role={contextGrant.role}
        isMultiPi={contextGrant.isMultiPi}
        onGrant
      />
    );
  }

  // Bottom contextual line — surface-specific.
  const contextLine = isSelf ? (
    <SelfNote />
  ) : (
    <SurfaceContextLine
      surface={surface}
      data={data}
      contextGrant={contextGrant}
      contextScholarName={contextScholarName}
      contextTopicRank={contextTopicRank}
      filterMatchCount={filterMatchCount}
      filterTopTopic={filterTopTopic}
    />
  );

  // #853 — the hovered scholar's prominent method families (populated only for
  // /methods top-scholar popovers; `[]` on every other surface). Suppressed on
  // self-hover, matching the rest of the contextual body.
  const methodFamilies = isSelf ? [] : data.methodFamilies ?? [];
  const hasMethodFamilies = methodFamilies.length > 0;

  // Recent pubs list — varies by surface and self-hover state. When the
  // method-families section is showing, it replaces the generic recent-pubs list
  // so the /methods card stays focused (and not over-tall).
  const recentList =
    isSelf || hasMethodFamilies ? null : (
      <SurfaceRecentList
        surface={surface}
        data={data}
        contextTopicLabel={contextTopicLabel}
      />
    );

  // Actions row. View profile only when the scholar has an active slug; for
  // unlinked WCM authors (alumni) we drop "View profile" but keep any
  // context-aware primary action.
  const profileHref = header.slug ? profilePath(header.slug) : null;
  const primary = !isSelf
    ? derivePrimaryAction({
        surface,
        data,
        contextScholarName,
        primaryActionHref,
        primaryActionLabel,
        profileHref,
      })
    : null;
  const showViewProfile =
    profileHref !== null && (!primary || primary.href !== profileHref);

  return (
    <div className="space-y-0">
      <PersonCardHeader
        cwid={header.cwid}
        preferredName={displayName}
        primaryTitle={header.primaryTitle}
        primaryDepartment={header.primaryDepartment}
        identityImageEndpoint={header.identityImageEndpoint}
      />
      {rolePill}
      {contextLine}
      {hasMethodFamilies ? (
        <MethodFamiliesSection families={methodFamilies} />
      ) : null}
      {recentList}
      {(primary || showViewProfile) && (
        <div className="mt-3 flex gap-1.5">
          {primary ? (
            <ActionButton
              href={primary.href}
              variant="primary"
              eventName="person_popover_action"
              actionKey={primary.eventKey}
              cwid={header.cwid}
              surface={surface}
            >
              {primary.label}
            </ActionButton>
          ) : null}
          {showViewProfile ? (
            <ActionButton
              href={profileHref!}
              variant="secondary"
              eventName="person_popover_action"
              actionKey="view_profile"
              cwid={header.cwid}
              surface={surface}
            >
              View profile
            </ActionButton>
          ) : null}
        </div>
      )}
      {!primary &&
      !showViewProfile &&
      !contextLine &&
      !recentList &&
      !hasMethodFamilies ? (
        <PersonCardStats
          pubCount={header.totalPubCount}
          grantCount={header.totalGrantCount}
        />
      ) : null}
    </div>
  );
}

function SelfNote() {
  return (
    <div className="mt-3 border-t border-border pt-2.5 text-xs italic text-muted-foreground">
      You&apos;re already on this profile.
    </div>
  );
}

function SurfaceContextLine({
  surface,
  data,
  contextGrant,
  contextScholarName,
  contextTopicRank,
  filterMatchCount,
  filterTopTopic,
}: {
  surface: PersonPopoverSurface;
  data: ApiResponse;
  contextGrant?: PersonPopoverProps["contextGrant"];
  contextScholarName?: string;
  contextTopicRank?: number;
  filterMatchCount?: number;
  filterTopTopic?: string;
}) {
  const { header } = data;
  const topTopic = filterTopTopic ?? header.topTopic;

  if (surface === "facet") {
    const n = filterMatchCount;
    const m = header.totalPubCount;
    if (n == null && m === 0) return null;
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        {n != null ? (
          <>
            <strong className="font-semibold text-foreground">{n}</strong>
            {m > 0 ? (
              <>
                {" "}of <strong className="font-semibold text-foreground">{m}</strong> pubs match your filters
              </>
            ) : (
              <> pubs match your filters</>
            )}
          </>
        ) : (
          <>
            <strong className="font-semibold text-foreground">{m}</strong> pubs total
          </>
        )}
        {topTopic ? (
          <>
            {" · most in "}
            <strong className="font-semibold text-foreground">{topTopic}</strong>
          </>
        ) : null}
      </div>
    );
  }

  if (surface === "co-author" || surface === "mentee") {
    const cp = data.coPubs;
    if (!cp || cp.count === 0) {
      // Header stats fallback so the card isn't bare.
      return (
        <PersonCardStats
          pubCount={header.totalPubCount}
          grantCount={header.totalGrantCount}
        />
      );
    }
    const name = contextScholarName ?? "this scholar";
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        <strong className="font-semibold text-foreground">
          {cp.count} co-pub{cp.count === 1 ? "" : "s"}
        </strong>{" "}
        with {name}
        {cp.mostRecentYear ? ` · most recent ${cp.mostRecentYear}` : ""}
        {cp.roleDistribution ? (
          <RoleDistributionRow dist={cp.roleDistribution} />
        ) : null}
      </div>
    );
  }

  if (surface === "top-scholar") {
    const tr = data.topicRank;
    if (!tr) {
      return (
        <PersonCardStats
          pubCount={header.totalPubCount}
          grantCount={header.totalGrantCount}
        />
      );
    }
    // #264 — prefer the chip-row's D-13/D-14 rank (passed as
    // contextTopicRank) over the API's count-based rank so the rank line
    // here matches the chip's visual position. Fall back to tr.rank for
    // any future top-scholar surface that doesn't supply the prop.
    const displayRank = contextTopicRank ?? tr.rank;
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        Rank <strong className="font-semibold text-foreground">#{displayRank}</strong>{" "}
        in this research area ·{" "}
        <strong className="font-semibold text-foreground">{tr.topicPubCount} pubs</strong>{" "}
        tagged
      </div>
    );
  }

  if (surface === "grant-investigator") {
    if (!contextGrant) return null;
    const { startYear, endYear } = contextGrant;
    if (startYear == null && endYear == null) return null;
    const range =
      startYear != null && endYear != null
        ? `${startYear}–${endYear}`
        : `${startYear ?? endYear}`;
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        Funded <strong className="font-semibold text-foreground">{range}</strong>
      </div>
    );
  }

  if (surface === "grant-facet") {
    const n = filterMatchCount;
    const m = header.totalGrantCount;
    if (n == null && m === 0) return null;
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        {n != null ? (
          <>
            <strong className="font-semibold text-foreground">{n}</strong>
            {m > 0 ? (
              <>
                {" "}of <strong className="font-semibold text-foreground">{m}</strong> grants match your filters
              </>
            ) : (
              <> grants match your filters</>
            )}
          </>
        ) : (
          <>
            <strong className="font-semibold text-foreground">{m}</strong> grants total
          </>
        )}
        {data.topSponsor ? (
          <>
            {" · top in "}
            <strong className="font-semibold text-foreground">{data.topSponsor}</strong>
          </>
        ) : null}
      </div>
    );
  }

  // pub-chip: no contextual count line beyond the role pill (which is rendered above).
  return null;
}

function RoleDistributionRow({
  dist,
}: {
  dist: { first: number; senior: number; coAuthor: number };
}) {
  const items: Array<{ label: string; n: number; tone: "first" | "senior" | "neutral" }> = [];
  if (dist.first > 0) items.push({ label: "First author", n: dist.first, tone: "first" });
  if (dist.senior > 0) items.push({ label: "Senior author", n: dist.senior, tone: "senior" });
  if (dist.coAuthor > 0)
    items.push({ label: "Co-author", n: dist.coAuthor, tone: "neutral" });
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.label}
          className={`inline-flex items-center rounded-full border px-2 py-[1px] text-[10.5px] font-semibold ${
            it.tone === "first"
              ? "border-[var(--color-accent-slate)] bg-[rgba(44,79,110,0.06)] text-[var(--color-accent-slate)]"
              : it.tone === "senior"
                ? "border-amber-700/70 bg-amber-50 text-amber-900"
                : "border-border bg-muted text-muted-foreground"
          }`}
        >
          {it.label} × {it.n}
        </span>
      ))}
    </div>
  );
}

function SurfaceRecentList({
  surface,
  data,
  contextTopicLabel,
}: {
  surface: PersonPopoverSurface;
  data: ApiResponse;
  contextTopicLabel?: string;
}) {
  if (surface === "grant-investigator") {
    const grants = data.recentGrants;
    if (grants.length === 0) return null;
    return (
      <div className="mt-3 border-t border-border pt-2.5">
        <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Recent active grants
        </div>
        <ul className="m-0 list-none space-y-1.5 p-0">
          {grants.map((g) => (
            <li key={g.id} className="text-[12px] leading-snug">
              <span
                className="line-clamp-2"
                dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(g.title) }}
              />
              <span className="ml-1 text-[11px] text-muted-foreground">
                {g.sponsor ? `${g.sponsor} · ${g.endYear}` : g.endYear}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const rows =
    surface === "top-scholar" && data.topicRank
      ? data.topicRank.recent
      : surface === "pub-chip" || surface === "co-author" || surface === "top-scholar"
        ? data.recentPubs
        : [];
  if (rows.length === 0) return null;
  const label =
    surface === "top-scholar"
      ? `Recent in ${contextTopicLabel ?? "this research area"}`
      : "Recent pubs";
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <ul className="m-0 list-none space-y-1.5 p-0">
        {rows.map((r) => (
          <li key={r.pmid} className="text-[12px] leading-snug">
            <span
              className="line-clamp-2"
              dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(r.title) }}
            />
            {r.year ? (
              <span className="ml-1 text-[11px] text-muted-foreground">{r.year}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #853 — "Prominent method families" section for /methods top-scholar popovers.
 * Lists the hovered scholar's most-prominent method families (already overlay-
 * filtered + ranked by per-scholar pub count + capped server-side), each linking
 * to its `/methods` family page. Mirrors the recent-pubs list's visual frame.
 */
function MethodFamiliesSection({
  families,
}: {
  families: ApiResponse["methodFamilies"];
}) {
  if (families.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Prominent method families
      </div>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {families.map((f) => (
          <li key={`${f.supercategory}|${f.familyId}`}>
            <a
              href={f.href}
              className="-mx-1.5 flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[12px] leading-snug transition-colors hover:bg-muted"
            >
              <span className="line-clamp-1 font-medium text-foreground">
                {f.familyLabel}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                {f.pmidCount} pub{f.pmidCount === 1 ? "" : "s"}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Last-name token from a display name — drops a postnominal suffix and takes
 *  the final whitespace-separated token. Mirrors the facet components'
 *  lastNameKey, but preserves case for display ("…grants by Author"). */
function lastNameFromDisplay(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}

function derivePrimaryAction({
  surface,
  data,
  contextScholarName,
  primaryActionHref,
  primaryActionLabel,
  profileHref,
}: {
  surface: PersonPopoverSurface;
  data: ApiResponse;
  contextScholarName?: string;
  primaryActionHref?: string;
  primaryActionLabel?: string;
  profileHref: string | null;
}): { href: string; label: string; eventKey: string } | null {
  // Explicit override wins.
  if (primaryActionHref && primaryActionLabel) {
    return {
      href: primaryActionHref,
      label: primaryActionLabel,
      eventKey: "primary",
    };
  }

  if (surface === "co-author" || surface === "mentee") {
    const cp = data.coPubs;
    if (cp && cp.count > 0 && contextScholarName && profileHref) {
      // Co-pubs jump action — defaults to the co-pubs page if the popover
      // target has a profile slug. Falls back to View profile when missing.
      // #671 — co-pubs sub-pages stay under `/scholars/{slug}` (not the root
      // profile form), so build this from the slug, not `profileHref`.
      return {
        href: `/scholars/${data.header.slug}/co-pubs?with=${data.header.cwid}`,
        label: `See ${cp.count} co-pub${cp.count === 1 ? "" : "s"} →`,
        eventKey: "copubs",
      };
    }
  }

  if (surface === "top-scholar" && data.topicRank && profileHref) {
    return {
      href: profileHref,
      label: `See ${data.topicRank.topicPubCount} research-area pubs →`,
      eventKey: "topic_pubs",
    };
  }

  if (surface === "grant-investigator") {
    const n = data.header.totalGrantCount;
    if (n < 1) return null;
    const lastName = lastNameFromDisplay(data.header.preferredName);
    return {
      href: `/search?type=funding&investigator=${encodeURIComponent(data.header.cwid)}`,
      label: `See ${n} grant${n === 1 ? "" : "s"} by ${lastName} →`,
      eventKey: "grant_investigator_grants",
    };
  }

  return null;
}

function ActionButton({
  href,
  variant,
  children,
  eventName,
  actionKey,
  cwid,
  surface,
}: {
  href: string;
  variant: "primary" | "secondary";
  children: React.ReactNode;
  eventName: string;
  actionKey: string;
  cwid: string;
  surface: PersonPopoverSurface;
}) {
  const classes =
    variant === "primary"
      ? "flex-1 rounded-md border border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] px-2 py-1.5 text-center text-[11.5px] font-medium text-white transition-colors hover:bg-[#1f3a52]"
      : "flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-center text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted";
  return (
    <a
      href={href}
      className={classes}
      onClick={() => {
        try {
          navigator.sendBeacon?.(
            "/api/analytics",
            JSON.stringify({
              event: eventName,
              cwid,
              surface,
              action: actionKey,
              ts: Date.now(),
            }),
          );
        } catch {
          // ignore
        }
      }}
    >
      {children}
    </a>
  );
}
