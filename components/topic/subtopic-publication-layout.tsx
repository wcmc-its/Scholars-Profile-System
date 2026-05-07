"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SubtopicRail, type SubtopicRailItem } from "@/components/topic/subtopic-rail";
import { PublicationFeed } from "@/components/topic/publication-feed";

export function SubtopicPublicationLayout({
  topicSlug,
  subtopics,
}: {
  topicSlug: string;
  subtopics: SubtopicRailItem[];
}) {
  const searchParams = useSearchParams();
  const requestedSubtopic = searchParams.get("subtopic");
  const [activeSubtopic, setActiveSubtopic] = useState<string | null>(
    requestedSubtopic && subtopics.some((s) => s.id === requestedSubtopic)
      ? requestedSubtopic
      : null,
  );

  useEffect(() => {
    if (requestedSubtopic && subtopics.some((s) => s.id === requestedSubtopic)) {
      setActiveSubtopic(requestedSubtopic);
    }
  }, [requestedSubtopic, subtopics]);

  const activeSubtopicData = activeSubtopic ? subtopics.find((s) => s.id === activeSubtopic) ?? null : null;
  // D-09: prefer displayName for the publication-feed heading; falls back to label
  // through the rail's type (Plan 04 already applied (display_name ?? label) at API).
  const subtopicLabel = activeSubtopicData?.displayName ?? activeSubtopicData?.label ?? null;
  const subtopicDescription = activeSubtopicData?.description ?? null;

  return (
    <div className="mt-16">
      <hr className="mb-10 border-border" />
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
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
          subtopicDescription={subtopicDescription}
        />
      </div>
    </div>
    </div>
  );
}
