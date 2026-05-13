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

export type PersonPopoverSurface =
  | "facet"
  | "pub-chip"
  | "co-author"
  | "mentee"
  | "top-scholar";

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
  filterMatchCount,
  filterTopTopic,
  primaryActionHref,
  primaryActionLabel,
}: PersonPopoverProps) {
  const [data, setData] = React.useState<ApiResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const fetchedKeyRef = React.useRef<string | null>(null);

  const fetchKey = `${cwid}|${surface}|${contextScholarCwid ?? ""}|${contextPubPmid ?? ""}|${contextTopicSlug ?? ""}`;

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
            contextScholarName={contextScholarName}
            contextTopicLabel={contextTopicLabel}
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
  contextScholarName,
  contextTopicLabel,
  filterMatchCount,
  filterTopTopic,
  primaryActionHref,
  primaryActionLabel,
}: {
  data: ApiResponse;
  surface: PersonPopoverSurface;
  isSelf: boolean;
  contextScholarName?: string;
  contextTopicLabel?: string;
  filterMatchCount?: number;
  filterTopTopic?: string;
  primaryActionHref?: string;
  primaryActionLabel?: string;
}) {
  const { header } = data;
  const displayName = header.postnominal
    ? `${header.preferredName}, ${header.postnominal}`
    : header.preferredName;

  // Authorship role pill (pub-chip / co-author surfaces only).
  const rolePill =
    data.authorship && (surface === "pub-chip" || surface === "co-author") ? (
      <PersonCardRolePill
        role={ROLE_FROM_FLAGS(
          data.authorship.isFirst,
          data.authorship.isLast,
          data.authorship.firstCount,
          data.authorship.lastCount,
        )}
        onPub
      />
    ) : null;

  // Bottom contextual line — surface-specific.
  const contextLine = isSelf ? (
    <SelfNote />
  ) : (
    <SurfaceContextLine
      surface={surface}
      data={data}
      contextScholarName={contextScholarName}
      filterMatchCount={filterMatchCount}
      filterTopTopic={filterTopTopic}
    />
  );

  // Recent pubs list — varies by surface and self-hover state.
  const recentList = isSelf ? null : (
    <SurfaceRecentList
      surface={surface}
      data={data}
      contextTopicLabel={contextTopicLabel}
    />
  );

  // Actions row. View profile only when the scholar has an active slug; for
  // unlinked WCM authors (alumni) we drop "View profile" but keep any
  // context-aware primary action.
  const profileHref = header.slug ? `/scholars/${header.slug}` : null;
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
      {!primary && !showViewProfile && !contextLine && !recentList ? (
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
  contextScholarName,
  filterMatchCount,
  filterTopTopic,
}: {
  surface: PersonPopoverSurface;
  data: ApiResponse;
  contextScholarName?: string;
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
    return (
      <div className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        Rank <strong className="font-semibold text-foreground">#{tr.rank}</strong>{" "}
        in this topic ·{" "}
        <strong className="font-semibold text-foreground">{tr.topicPubCount} pubs</strong>{" "}
        tagged
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
  const rows =
    surface === "top-scholar" && data.topicRank
      ? data.topicRank.recent
      : surface === "pub-chip" || surface === "co-author" || surface === "top-scholar"
        ? data.recentPubs
        : [];
  if (rows.length === 0) return null;
  const label =
    surface === "top-scholar"
      ? `Recent in ${contextTopicLabel ?? "this topic"}`
      : "Recent pubs";
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <ul className="m-0 list-none space-y-1.5 p-0">
        {rows.map((r) => (
          <li key={r.pmid} className="text-[12px] leading-snug">
            <span className="line-clamp-2">{r.title}</span>
            {r.year ? (
              <span className="ml-1 text-[11px] text-muted-foreground">{r.year}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
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
      return {
        href: `${profileHref}/co-pubs?with=${data.header.cwid}`,
        label: `See ${cp.count} co-pub${cp.count === 1 ? "" : "s"} →`,
        eventKey: "copubs",
      };
    }
  }

  if (surface === "top-scholar" && data.topicRank && profileHref) {
    return {
      href: profileHref,
      label: `See ${data.topicRank.topicPubCount} topic pubs →`,
      eventKey: "topic_pubs",
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
