"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProfilePublication, ScholarFamilyView, ScholarKeyword } from "@/lib/api/profile";
import { ActiveFilterBanner } from "@/components/profile/active-filter-banner";
import {
  deriveAuthorPositionRole,
  matchesAnyPosition,
  type PositionFilter,
  type SelectedPositions,
} from "@/components/profile/author-position-badge";
import { MethodsSection } from "@/components/profile/methods-section";
import { PublicationsSection } from "@/components/profile/publications-section";
import { TopicsSection } from "@/components/profile/topics-section";
import { TopicsUpdatingPlaceholder } from "@/components/profile/topics-updating-placeholder";

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
  /** #799 — family-primary Methods lens rows; empty when the lens flag is off. */
  families: ScholarFamilyView[];
  /** #801 — whether the sensitivity gate is on; gates the Methods lens's
   *  self/admin reveal fetch so a profile view makes no extra request when off. */
  sensitiveGateActive: boolean;
  /** #819 — whether the family rows are clickable to filter the publication list
   *  (mirrors Topics). When off, the lens is display-only and `?family=` is inert. */
  familyFilterEnabled: boolean;
  totalAcceptedPubs: number;
  /** Cwid of the scholar whose profile is being rendered. Threaded down
   *  to <PublicationsSection> → <PublicationRow> → <AuthorChipRow> so
   *  PersonPopover can apply the self-hover guard (#242). */
  scholarCwid?: string;
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
  families,
  sensitiveGateActive,
  familyFilterEnabled,
  totalAcceptedPubs,
  scholarCwid,
}: ProfilePubsClusterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // #819 — the #801 sensitive families are revealed (to self/admin) inside the
  // MethodsSection island; it hands them back here via onRevealedFamilies so the
  // family filter can resolve their PMIDs too. [] for public viewers / gate off.
  const [revealedFamilies, setRevealedFamilies] = useState<ScholarFamilyView[]>([]);

  // All families this viewer can see (public payload + any revealed sensitive
  // ones), deduped by familyId — the set whose rows are clickable and whose
  // pmids back the filter.
  const allFamilies = useMemo(() => {
    const seen = new Set(families.map((f) => f.familyId));
    return [...families, ...revealedFamilies.filter((f) => !seen.has(f.familyId))];
  }, [families, revealedFamilies]);

  const familyPmids = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of allFamilies) m.set(f.familyId, f.pmids);
    return m;
  }, [allFamilies]);

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

  // #819 — `?family=fam_0042,fam_0101` selection, same comma-list shape as
  // `?mesh=`. Inert (always []) when the family-filter flag is off, so a stray
  // param can't filter when the affordance isn't shown.
  const selectedFamilyIds = useMemo(() => {
    if (!familyFilterEnabled) return [];
    const raw = searchParams.get("family");
    if (!raw) return [];
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
  }, [searchParams, familyFilterEnabled]);

  const writeUrl = useCallback(
    (nextMesh: string[], nextPositions: SelectedPositions, nextFamilies: string[]) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      if (nextMesh.length === 0) params.delete("mesh");
      else params.set("mesh", nextMesh.join(","));
      if (nextPositions.length === 0) params.delete("position");
      else params.set("position", nextPositions.join(","));
      if (nextFamilies.length === 0) params.delete("family");
      else params.set("family", nextFamilies.join(","));
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const onToggle = useCallback(
    (ui: string) => {
      writeUrl(
        selectedUis.includes(ui) ? selectedUis.filter((x) => x !== ui) : [...selectedUis, ui],
        positions,
        selectedFamilyIds,
      );
    },
    [selectedUis, positions, selectedFamilyIds, writeUrl],
  );

  const onFamilyToggle = useCallback(
    (familyId: string) => {
      writeUrl(
        selectedUis,
        positions,
        selectedFamilyIds.includes(familyId)
          ? selectedFamilyIds.filter((x) => x !== familyId)
          : [...selectedFamilyIds, familyId],
      );
    },
    [selectedUis, positions, selectedFamilyIds, writeUrl],
  );

  const onClearAll = useCallback(() => writeUrl([], [], []), [writeUrl]);

  const onPositionsChange = useCallback(
    (next: SelectedPositions) => writeUrl(selectedUis, next, selectedFamilyIds),
    [selectedUis, selectedFamilyIds, writeUrl],
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
    // #819 — family filter (any-selected OR across families; AND vs the topic /
    // position axes). A pub belongs to a family iff its pmid is in that family's
    // membership set. selectedFamilyIds is already [] when the flag is off.
    if (selectedFamilyIds.length > 0) {
      const wanted = new Set<string>();
      for (const id of selectedFamilyIds)
        for (const pmid of familyPmids.get(id) ?? []) wanted.add(pmid);
      out = out.filter((p) => wanted.has(p.pmid));
    }
    return out;
  }, [publications, selectedUis, positions, selectedFamilyIds, familyPmids]);

  const filterActive =
    selectedUis.length > 0 || positions.length > 0 || selectedFamilyIds.length > 0;

  // The selected families, mapped back to {familyId, familyLabel} for the banner.
  const selectedFamilies = useMemo(() => {
    if (selectedFamilyIds.length === 0) return [];
    const byId = new Map(allFamilies.map((f) => [f.familyId, f]));
    return selectedFamilyIds
      .map((id) => byId.get(id))
      .filter((f): f is ScholarFamilyView => Boolean(f))
      .map((f) => ({ familyId: f.familyId, familyLabel: f.familyLabel }));
  }, [allFamilies, selectedFamilyIds]);

  // #118 — the reciter→dynamodb consistency window. Fetched client-side
  // because the 30-min window can't be baked into the 24h-ISR profile page.
  // While open, the Topics pills would be transiently incomplete, so the
  // section shows a placeholder instead. A fetch failure leaves the
  // placeholder hidden (fail-open to the normal Topics view).
  const [topicWindowOpen, setTopicWindowOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/topic-rebuild-window")
      .then((r) => (r.ok ? r.json() : { open: false }))
      .then((d: { open?: boolean }) => {
        if (!cancelled) setTopicWindowOpen(d.open === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {topicWindowOpen ? (
        <TopicsUpdatingPlaceholder />
      ) : keywords.length > 0 ? (
        <TopicsSection
          keywords={keywords}
          totalAcceptedPubs={totalAcceptedPubs}
          selectedUis={selectedUis}
          onToggle={onToggle}
          onClearAll={onClearAll}
        />
      ) : null}

      {/* #799 — family-primary Methods lens, the second of the two lenses,
          stacked below Subjects. Display-only; renders null when empty. */}
      <MethodsSection
        families={families}
        scholarCwid={scholarCwid}
        sensitiveGateActive={sensitiveGateActive}
        filterEnabled={familyFilterEnabled}
        selectedFamilyIds={selectedFamilyIds}
        onFamilyToggle={onFamilyToggle}
        onRevealedFamilies={setRevealedFamilies}
      />

      <ActiveFilterBanner
        count={filteredPublications.length}
        selected={selectedKeywords}
        positions={positions}
        families={selectedFamilies}
        onClearAll={onClearAll}
      />

      <PublicationsSection
        publications={filteredPublications}
        filterActive={filterActive}
        positions={positions}
        onPositionsChange={onPositionsChange}
        scholarCwid={scholarCwid}
      />
    </>
  );
}
