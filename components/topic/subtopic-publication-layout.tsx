"use client";

import { useState } from "react";
import { SubtopicRail, type SubtopicRailItem } from "@/components/topic/subtopic-rail";
import { PublicationFeed } from "@/components/topic/publication-feed";

export function SubtopicPublicationLayout({
  topicSlug,
  subtopics,
}: {
  topicSlug: string;
  subtopics: SubtopicRailItem[];
}) {
  const [activeSubtopic, setActiveSubtopic] = useState<string | null>(null);
  const subtopicLabel =
    activeSubtopic ? (subtopics.find((s) => s.id === activeSubtopic)?.label ?? null) : null;

  return (
    <div className="mt-12 flex flex-col gap-6 lg:flex-row lg:gap-8">
      <div className="lg:w-[280px] lg:shrink-0 lg:sticky lg:top-[84px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
        <SubtopicRail
          subtopics={subtopics}
          activeSubtopic={activeSubtopic}
          onSelect={setActiveSubtopic}
        />
      </div>
      <div className="min-w-0 flex-1">
        <PublicationFeed
          topicSlug={topicSlug}
          activeSubtopic={activeSubtopic}
          subtopicLabel={subtopicLabel}
        />
      </div>
    </div>
  );
}
