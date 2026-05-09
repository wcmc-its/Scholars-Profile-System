"use client";

import { useEffect, useState } from "react";
import { TopScholarChip } from "./top-scholar-chip";
import type { TopScholarChipData } from "@/lib/api/topics";

export function SubtopicScholarsRow({
  topicSlug,
  subtopicId,
  subtopicLabel,
}: {
  topicSlug: string;
  subtopicId: string;
  subtopicLabel: string | null;
}) {
  const [scholars, setScholars] = useState<TopScholarChipData[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setScholars(null);
    fetch(
      `/api/topics/${encodeURIComponent(topicSlug)}/subtopics/${encodeURIComponent(subtopicId)}/scholars`,
    )
      .then((r) => (r.ok ? r.json() : { scholars: [] }))
      .then((data: { scholars: TopScholarChipData[] }) => {
        if (!cancelled) {
          setScholars(data.scholars ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScholars([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [topicSlug, subtopicId]);

  if (loading || !scholars || scholars.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {subtopicLabel ? `Researchers in ${subtopicLabel}` : "Researchers in this subtopic"}
      </div>
      <div className="flex flex-wrap gap-2 py-1">
        {scholars.map((s) => (
          <TopScholarChip key={s.cwid} scholar={s} />
        ))}
      </div>
    </div>
  );
}
