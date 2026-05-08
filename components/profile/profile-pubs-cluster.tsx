"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProfilePublication, ScholarKeyword } from "@/lib/api/profile";
import { ActiveFilterBanner } from "@/components/profile/active-filter-banner";
import { PublicationsSection } from "@/components/profile/publications-section";
import { TopicsSection } from "@/components/profile/topics-section";

/**
 * Issue #73 — orchestrates the Topics row, the active-filter banner, and the
 * publications list. Owns the `?mesh=D015316,D008168` URL state so the same
 * selection drives both the pill highlighting and the publication filter.
 *
 * The Selected highlights surface is unfiltered and stays outside this cluster
 * (curated 3-item list, not a feed).
 */
export function ProfilePubsCluster({
  publications,
  keywords,
  totalAcceptedPubs,
}: {
  publications: ProfilePublication[];
  keywords: ScholarKeyword[];
  totalAcceptedPubs: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const selectedUis = useMemo(() => {
    const raw = searchParams.get("mesh");
    if (!raw) return [];
    // De-dupe while preserving first-seen order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (v.length > 0 && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }, [searchParams]);

  const writeUrl = useCallback(
    (next: string[]) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      if (next.length === 0) params.delete("mesh");
      else params.set("mesh", next.join(","));
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const onToggle = useCallback(
    (ui: string) => {
      writeUrl(
        selectedUis.includes(ui)
          ? selectedUis.filter((x) => x !== ui)
          : [...selectedUis, ui],
      );
    },
    [selectedUis, writeUrl],
  );

  const onClearAll = useCallback(() => writeUrl([]), [writeUrl]);

  // Only resolved keywords (descriptorUi !== null) participate in URL state, so
  // selectedSet keys map cleanly to the keyword catalog.
  const selectedKeywords = useMemo(() => {
    if (selectedUis.length === 0) return [];
    const byUi = new Map(
      keywords.filter((k) => k.descriptorUi).map((k) => [k.descriptorUi as string, k]),
    );
    return selectedUis
      .map((ui) => byUi.get(ui))
      .filter((k): k is ScholarKeyword => Boolean(k));
  }, [keywords, selectedUis]);

  // Filter publications to those tagged with at least one selected keyword
  // (OR semantics). Pre-filtering happens here so the existing
  // PublicationsSection and its year-group bucketing get a coherent input
  // and update for free.
  const filteredPublications = useMemo(() => {
    if (selectedUis.length === 0) return publications;
    const wanted = new Set(selectedUis);
    return publications.filter((p) => p.meshTerms.some((t) => t.ui && wanted.has(t.ui)));
  }, [publications, selectedUis]);

  return (
    <>
      {keywords.length > 0 ? (
        <TopicsSection
          keywords={keywords}
          totalAcceptedPubs={totalAcceptedPubs}
          selectedUis={selectedUis}
          onToggle={onToggle}
          onClearAll={onClearAll}
        />
      ) : null}

      <ActiveFilterBanner
        count={filteredPublications.length}
        selected={selectedKeywords}
        onClearAll={onClearAll}
      />

      <PublicationsSection
        publications={filteredPublications}
        filterActive={selectedUis.length > 0}
      />
    </>
  );
}
