"use client";

/**
 * Topic page body: the subarea rail + the publication panel, on the shared
 * `RailLayout`. Selection lives in `?subtopic=` (read on load, written on
 * change); `?subtopic=…#publications` deep links keep working.
 */
import { useMemo } from "react";
import { RailLayout } from "@/components/taxonomy/rail-layout";
import type { TaxonomyRailItem } from "@/components/taxonomy/taxonomy-rail";
import { TopicPublicationFeed } from "@/components/taxonomy/publication-feed";
import { SubtopicScholarsRow } from "@/components/topic/subtopic-scholars-row";

export type SubtopicRailItem = {
  id: string;
  label: string;
  displayName: string;
  description: string | null;
  shortDescription: string | null;
  pubCount: number;
};

/** Subareas at or under this many pubs sit below the "Less common" divider. */
const LESS_COMMON_THRESHOLD = 10;

export function TopicRailLayout({
  topicSlug,
  subtopics,
  totalPubCount,
  scholarNames = false,
  loadMore = false,
}: {
  topicSlug: string;
  subtopics: SubtopicRailItem[];
  /** Distinct research-article pmids in the whole topic (`getSubtopicRail`):
   *  the "All subareas" count. Not the row sum. */
  totalPubCount: number;
  /** TAXONOMY_SCHOLAR_CARDS — the selected subarea's scholars render as a
   *  "Scholars N" heading over plain name links. */
  scholarNames?: boolean;
  /** TAXONOMY_FEED_LOAD_MORE — Load more, one "All relevant" list and the
   *  per-row subarea label. */
  loadMore?: boolean;
}) {
  const items: TaxonomyRailItem[] = subtopics.map((s) => ({
    id: s.id,
    label: s.displayName,
    count: s.pubCount,
  }));
  // Same total the page's stats line, Spotlight "View all" and the
  // unfiltered feed heading use.
  const total = totalPubCount;
  const subtopicLabels = useMemo(
    () => Object.fromEntries(subtopics.map((s) => [s.id, s.displayName])),
    [subtopics],
  );
  const byId = (id: string | null) => (id ? subtopics.find((s) => s.id === id) ?? null : null);
  // D-09: displayName for headings, falling back to label.
  const labelFor = (id: string | null) => {
    const s = byId(id);
    return s?.displayName ?? s?.label ?? null;
  };

  return (
    <RailLayout
      items={items}
      paramKey="subtopic"
      deepLinkScrollTargetId="publications"
      idPrefix="publications"
      rail={{
        railLabel: "Subareas",
        headerText: `SUBAREAS (${subtopics.length})`,
        filterPlaceholder: "Filter subareas…",
        noMatchNoun: "subareas",
        allRow: { label: "All subareas", count: total },
        lessCommonThreshold: LESS_COMMON_THRESHOLD,
        variant: "plain",
      }}
      mobile={{ eyebrow: "Subarea", allLabel: "All subareas", allCount: total }}
      renderSubhead={(id) => {
        const label = labelFor(id);
        if (!label) return null;
        const desc = byId(id)?.shortDescription ?? null;
        return {
          title: label,
          body: desc ? (
            <p className="text-muted-foreground max-w-[62ch] text-[14.5px] text-pretty">{desc}</p>
          ) : null,
        };
      }}
    >
      {(activeSubtopic) => {
        const subtopicLabel = labelFor(activeSubtopic);
        return (
          <>
            {activeSubtopic && (
              <SubtopicScholarsRow
                topicSlug={topicSlug}
                subtopicId={activeSubtopic}
                subtopicLabel={subtopicLabel}
                variant={scholarNames ? "names" : "inline"}
              />
            )}
            <TopicPublicationFeed
              topicSlug={topicSlug}
              activeSubtopic={activeSubtopic}
              loadMore={loadMore}
              subtopicLabels={subtopicLabels}
            />
          </>
        );
      }}
    </RailLayout>
  );
}
