"use client";

/**
 * TOPIC_FEED_GRANTS_TRIALS — the topic page's "Activities" feed: the
 * publication feed plus the area's grants and clinical trials
 * (`/api/topics/[slug]/activity`, lib/api/topic-activity.ts), under one
 * header (`ActivitiesHeader`, per the Activities Redesign mockup):
 *
 *   - Scholars chips: every scholar with work in scope and their count across
 *     the three types (`?kind=scholars`); a chip sets the shared scholar filter.
 *   - Type tabs with counts; a tab with nothing in scope is disabled. Sort sits
 *     on the right of the tab row.
 *   - "Include related …": one switch for every tab that has both relevance
 *     tiers (the old Show select). Tab and chip counts follow it.
 *   - Grants / Clinical trials list the activity route's items with the Search
 *     page's `FundingResultRow` / `TrialResultRow` and the Load more frame.
 *   - The type lives in `?feed=grants|trials`, read and written on the client
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
import { ActivitiesHeader, type ScholarChip } from "@/components/taxonomy/activities-header";
import {
  FeedEmpty,
  FeedError,
  FeedSkeleton,
  TopicPublicationFeed,
  type ShowTier,
} from "@/components/taxonomy/publication-feed";
import { setScholarFilter, useScholarFilter } from "@/components/taxonomy/scholar-filter";
import { FEED_CHUNK, loadMoreLabel, nextChunkSize, writeShownParam } from "@/lib/taxonomy/feed-load-more";
import { useNihApplIdMap } from "@/lib/use-nih-resolve";
import type {
  TopicActivityKind,
  TopicActivityResult,
  TopicActivityScholarsResult,
  TopicActivitySort,
  TopicGrantActivityHit,
  TopicTrialActivityHit,
} from "@/lib/api/topic-activity";

export type FeedType = "publications" | "grants" | "trials";
type Tiers = { strongly: number; also: number };
type TierKey = keyof TopicActivityScholarsResult["totals"];

const TIER_KEY: Record<FeedType, TierKey> = { publications: "pubs", grants: "grant", trials: "trial" };
const KIND_OF: Record<Exclude<FeedType, "publications">, TopicActivityKind> = {
  grants: "grant",
  trials: "trial",
};
const NOUN: Record<TopicActivityKind, string> = { grant: "grants", trial: "clinical trials" };
const TAB_LABEL: Record<FeedType, string> = {
  publications: "Publications",
  grants: "Grants",
  trials: "Clinical trials",
};
const RELATED_LABEL: Record<FeedType, string> = {
  publications: "Include related papers",
  grants: "Include related grants",
  trials: "Include related trials",
};
const SORTS: Record<TopicActivityKind, Array<[TopicActivitySort, string]>> = {
  trial: [
    ["status", "Recruiting first"],
    ["newest", "Newest start"],
    ["ending", "Ending soonest"],
    ["best_match", "Best match"],
  ],
  grant: [
    ["status", "Active first"],
    ["newest", "Newest"],
    ["ending", "Ending soonest"],
    ["best_match", "Best match"],
  ],
};

function infoFor(t: FeedType, subarea: boolean): string {
  if (t === "grants") return "PI-led awards since 2020.";
  if (t === "trials") return "NCT-registered studies led by WCM PIs.";
  return `Papers mapped to this ${subarea ? "subarea" : "area"}.`;
}

/** What a list shows: the strongly tier, or every tier when the switch is on
 *  or the strongly tier is empty (the #326 fallback). */
function shownCount(t: Tiers, related: boolean): number {
  return related || t.strongly === 0 ? t.strongly + t.also : t.strongly;
}

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

function activityUrl(
  topicSlug: string,
  o: {
    kind: TopicActivityKind;
    sort: TopicActivitySort;
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

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
const fetchActivity = (url: string) => fetchJson<TopicActivityResult>(url);

/** The Scholars chips' and tabs' counts for the area or subarea. Null while
 *  loading or after an error (no chips, tabs without counts). */
function useActivityScholars(
  topicSlug: string,
  subtopic: string | null,
): TopicActivityScholarsResult | null {
  const [data, setData] = useState<TopicActivityScholarsResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const url = new URL(`/api/topics/${encodeURIComponent(topicSlug)}/activity`, window.location.origin);
    url.searchParams.set("kind", "scholars");
    if (subtopic) url.searchParams.set("subtopic", subtopic);
    fetchJson<TopicActivityScholarsResult>(url.toString())
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        // No chips and no counts; the feeds are unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [topicSlug, subtopic]);
  return data;
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
  const [related, setRelated] = useState(false);
  const scholar = useScholarFilter();
  const data = useActivityScholars(topicSlug, activeSubtopic);

  // Tab counts: the picked scholar's, else the area's.
  const pickedRow = scholar ? data?.scholars.find((s) => s.cwid === scholar.cwid) : undefined;
  const zero = { strongly: 0, also: 0 };
  const scopeTiers = (t: FeedType): Tiers | null =>
    data ? (scholar ? (pickedRow?.[TIER_KEY[t]] ?? zero) : data.totals[TIER_KEY[t]]) : null;
  const tabCount = (t: FeedType) => {
    const tiers = scopeTiers(t);
    return tiers ? shownCount(tiers, related) : null;
  };
  // A type with nothing in scope (e.g. after a scholar pick) falls back to
  // publications once the counts say so.
  const type: FeedType = requested !== "publications" && tabCount(requested) === 0 ? "publications" : requested;

  // Chips: each kind counted as its tab counts it (the area's fallback rule).
  let chips: ScholarChip[] | null = null;
  if (data) {
    const kinds: FeedType[] = ["publications", "grants", "trials"];
    const asShown = (k: FeedType, t: Tiers) =>
      related || data.totals[TIER_KEY[k]].strongly === 0 ? t.strongly + t.also : t.strongly;
    chips = data.scholars
      .map((s) => ({
        cwid: s.cwid,
        name: s.name,
        slug: s.slug,
        headshot: s.headshot,
        count: kinds.reduce((n, k) => n + asShown(k, s[TIER_KEY[k]]), 0),
      }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  const onTypeChange = (t: FeedType) => {
    setRequested(t);
    writeFeedParam(t);
  };
  const onPick = (cwid: string | null) => {
    const s = cwid ? data?.scholars.find((x) => x.cwid === cwid) : undefined;
    setScholarFilter(s ? { cwid: s.cwid, name: s.name, slug: s.slug } : null);
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

  const activeTiers = scopeTiers(type);
  const renderHeader = (sortControl: ReactNode) => (
    <ActivitiesHeader
      info={infoFor(type, activeSubtopic !== null)}
      scholars={chips}
      pickedCwid={scholar?.cwid ?? null}
      onPick={onPick}
      tabs={(["publications", "grants", "trials"] as const).map((t) => ({
        value: t,
        label: TAB_LABEL[t],
        count: tabCount(t),
      }))}
      activeTab={type}
      onTab={onTypeChange}
      sortControl={sortControl}
      related={
        activeTiers && activeTiers.strongly > 0 && activeTiers.also > 0
          ? { label: RELATED_LABEL[type], count: activeTiers.also, on: related, onChange: setRelated }
          : null
      }
    />
  );
  const showTier: ShowTier = related ? "all" : "strongly";

  if (type === "publications") {
    return (
      <TopicPublicationFeed
        topicSlug={topicSlug}
        activeSubtopic={activeSubtopic}
        loadMore={loadMore}
        subtopicLabels={subtopicLabels}
        renderHeader={renderHeader}
        showTier={showTier}
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
      showTier={showTier}
      renderHeader={renderHeader}
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
  showTier,
  renderHeader,
}: {
  topicSlug: string;
  kind: TopicActivityKind;
  subtopic: string | null;
  showTier: ShowTier;
  renderHeader: (sortControl: ReactNode) => ReactNode;
}) {
  const scholar = useScholarFilter();
  const cwid = scholar?.cwid ?? null;
  const [sort, setSort] = useState<TopicActivitySort>("status");
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
      {renderHeader(
        <>
          Sort
          <Select value={sort} onValueChange={(v) => setSort(v as TopicActivitySort)}>
            <SelectTrigger className="w-[170px]" aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS[kind].map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>,
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {scholar ? `Showing ${noun} by ${scholar.name}` : ""}
      </p>

      {body}
      <div aria-live="polite" role="status" className="sr-only" data-testid="feed-announcement">
        {list.announcement}
      </div>
    </section>
  );
}
