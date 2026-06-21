"use client";

/**
 * Family rail for the supercategory page (the `subtopic-rail` analog). Lists the
 * supercategory's publicly-visible families; selecting one sets `?family=fam_NNNN`
 * on the supercategory page and drives the right content panel.
 *
 * Distinct from the #819 per-scholar `?family=` filter, which lives on a PROFILE
 * route, not `/methods`. This rail's `?family=` is a within-supercategory-page
 * deep-link param (a different surface, a different flag — §OQ-9).
 *
 * This is now a thin adapter over the neutral <EntityRail> (shared with the family
 * page's cell-line rail): it maps each FamilyRailItem onto the generic RailItem and
 * supplies the family-specific copy. The visible/aria contract is unchanged — the
 * visible number is `pubCount`, the (never-shown) `scholarCount` rides along only in
 * the aria-label, exemplarTools render as a ` · `-joined descriptor line, and a row
 * click fires onSelect(familyId). Families arrive pre-sorted.
 */
import { EntityRail, type RailItem } from "@/components/method/entity-rail";

export type FamilyRailItem = {
  /** The opaque A2 family id (`fam_NNNN`) — the `?family=` deep-link value. */
  familyId: string;
  /** Human family label, rendered as the row title. */
  familyLabel: string;
  /** Distinct-scholar count (additive/accurate `_count.cwid`). Kept for the
   *  row's accessible label; the visible count is `pubCount`. */
  scholarCount: number;
  /** Distinct (#356-dark filtered) publication count — the value shown on the row. */
  pubCount: number;
  /** Up to ~3 representative member-tool display names (static exemplars). */
  exemplarTools: string[];
};

export function FamilyRail({
  families,
  activeFamilyId,
  onSelect,
}: {
  families: FamilyRailItem[];
  activeFamilyId: string | null;
  onSelect: (familyId: string | null) => void;
}) {
  const items: RailItem[] = families.map((f) => ({
    id: f.familyId,
    label: f.familyLabel,
    descriptor: f.exemplarTools.length > 0 ? f.exemplarTools.join(" · ") : null,
    count: f.pubCount,
    countLabel: "pubs",
    ariaLabel: `${f.pubCount.toLocaleString()} publications, ${f.scholarCount.toLocaleString()} scholars`,
  }));

  return (
    <EntityRail
      items={items}
      activeId={activeFamilyId}
      onSelect={onSelect}
      railLabel="Method families"
      headerText={`FAMILIES (${families.length})`}
      filterPlaceholder="Filter families…"
      noMatchNoun="families"
    />
  );
}
