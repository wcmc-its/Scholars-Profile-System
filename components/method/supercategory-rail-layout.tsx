"use client";

/**
 * Method category (supercategory) page body: the family rail + the family
 * panel, on the shared `RailLayout`. Selecting a family sets `?family=` (the
 * full family slug, e.g. `cancer-cell-lines-fam_0007`) on this page; with no
 * family selected the panel shows the recent "all work" list.
 *
 * `?family=` here is a within-supercategory-page deep-link param, DISTINCT from
 * the #819 per-scholar profile filter (a different route, a different flag).
 * `familyId` is re-minted on every A2 rebuild, so inbound values resolve by the
 * STABLE label-slug via `resolveFamilyParam` (#940); the written value is the
 * full slug, which that resolver accepts and which survives a rebuild.
 */
import { RailLayout } from "@/components/taxonomy/rail-layout";
import type { TaxonomyRailItem } from "@/components/taxonomy/taxonomy-rail";
import { FamilyPublicationFeed } from "@/components/method/publication-feed";
import { FamilyScholarsRow } from "@/components/method/family-scholars-row";
import {
  SCHOLAR_FILTER_PARAM,
  ScholarFilterChip,
  useScholarFilter,
} from "@/components/taxonomy/scholar-filter";
import { SupercategoryAllWorkFeed } from "@/components/method/supercategory-all-work-feed";
import { familySegmentFor, resolveFamilyParam } from "@/lib/method-url";
import { entityKindNounForCount } from "@/lib/methods/entity-kind-noun";
import type { MethodPublicationHit } from "@/lib/api/methods";

export type FamilyRailItem = {
  /** The opaque A2 family id (`fam_NNNN`). */
  familyId: string;
  /** Human family label, rendered as the row title. */
  familyLabel: string;
  /** Distinct-scholar count. Read aloud in the row's accessible label; the
   *  visible count is `pubCount`. */
  scholarCount: number;
  /** Distinct (#356-dark filtered) publication count, the value shown on the row. */
  pubCount: number;
  /** Up to ~3 representative member-tool display names (static exemplars). */
  exemplarTools: string[];
  /** Count of evidenced, non-generic specific entities in this family. Drives the
   *  enriched "View full method page" signpost; undefined/0 → plain copy. */
  entityCount?: number;
  /** Dominant entity-kind producer enum (e.g. "organism_or_cells"). */
  entityKind?: string | null;
};

/** familyId → panel metadata. `definition` is null whenever the definitions
 *  flag is off (`getSupercategoryRollup` populates it under the same gate as
 *  `getFamily`). */
export type FamilyPanelMeta = {
  familyLabel: string;
  familySegment: string;
  definition: string | null;
  definitionSource: string | null;
};

/** FamilyRailItem → the rail row: `pubCount` visible, both counts in the aria
 *  label, exemplar tools as a ` · `-joined descriptor. */
export function familyRailRow(f: FamilyRailItem): TaxonomyRailItem {
  return {
    id: f.familyId,
    label: f.familyLabel,
    descriptor: f.exemplarTools.length > 0 ? f.exemplarTools.join(" · ") : null,
    count: f.pubCount,
    countLabel: "pubs",
    ariaLabel: `${f.pubCount.toLocaleString()} publications, ${f.scholarCount.toLocaleString()} scholars`,
  };
}

export function SupercategoryRailLayout({
  supercategorySlug,
  supercategoryLabel,
  families,
  familyMeta,
  allWorkPubs,
  scholarFilter = false,
}: {
  supercategorySlug: string;
  supercategoryLabel: string;
  families: FamilyRailItem[];
  familyMeta: Record<string, FamilyPanelMeta>;
  /** Representative recent publications across all families, the default
   *  "all work" panel shown until a family is selected (§A2). */
  allWorkPubs: MethodPublicationHit[];
  /** TAXONOMY_SCHOLAR_CARDS — the selected family's scholars become
   *  pick-to-filter cards and the pick lives in `?scholar=`. */
  scholarFilter?: boolean;
}) {
  const items = families.map(familyRailRow);

  const segmentFor = (familyId: string) => {
    const meta = familyMeta[familyId];
    if (meta?.familySegment) return meta.familySegment;
    const label = meta?.familyLabel ?? families.find((f) => f.familyId === familyId)?.familyLabel;
    return label ? familySegmentFor(label, familyId) : familyId;
  };

  return (
    <RailLayout
      items={items}
      paramKey="family"
      resolveParam={(raw) => resolveFamilyParam(raw, families)}
      serializeParam={segmentFor}
      clearParamsOnChange={scholarFilter ? [SCHOLAR_FILTER_PARAM] : undefined}
      deepLinkScrollTargetId="families"
      idPrefix="families"
      rail={{
        railLabel: "Method families",
        headerText: `FAMILIES (${families.length})`,
        filterPlaceholder: "Filter families…",
        noMatchNoun: "families",
        // No count: summing the rail counts double-counts pubs in several
        // families, and no distinct category total is loaded (PLAN open Q10).
        allRow: { label: "All families" },
        variant: "captioned",
      }}
      mobile={{ eyebrow: "Family", allLabel: "All families" }}
      renderSubhead={(familyId) => {
        const meta = familyMeta[familyId];
        if (!meta?.familyLabel) return null;
        const label = meta.familyLabel;
        const segment = segmentFor(familyId);
        const item = families.find((f) => f.familyId === familyId);
        const entityCount = item?.entityCount ?? 0;
        return {
          title: label,
          body: (
            <>
              {/* #879: generated capability gloss, mirroring the standalone
                  family page. Em-dashes render verbatim (house style). */}
              {meta.definition && (
                <div className="mt-2 max-w-prose">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {meta.definition}
                  </p>
                  {meta.definitionSource === "generated" && (
                    <p className="mt-1 text-xs italic text-muted-foreground/80">
                      AI-generated definition
                    </p>
                  )}
                </div>
              )}
              {/* The rail click is an in-page deep link, not navigation, so
                  signpost the canonical family page explicitly; otherwise the
                  two surfaces read as accidental duplicates. */}
              <a
                href={`/methods/${encodeURIComponent(supercategorySlug)}/${encodeURIComponent(segment)}`}
                className="mt-1 inline-block text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
              >
                View full {label} method page
                {entityCount > 0
                  ? ` — ${entityCount.toLocaleString()} specific ${entityKindNounForCount(
                      item?.entityKind ?? null,
                      entityCount,
                    ).toLowerCase()} + per-paper usage →`
                  : " →"}
              </a>
            </>
          ),
        };
      }}
    >
      {(activeFamilyId) => {
        const label = activeFamilyId ? familyMeta[activeFamilyId]?.familyLabel ?? null : null;
        if (scholarFilter) {
          return (
            <FamilyScholarFilterPanel
              supercategorySlug={supercategorySlug}
              supercategoryLabel={supercategoryLabel}
              activeFamilyId={activeFamilyId && label ? activeFamilyId : null}
              familyLabel={label}
              familySegment={activeFamilyId && label ? segmentFor(activeFamilyId) : null}
              allWorkPubs={allWorkPubs}
            />
          );
        }
        if (!activeFamilyId || !label) {
          return <SupercategoryAllWorkFeed pubs={allWorkPubs} supercategoryLabel={supercategoryLabel} />;
        }
        return (
          <>
            <FamilyScholarsRow
              supercategorySlug={supercategorySlug}
              familyId={activeFamilyId}
              familyLabel={label}
            />
            <FamilyPublicationFeed
              supercategorySlug={supercategorySlug}
              familySegment={segmentFor(activeFamilyId)}
              familyLabel={label}
            />
          </>
        );
      }}
    </RailLayout>
  );
}

/** Flag-on panel: pick-to-filter family scholars + the filter chip + the feed.
 *  One component across both branches so the filter hook sees every change of
 *  selection (including back to "All families"). */
function FamilyScholarFilterPanel({
  supercategorySlug,
  supercategoryLabel,
  activeFamilyId,
  familyLabel,
  familySegment,
  allWorkPubs,
}: {
  supercategorySlug: string;
  supercategoryLabel: string;
  activeFamilyId: string | null;
  familyLabel: string | null;
  familySegment: string | null;
  allWorkPubs: MethodPublicationHit[];
}) {
  const filter = useScholarFilter(activeFamilyId);
  if (!activeFamilyId || !familyLabel || !familySegment) {
    return <SupercategoryAllWorkFeed pubs={allWorkPubs} supercategoryLabel={supercategoryLabel} />;
  }
  return (
    <>
      <FamilyScholarsRow
        supercategorySlug={supercategorySlug}
        familyId={activeFamilyId}
        familyLabel={familyLabel}
        pick={{
          selectedCwid: filter.selectedCwid,
          onToggle: filter.toggle,
          onRosterLoaded: filter.onRosterLoaded,
        }}
      />
      {filter.active && <ScholarFilterChip scholar={filter.active} onClear={filter.clear} />}
      <FamilyPublicationFeed
        supercategorySlug={supercategorySlug}
        familySegment={familySegment}
        familyLabel={familyLabel}
        scholarCwid={filter.active?.cwid ?? null}
      />
    </>
  );
}
