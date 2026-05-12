"use client";

import { SectionInfoButton } from "@/components/shared/section-info-button";

const PUBLICATION_CENTRIC_COPY =
  "Ranked by ReCiterAI weekly. Scoring covers publications co-authored by full-time WCM faculty; co-authors of those publications appear regardless of role.";
const SCHOLAR_CENTRIC_COPY =
  "Ranked by ReCiterAI weekly. Surfaces full-time faculty, postdocs, fellows, and doctoral students whose recent first-author or senior-author work has been scored.";

/**
 * Info button shown next to a heading when its publication / scholar list
 * is sorted by ReCiterAI impact rather than a deterministic field (date,
 * alphabetical). Same style and behavior as SectionInfoButton elsewhere —
 * no pill, no "Curated" label — issue #176.
 */
export function CuratedTag({
  surface,
}: {
  surface: "publication_centric" | "scholar_centric";
}) {
  const copy =
    surface === "publication_centric" ? PUBLICATION_CENTRIC_COPY : SCHOLAR_CENTRIC_COPY;
  const anchor =
    surface === "publication_centric" ? "recentHighlights" : "topScholars";
  return (
    <SectionInfoButton label="Curated ranking" anchor={anchor}>
      {copy}
    </SectionInfoButton>
  );
}
