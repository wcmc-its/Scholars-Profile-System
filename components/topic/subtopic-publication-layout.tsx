"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SubtopicRail, type SubtopicRailItem } from "@/components/topic/subtopic-rail";
import { PublicationFeed } from "@/components/topic/publication-feed";
import { SubtopicScholarsRow } from "@/components/topic/subtopic-scholars-row";

export function SubtopicPublicationLayout(props: {
  topicSlug: string;
  subtopics: SubtopicRailItem[];
}) {
  // useSearchParams() forces a CSR bailout during prerender (Next.js 15
  // strict mode). Suspense lets the static build emit the fallback and
  // hydrate the full UI at request time.
  return (
    <Suspense fallback={null}>
      <SubtopicPublicationLayoutInner {...props} />
    </Suspense>
  );
}

function SubtopicPublicationLayoutInner({
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
  const subtopicShortDescription = activeSubtopicData?.shortDescription ?? null;

  // Some topics have no subtopics in the hierarchy (e.g. implementation_science,
  // oral_craniofacial_health). Render the publication feed full-width instead of
  // an empty rail so the page reads as intentional rather than broken.
  const hasSubtopics = subtopics.length > 0;

  const showSubtopicHeader =
    activeSubtopic !== null && subtopicLabel !== null && subtopicLabel.length > 0;

  return (
    <div id="publications" className="mt-16 scroll-mt-16">
      <hr className="mb-10 border-border" />
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      {hasSubtopics && (
        <div className="lg:w-[280px] lg:shrink-0 lg:sticky lg:top-[84px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
          <SubtopicRail
            subtopics={subtopics}
            activeSubtopic={activeSubtopic}
            onSelect={setActiveSubtopic}
          />
        </div>
      )}
      {/* Issue #172 — right panel reads heading → description → researchers
          → sort/controls → publications. The WCM-red left-border accent
          visually couples this panel to the selected item in the left rail;
          red is reserved for that structural connector only. */}
      <div
        className={`min-w-0 flex-1 ${hasSubtopics ? "lg:border-l-[3px] lg:border-[var(--color-primary-cornell-red)] lg:pl-6" : ""}`}
      >
        {showSubtopicHeader && (
          <header className="mb-4">
            <h2 className="text-xl font-semibold leading-tight">{subtopicLabel}</h2>
            {subtopicShortDescription && (
              <p className="mt-1 text-sm text-muted-foreground">
                {subtopicShortDescription}
              </p>
            )}
          </header>
        )}
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
          subtopicShortDescription={subtopicShortDescription}
          // Heading + description are now rendered above the researcher list
          // when a subtopic is active; suppress the duplicate inside the feed.
          suppressSubtopicHeader={showSubtopicHeader}
        />
      </div>
    </div>
    </div>
  );
}
