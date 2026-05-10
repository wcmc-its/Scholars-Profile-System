"use client";

import { Suspense, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProfilePublication, ScholarKeyword } from "@/lib/api/profile";
import { ActiveFilterBanner } from "@/components/profile/active-filter-banner";
import {
  deriveAuthorPositionRole,
  matchesAnyPosition,
  type PositionFilter,
  type SelectedPositions,
} from "@/components/profile/author-position-badge";
import { PublicationsSection } from "@/components/profile/publications-section";
import { TopicsSection } from "@/components/profile/topics-section";

const VALID_NON_ALL_POSITIONS: ReadonlySet<Exclude<PositionFilter, "all">> = new Set([
  "first",
  "senior",
  "co_author",
]);

/**
 * Issue #73 — orchestrates the Topics row, the active-filter banner, and the
 * publications list. Owns the `?mesh=D015316,D008168` URL state so the same
 * selection drives both the pill highlighting and the publication filter.
 *
 * The Selected highlights surface is unfiltered and stays outside this cluster
 * (curated 3-item list, not a feed).
 */
type ProfilePubsClusterProps = {
  publications: ProfilePublication[];
  keywords: ScholarKeyword[];
  totalAcceptedPubs: number;
};

export function ProfilePubsCluster(props: ProfilePubsClusterProps) {
  // useSearchParams() forces a CSR bailout during prerender (Next.js 15
  // strict mode). Suspense lets the static build emit the fallback.
  return (
    <Suspense fallback={null}>
      <ProfilePubsClusterInner {...props} />
    </Suspense>
  );
}

function ProfilePubsClusterInner({
  publications,
  keywords,
  totalAcceptedPubs,
}: ProfilePubsClusterProps) {
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

  // Issue #77 — Position is multi-select. Serialize as a comma-separated
  // list (`?position=first,senior`); empty/missing param means "no filter".
  // Legacy single-value URLs ("?position=first") parse fine since they have
  // no comma. Order is preserved so the active-filter banner reads back the
  // chips in the order the user toggled them.
  const positions: SelectedPositions = useMemo(() => {
    const raw = searchParams.get("position");
    if (!raw) return [];
    const seen = new Set<Exclude<PositionFilter, "all">>();
    const out: Array<Exclude<PositionFilter, "all">> = [];
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (
        VALID_NON_ALL_POSITIONS.has(v as Exclude<PositionFilter, "all">) &&
        !seen.has(v as Exclude<PositionFilter, "all">)
      ) {
        seen.add(v as Exclude<PositionFilter, "all">);
        out.push(v as Exclude<PositionFilter, "all">);
      }
    }
    return out;
  }, [searchParams]);

  const writeUrl = useCallback(
    (nextMesh: string[], nextPositions: SelectedPositions) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      if (nextMesh.length === 0) params.delete("mesh");
      else params.set("mesh", nextMesh.join(","));
      if (nextPositions.length === 0) params.delete("position");
      else params.set("position", nextPositions.join(","));
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
        positions,
      );
    },
    [selectedUis, positions, writeUrl],
  );

  const onClearAll = useCallback(() => writeUrl([], []), [writeUrl]);

  const onPositionsChange = useCallback(
    (next: SelectedPositions) => writeUrl(selectedUis, next),
    [selectedUis, writeUrl],
  );

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

  // Filter publications by topic (any-selected OR semantics, #73) AND
  // position (#72, #77 — now OR within the position axis as well).
  // Pre-filtering happens here so the existing PublicationsSection and
  // its year-group bucketing get a coherent input and update for free.
  const filteredPublications = useMemo(() => {
    let out = publications;
    if (selectedUis.length > 0) {
      const wanted = new Set(selectedUis);
      out = out.filter((p) => p.meshTerms.some((t) => t.ui && wanted.has(t.ui)));
    }
    if (positions.length > 0) {
      out = out.filter((p) => {
        const role = deriveAuthorPositionRole(p.authorship, p.wcmAuthors);
        return matchesAnyPosition(role, positions);
      });
    }
    return out;
  }, [publications, selectedUis, positions]);

  const filterActive = selectedUis.length > 0 || positions.length > 0;

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
        positions={positions}
        onClearAll={onClearAll}
      />

      <PublicationsSection
        publications={filteredPublications}
        filterActive={filterActive}
        positions={positions}
        onPositionsChange={onPositionsChange}
      />
    </>
  );
}
