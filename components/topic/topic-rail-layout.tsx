"use client";

/**
 * Topic page body: the subarea rail + the publication panel, on the shared
 * `RailLayout`. Selection lives in `?subtopic=` (read on load, written on
 * change); `?subtopic=…#publications` deep links keep working.
 */
import { RailLayout } from "@/components/taxonomy/rail-layout";
import type { TaxonomyRailItem } from "@/components/taxonomy/taxonomy-rail";
import { PublicationFeed } from "@/components/topic/publication-feed";
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
}: {
  topicSlug: string;
  subtopics: SubtopicRailItem[];
}) {
  const items: TaxonomyRailItem[] = subtopics.map((s) => ({
    id: s.id,
    label: s.displayName,
    count: s.pubCount,
  }));
  // Same total the page's stats line and Spotlight "View all" use.
  const total = subtopics.reduce((sum, s) => sum + s.pubCount, 0);
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
          body: desc ? <p className="mt-1 text-sm text-muted-foreground">{desc}</p> : null,
        };
      }}
    >
      {(activeSubtopic) => {
        const subtopicLabel = labelFor(activeSubtopic);
        const showSubtopicHeader =
          activeSubtopic !== null && subtopicLabel !== null && subtopicLabel.length > 0;
        return (
          <>
            {activeSubtopic && (
              <SubtopicScholarsRow
                topicSlug={topicSlug}
                subtopicId={activeSubtopic}
                subtopicLabel={subtopicLabel}
              />
            )}
            <PublicationFeed
              topicSlug={topicSlug}
              activeSubtopic={activeSubtopic}
              subtopicLabel={subtopicLabel}
              subtopicShortDescription={byId(activeSubtopic)?.shortDescription ?? null}
              // The layout's subhead already shows the heading + description.
              suppressSubtopicHeader={showSubtopicHeader}
            />
          </>
        );
      }}
    </RailLayout>
  );
}
