"use client";

/**
 * TOPIC_FEED_GRANTS_TRIALS — the topic page's "Activities" feed: the
 * publication feed plus the area's grants and clinical trials
 * (`/api/topics/[slug]/activity`, lib/api/topic-activity.ts), switched by a
 * Type select that sits with Show and Sort in the heading row.
 *
 *   - Publications (the default) is the publication feed exactly, under an
 *     "Activities" heading with the Type select first in its controls.
 *   - Grants / Clinical trials list the activity route's items with the Search
 *     page's `FundingResultRow` / `TrialResultRow`, Sort (Newest / Best match),
 *     the same Show tiers and the same Load more frame. No research-articles
 *     toggle.
 *   - A Type option whose count is 0 is hidden; with neither grants nor trials
 *     the select is not shown at all (like Show without an also-tier).
 *   - The choice lives in `?feed=grants|trials`, read and written on the client
 *     only (history.replaceState), never by the server render.
 *
 * Off (the flag), the page renders `TopicPublicationFeed` directly and none of
 * this is mounted.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FundingResultRow } from "@/components/search/funding-result-row";
import { TrialResultRow } from "@/components/search/trial-result-row";
import { PublicationsHeadingRow } from "@/components/taxonomy/publications-heading-row";
import {
  FeedEmpty,
  FeedError,
  FeedSkeleton,
  TopicPublicationFeed,
} from "@/components/taxonomy/publication-feed";
import {
  ScholarFilterChip,
  setScholarFilter,
  useScholarFilter,
} from "@/components/taxonomy/scholar-filter";
import { FEED_CHUNK, loadMoreLabel, nextChunkSize, writeShownParam } from "@/lib/taxonomy/feed-load-more";
import { useNihApplIdMap } from "@/lib/use-nih-resolve";
import type {
  TopicActivityKind,
  TopicActivityResult,
  TopicGrantActivityHit,
  TopicTrialActivityHit,
} from "@/lib/api/topic-activity";

export type FeedType = "publications" | "grants" | "trials";
type ActivitySort = "newest" | "best_match";
type ShowTier = "strongly" | "all";
type Counts = TopicActivityResult["counts"];

const KIND_OF: Record<Exclude<FeedType, "publications">, TopicActivityKind> = {
  grants: "grant",
  trials: "trial",
};

const NOUN: Record<TopicActivityKind, string> = { grant: "grants", trial: "clinical trials" };

const NOTE: Record<TopicActivityKind, string> = {
  grant: "PI-led InfoEd awards since 2020.",
  trial: "NCT-registered studies led by WCM PIs.",
};

/** `?feed=` → type; anything unknown is the default. */
export function readFeedParam(search: string): FeedType {
  const v = new URLSearchParams(search).get("feed");
  return v === "grants" || v === "trials" ? v : "publications";
}

/** Write (or, for publications, remove) `?feed=`, dropping `?shown=` with it. */
function writeFeedParam(t: FeedType): void {
  writeShownParam(null);
  try {
    const url = new URL(window.location.href);
    if (t === "publications") url.searchParams.delete("feed");
    else url.searchParams.set("feed", t);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL sync is best effort.
  }
}

function kindTotal(counts: Counts | null, kind: TopicActivityKind): number | null {
  return counts ? counts[kind].strongly + counts[kind].also : null;
}

function activityUrl(
  topicSlug: string,
  o: {
    kind: TopicActivityKind;
    sort: ActivitySort;
    page: number;
    tier?: "strongly";
    subtopic: string | null;
    cwid: string | null;
  },
): string {
  const url = new URL(`/api/topics/${encodeURIComponent(topicSlug)}/activity`, window.location.origin);
  url.searchParams.set("kind", o.kind);
  url.searchParams.set("sort", o.sort);
  url.searchParams.set("page", String(o.page));
  if (o.tier) url.searchParams.set("tier", o.tier);
  if (o.subtopic) url.searchParams.set("subtopic", o.subtopic);
  if (o.cwid) url.searchParams.set("cwid", o.cwid);
  return url.toString();
}

async function fetchActivity(url: string): Promise<TopicActivityResult> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as TopicActivityResult;
}

/** Per-kind counts for the Type options (one request per scope). Null while
 *  loading or after an error. */
function useActivityCounts(
  topicSlug: string,
  subtopic: string | null,
  cwid: string | null,
): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCounts(null);
    fetchActivity(activityUrl(topicSlug, { kind: "grant", sort: "newest", page: 1, subtopic, cwid }))
      .then((d) => {
        if (!cancelled) setCounts(d.counts);
      })
      .catch(() => {
        // No counts ⇒ no grant / trial options; the publication feed is unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [topicSlug, subtopic, cwid]);
  return counts;
}

function TypeSelect({
  value,
  onChange,
  counts,
}: {
  value: FeedType;
  onChange: (t: FeedType) => void;
  counts: Counts | null;
}) {
  const grants = kindTotal(counts, "grant") ?? 0;
  const trials = kindTotal(counts, "trial") ?? 0;
  // The current type stays listed even before its count arrives.
  const showGrants = grants > 0 || value === "grants";
  const showTrials = trials > 0 || value === "trials";
  if (!showGrants && !showTrials) return null;
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
      Type
      <Select value={value} onValueChange={(v) => onChange(v as FeedType)}>
        <SelectTrigger className="w-[200px]" aria-label="Type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="publications">Publications</SelectItem>
          {showGrants && <SelectItem value="grants">Grants</SelectItem>}
          {showTrials && <SelectItem value="trials">Clinical trials</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Topic page feed under TOPIC_FEED_GRANTS_TRIALS. */
export function TopicActivityFeed({
  topicSlug,
  activeSubtopic,
  loadMore = false,
  subtopicLabels,
}: {
  topicSlug: string;
  activeSubtopic: string | null;
  /** TAXONOMY_FEED_LOAD_MORE (publications; grants and trials always load more). */
  loadMore?: boolean;
  subtopicLabels?: Record<string, string>;
}) {
  const [requested, setRequested] = useState<FeedType>("publications");
  // Client-read only: the server render is always the publications view.
  useEffect(() => {
    setRequested(readFeedParam(window.location.search));
  }, []);
  const scholar = useScholarFilter();
  const counts = useActivityCounts(topicSlug, activeSubtopic, scholar?.cwid ?? null);
  // A type with nothing in scope (e.g. after a scholar pick) falls back to
  // publications once the counts say so.
  const type: FeedType =
    requested !== "publications" && counts !== null && kindTotal(counts, KIND_OF[requested]) === 0
      ? "publications"
      : requested;

  const onTypeChange = (t: FeedType) => {
    setRequested(t);
    writeFeedParam(t);
  };

  // The publication feed keeps the pick across a type switch; this feed clears
  // it on unmount and on a subarea change (as TopicPublicationFeed does).
  useEffect(() => () => setScholarFilter(null), []);
  const prevSubtopic = useRef(activeSubtopic);
  useEffect(() => {
    if (prevSubtopic.current === activeSubtopic) return;
    prevSubtopic.current = activeSubtopic;
    setScholarFilter(null);
  }, [activeSubtopic]);

  const typeControl = <TypeSelect value={type} onChange={onTypeChange} counts={counts} />;

  if (type === "publications") {
    return (
      <TopicPublicationFeed
        topicSlug={topicSlug}
        activeSubtopic={activeSubtopic}
        loadMore={loadMore}
        subtopicLabels={subtopicLabels}
        heading="Activities"
        leadControl={typeControl}
        retainScholarFilter
      />
    );
  }
  const kind = KIND_OF[type];
  return (
    <ActivityKindFeed
      key={kind}
      topicSlug={topicSlug}
      kind={kind}
      subtopic={activeSubtopic}
      typeControl={typeControl}
    />
  );
}

type ActivityHit = TopicGrantActivityHit | TopicTrialActivityHit;

function hitKey(kind: TopicActivityKind, h: ActivityHit): string {
  return kind === "grant"
    ? (h as TopicGrantActivityHit).projectId
    : (h as TopicTrialActivityHit).trialId;
}

type ListState = {
  rows: ActivityHit[];
  data: TopicActivityResult | null;
  loaded: number;
  /** The first chunk fell back to every tier (strongly empty, also not). */
  merged: boolean;
  loading: boolean;
  error: string | null;
  focusKey: string | null;
  announcement: string;
};

const EMPTY_LIST: ListState = {
  rows: [],
  data: null,
  loaded: 0,
  merged: false,
  loading: true,
  error: null,
  focusKey: null,
  announcement: "",
};

/** One kind's list: Sort, Show, Load more. */
function ActivityKindFeed({
  topicSlug,
  kind,
  subtopic,
  typeControl,
}: {
  topicSlug: string;
  kind: TopicActivityKind;
  subtopic: string | null;
  typeControl: ReactNode;
}) {
  const scholar = useScholarFilter();
  const cwid = scholar?.cwid ?? null;
  const [sort, setSort] = useState<ActivitySort>("newest");
  const [showTier, setShowTier] = useState<ShowTier>("strongly");
  const [list, setList] = useState<ListState>(EMPTY_LIST);
  const listRef = useRef(list);
  listRef.current = list;
  const reqRef = useRef(0);

  const urlFor = useCallback(
    (page: number, tiered: boolean) =>
      activityUrl(topicSlug, {
        kind,
        sort,
        page,
        tier: tiered ? "strongly" : undefined,
        subtopic,
        cwid,
      }),
    [topicSlug, kind, sort, subtopic, cwid],
  );

  // First chunk on every scope / Sort / Show change.
  useEffect(() => {
    const id = ++reqRef.current;
    setList((s) => ({ ...s, loading: true, error: null, focusKey: null }));
    (async () => {
      if (showTier === "all") return { data: await fetchActivity(urlFor(1, false)), merged: false };
      const strongly = await fetchActivity(urlFor(1, true));
      const t = strongly.tierTotals;
      if (t.strongly === 0 && t.also > 0) {
        return { data: await fetchActivity(urlFor(1, false)), merged: true };
      }
      return { data: strongly, merged: false };
    })()
      .then(({ data, merged }) => {
        if (id !== reqRef.current) return;
        setList({
          ...EMPTY_LIST,
          rows: data.hits,
          data,
          loaded: FEED_CHUNK,
          merged,
          loading: false,
        });
      })
      .catch((err: unknown) => {
        if (id !== reqRef.current) return;
        setList((s) => ({ ...s, loading: false, error: String(err) }));
      });
  }, [urlFor, showTier]);

  const loadNext = useCallback(() => {
    const s = listRef.current;
    if (s.loading || !s.data) return;
    const page = s.loaded / FEED_CHUNK + 1;
    const id = ++reqRef.current;
    setList((prev) => ({ ...prev, loading: true, error: null }));
    fetchActivity(urlFor(page, showTier === "strongly" && !s.merged))
      .then((data) => {
        if (id !== reqRef.current) return;
        const seen = new Set(s.rows.map((r) => hitKey(kind, r)));
        const added = data.hits.filter((h) => !seen.has(hitKey(kind, h)));
        const rows = [...s.rows, ...added];
        setList({
          rows,
          data,
          loaded: s.loaded + FEED_CHUNK,
          merged: s.merged,
          loading: false,
          error: null,
          focusKey: added[0] ? hitKey(kind, added[0]) : null,
          announcement: `Showing ${rows.length.toLocaleString()} of ${data.total.toLocaleString()} ${NOUN[kind]}`,
        });
      })
      .catch((err: unknown) => {
        if (id !== reqRef.current) return;
        setList((prev) => ({ ...prev, loading: false, error: String(err) }));
      });
  }, [urlFor, showTier, kind]);

  const ulRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (!list.focusKey) return;
    const items = ulRef.current?.querySelectorAll<HTMLElement>("li[data-key]") ?? [];
    for (const el of items) {
      if (el.dataset.key === list.focusKey) {
        el.focus();
        break;
      }
    }
  }, [list.focusKey]);

  const grantAwards = useNihApplIdMap(
    kind === "grant" ? list.rows.map((h) => (h as TopicGrantActivityHit).awardNumber) : [],
  );

  const { data, rows } = list;
  const tierTotals = data?.tierTotals ?? null;
  const showTierSelect = tierTotals !== null && tierTotals.strongly > 0 && tierTotals.also > 0;
  const countLabel = data ? kindTotal(data.counts, kind)!.toLocaleString() : null;
  const noun = NOUN[kind];

  let body: ReactNode;
  if (list.loading && data === null) body = <FeedSkeleton />;
  else if (list.error && data === null) body = <FeedError noun={noun} />;
  else if (!data || (data.total === 0 && rows.length === 0)) {
    body = <FeedEmpty noun={noun} body={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} in this area will appear as they are indexed.`} />;
  } else {
    const next = nextChunkSize(list.loaded, data.total);
    body = (
      <>
        <ul ref={ulRef}>
          {rows.map((h) => {
            const key = hitKey(kind, h);
            return (
              <li
                key={key}
                tabIndex={-1}
                data-key={key}
                className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {kind === "grant" ? (
                  <FundingResultRow
                    hit={h as TopicGrantActivityHit}
                    applId={
                      (h as TopicGrantActivityHit).awardNumber
                        ? grantAwards[(h as TopicGrantActivityHit).awardNumber!]
                        : undefined
                    }
                  />
                ) : (
                  <TrialResultRow hit={h as TopicTrialActivityHit} q="" conceptLabel={null} />
                )}
              </li>
            );
          })}
        </ul>
        {list.error && <FeedError noun={noun} />}
        {next > 0 && (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={loadNext}
              disabled={list.loading}
              aria-busy={list.loading || undefined}
              className="max-sm:min-h-11 max-sm:w-full"
              data-testid="feed-load-more"
            >
              {list.loading ? "Loading…" : loadMoreLabel(list.loaded, rows.length, data.total)}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <PublicationsHeadingRow heading="Activities" countLabel={countLabel}>
        {typeControl}
        {showTierSelect && tierTotals && (
          <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
            Show
            <Select value={showTier} onValueChange={(v) => setShowTier(v as ShowTier)}>
              <SelectTrigger className="w-[200px]" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strongly">
                  Strongly relevant ({tierTotals.strongly.toLocaleString()})
                </SelectItem>
                <SelectItem value="all">
                  All relevant ({(tierTotals.strongly + tierTotals.also).toLocaleString()})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
          Sort by
          <Select value={sort} onValueChange={(v) => setSort(v as ActivitySort)}>
            <SelectTrigger className="w-[200px]" aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="best_match">Best match</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PublicationsHeadingRow>

      <p className="text-xs text-muted-foreground" data-testid="activity-note">
        {NOTE[kind]}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {scholar ? `Showing ${noun} by ${scholar.name}` : ""}
      </p>
      {scholar && <ScholarFilterChip scholar={scholar} noun={noun} />}

      {body}
      <div aria-live="polite" role="status" className="sr-only" data-testid="feed-announcement">
        {list.announcement}
      </div>
    </section>
  );
}
