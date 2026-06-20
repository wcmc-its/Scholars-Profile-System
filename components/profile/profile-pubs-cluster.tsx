"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ProfilePublication, ScholarFamilyView, ScholarKeyword } from "@/lib/api/profile";
import type { ScholarCoreUsage } from "@/lib/api/scholar-cores";
import {
  ActiveFilterBanner,
  POSITION_BANNER_LABEL,
} from "@/components/profile/active-filter-banner";
import {
  deriveAuthorPositionRole,
  matchesAnyPosition,
  type PositionFilter,
  type SelectedPositions,
} from "@/components/profile/author-position-badge";
import { FilterBar } from "@/components/profile/filter-bar";
import { computeFacetCounts } from "@/lib/profile/facet-counts";
import { MethodsSection } from "@/components/profile/methods-section";
import { CoresSection } from "@/components/profile/cores-section";
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
  /** "Cores used" chips — WCM core facilities the scholar's publications
   *  confirmed-used; empty when the cores lens flag is off (ships dark). Display
   *  only — not part of the publication-filter facet state. */
  cores: ScholarCoreUsage[];
  /** #801 — whether the sensitivity gate is on; gates the Methods lens's
   *  self/admin reveal fetch so a profile view makes no extra request when off. */
  sensitiveGateActive: boolean;
  /** #819 — whether the family rows are clickable to filter the publication list
   *  (mirrors Topics). When off, the lens is display-only and `?family=` is inert. */
  familyFilterEnabled: boolean;
  /** Standalone Method pages (`METHODS_LENS_PAGES`) — gates the per-row outbound
   *  link to the cross-scholar `/methods/**` pages. Distinct from the #819 filter:
   *  a separate trailing affordance that navigates, never the label button. */
  methodPagesEnabled: boolean;
  /** PROFILE_FACET_REDESIGN — the facet-filter redesign gate. When off, the
   *  rendered output is byte-identical to today (prose ActiveFilterBanner, plain
   *  counts). When on, the unified FilterBar, contextual facet counts, and the
   *  explicit empty state turn on. Additive: all new UI lives under this branch. */
  facetRedesignEnabled: boolean;
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
  cores,
  sensitiveGateActive,
  familyFilterEnabled,
  methodPagesEnabled,
  facetRedesignEnabled,
  totalAcceptedPubs,
  scholarCwid,
}: ProfilePubsClusterProps) {
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
      // Update the URL in place with the native History API rather than
      // router.replace(). /[slug] and /scholars/[slug] are force-dynamic, so a
      // router navigation — even a query-only one — refetches the route's RSC
      // payload and re-renders the whole profile on the server (multi-second on
      // a heavy profile behind CloudFront). Filtering is entirely client-side and
      // driven by useSearchParams(), which Next keeps in sync with
      // history.replaceState, so this re-filters instantly with no server round
      // trip. replaceState does not scroll, matching the prior { scroll: false }.
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, searchParams],
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

  // #17 — one-shot confirmation trigger, with ZERO injected latency. Track the
  // previous filtered-count and bump a generation counter the instant it changes
  // (React's documented "adjust state during render" pattern — it re-renders
  // synchronously before paint, so there is no timer and no flash). The
  // generation is used as a React `key` on the animated wrappers below so they
  // remount and their one-shot CSS keyframe self-plays exactly once. The first
  // paint (prevCount === null) does NOT bump — the list/count pulse only on a
  // genuine user-driven filter change. prefers-reduced-motion zeroes the CSS.
  const currentCount = filteredPublications.length;
  const [prevCount, setPrevCount] = useState<number | null>(null);
  const [filterGeneration, setFilterGeneration] = useState(0);
  if (prevCount !== currentCount) {
    setPrevCount(currentCount);
    if (prevCount !== null) setFilterGeneration((g) => g + 1);
  }

  // The selected families, mapped back to {familyId, familyLabel} for the banner.
  const selectedFamilies = useMemo(() => {
    if (selectedFamilyIds.length === 0) return [];
    const byId = new Map(allFamilies.map((f) => [f.familyId, f]));
    return selectedFamilyIds
      .map((id) => byId.get(id))
      .filter((f): f is ScholarFamilyView => Boolean(f))
      .map((f) => ({ familyId: f.familyId, familyLabel: f.familyLabel }));
  }, [allFamilies, selectedFamilyIds]);

  // PROFILE_FACET_REDESIGN — contextual ("exclude-own-facet") counts for the
  // Topics chips and Methods rows, so each option shows how many in-context pubs
  // it covers under the OTHER active facets. Only computed when the redesign is
  // on AND a filter is active (the default state shows plain profile-wide
  // counts); null otherwise so the sections fall back to their existing counts.
  // Author-position composes as a hidden facet here (no chip in the bar) by
  // feeding `matchesPosition` — it narrows every count but is never displayed.
  const facetCounts = useMemo(
    () =>
      facetRedesignEnabled && filterActive
        ? computeFacetCounts({
            publications,
            selectedUis,
            selectedFamilyIds,
            familyPmids,
            matchesPosition: (pub) =>
              positions.length === 0 ||
              matchesAnyPosition(
                deriveAuthorPositionRole(pub.authorship, pub.wcmAuthors),
                positions,
              ),
            topicTotals: new Map(
              keywords
                .filter((k) => k.descriptorUi)
                .map((k) => [k.descriptorUi as string, k.pubCount]),
            ),
            familyTotals: new Map(allFamilies.map((f) => [f.familyId, f.pubCount])),
          })
        : null,
    [
      facetRedesignEnabled,
      filterActive,
      publications,
      selectedUis,
      selectedFamilyIds,
      positions,
      familyPmids,
      keywords,
      allFamilies,
    ],
  );

  // The selected topics, mapped to the FilterBar's {ui, label} chip shape.
  const selectedTopicChips = useMemo(
    () =>
      selectedKeywords
        .filter((k) => k.descriptorUi)
        .map((k) => ({ ui: k.descriptorUi as string, label: k.displayLabel })),
    [selectedKeywords],
  );

  // #12 — Position is now surfaced as a third-hue (warm amber) chip in the
  // FilterBar (it was a hidden, counts-only facet in v1). Reuses the same
  // SelectedPositions URL state + writeUrl path; the per-chip remove drops one
  // bucket from `?position=`.
  const selectedPositionChips = useMemo(
    () => positions.map((p) => ({ bucket: p, label: POSITION_BANNER_LABEL[p] })),
    [positions],
  );

  const onRemovePosition = useCallback(
    (bucket: Exclude<PositionFilter, "all">) =>
      onPositionsChange(positions.filter((p) => p !== bucket)),
    [positions, onPositionsChange],
  );

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
          facetRedesignEnabled={facetRedesignEnabled}
          topicCounts={facetCounts?.topic ?? null}
        />
      ) : null}

      {/* #799 — family-primary Methods lens, the second of the two lenses,
          stacked below Subjects. Display-only; renders null when empty. */}
      <MethodsSection
        families={families}
        scholarCwid={scholarCwid}
        sensitiveGateActive={sensitiveGateActive}
        filterEnabled={familyFilterEnabled}
        pagesEnabled={methodPagesEnabled}
        selectedFamilyIds={selectedFamilyIds}
        onFamilyToggle={onFamilyToggle}
        onRevealedFamilies={setRevealedFamilies}
        facetRedesignEnabled={facetRedesignEnabled}
        familyCounts={facetCounts?.family ?? null}
      />

      {/* "Cores used" — display-only chip row of WCM core facilities the
          scholar's publications confirmed-used. Renders null when empty (always,
          while the cores lens flag is off). Not a publication-filter facet. */}
      <CoresSection cores={cores} />


      {/* PROFILE_FACET_REDESIGN — the unified chip bar replaces the prose banner
          when the redesign is on; otherwise the existing banner renders verbatim.
          FilterBar returns null when nothing is selected.

          #18 FLAG-HYGIENE / REMOVAL TRIGGER: this `facetRedesignEnabled ? … : …`
          fork (and the parallel forks in topics-section, methods-section, and the
          empty-state block below) is the v1 #829-pill fallback kept behind the
          flag. Once PROFILE_FACET_REDESIGN is prod-on and stable for N weeks,
          delete the OFF branches (ActiveFilterBanner here, the legacy renderers
          there) so two renderers don't orphan. File that cleanup as a tracked
          follow-up on #841 (or a fresh issue) WHEN the prod flag flips — not
          before. */}
      {facetRedesignEnabled ? (
        <FilterBar
          topics={selectedTopicChips}
          families={selectedFamilies}
          positions={selectedPositionChips}
          count={filteredPublications.length}
          countGeneration={filterGeneration}
          onRemoveTopic={onToggle}
          onRemoveFamily={onFamilyToggle}
          onRemovePosition={onRemovePosition}
          onClearAll={onClearAll}
        />
      ) : (
        <ActiveFilterBanner
          count={filteredPublications.length}
          selected={selectedKeywords}
          positions={positions}
          families={selectedFamilies}
          onClearAll={onClearAll}
        />
      )}

      {/* PROFILE_FACET_REDESIGN — an explicit "nothing matches" block with a
          one-tap reset when an active filter empties the list. Flag-on only; the
          PublicationsSection panel still renders below (its position controls and
          chrome stay put). When off, behavior is byte-identical to today. */}
      {facetRedesignEnabled && filterActive && filteredPublications.length === 0 ? (
        <div
          role="status"
          className="border-border-strong mb-5 rounded-lg border bg-background px-4 py-6 text-center"
        >
          <p className="text-sm font-medium">No publications match these filters</p>
          <button
            type="button"
            onClick={onClearAll}
            className="mt-2 text-sm font-medium underline-offset-4 hover:underline"
            style={{ color: "var(--color-accent-slate)" }}
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/* #17 — flag-gated one-shot pulse. Keyed by filterGeneration so it remounts
          → the CSS keyframe self-plays once when the filtered set changes; no
          pulse on first paint (generation 0). Flag-off output is byte-identical
          (no wrapper). */}
      {facetRedesignEnabled ? (
        <div
          key={`pulse-${filterGeneration}`}
          className={filterGeneration > 0 ? "facet-list-pulse" : undefined}
        >
          <PublicationsSection
            publications={filteredPublications}
            filterActive={filterActive}
            positions={positions}
            onPositionsChange={onPositionsChange}
            scholarCwid={scholarCwid}
          />
        </div>
      ) : (
        <PublicationsSection
          publications={filteredPublications}
          filterActive={filterActive}
          positions={positions}
          onPositionsChange={onPositionsChange}
          scholarCwid={scholarCwid}
        />
      )}
    </>
  );
}
