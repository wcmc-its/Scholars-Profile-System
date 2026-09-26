"use client";

/**
 * #1166 Surface B: the method family page's master-detail, on the shared
 * `RailLayout`. The rail lists the specific entities (cell lines, reagents,
 * instruments, … per #1168's dominant kind) the family resolves to,
 * usage_count-desc; selecting one sets the shared `?entity=<entityId>` filter
 * that the publication feed reads (spec §6, one shared singular filter). No
 * "All" row and no subhead (the feed's own context-bar chip names and clears
 * the active entity); clicking the active row clears the filter.
 *
 * Non-evidenced or generic entities render as plain, non-interactive rows
 * (punch #1 / #1168 WS-B): selecting one would yield an empty or meaningless
 * feed.
 */
import { RailLayout } from "@/components/taxonomy/rail-layout";
import type { TaxonomyRailItem } from "@/components/taxonomy/taxonomy-rail";
import { FamilyPublicationLayout } from "@/components/method/family-publication-layout";
import { entityKindNoun } from "@/lib/methods/entity-kind-noun";
import type { CellLineEntity } from "@/lib/api/methods";

/** CellLineEntity → rail row: lineage/organism descriptor beneath the label,
 *  usage count captioned "papers", selectable only when evidenced + specific. */
export function entityRailRow(e: CellLineEntity): TaxonomyRailItem {
  return {
    id: e.entityId,
    label: e.label,
    descriptor: e.parentDescriptor ?? e.parentLabel ?? null,
    count: e.usageCount,
    countLabel: "papers",
    ariaLabel: e.evidenced
      ? `${e.label}, ${e.usageCount.toLocaleString()} papers`
      : `${e.label}, ${e.usageCount.toLocaleString()} papers (no verbatim evidence recorded)`,
    interactive: e.evidenced && !e.isGeneric,
  };
}

export function FamilyEntityRailLayout({
  entities,
  supercategorySlug,
  familySegment,
  familyLabel,
  cellLineLabels,
}: {
  entities: CellLineEntity[];
  supercategorySlug: string;
  familySegment: string;
  familyLabel: string;
  cellLineLabels: Record<string, string>;
}) {
  // #1168: the noun follows the family's dominant entity kind (shared by all
  // entities in a family), so a reagent family doesn't read "Cell lines".
  const noun = entityKindNoun(entities[0]?.dominantKind);
  const nounLower = noun.toLowerCase();

  return (
    <RailLayout
      items={entities.map(entityRailRow)}
      paramKey="entity"
      // Reset the feed to page 1 on a filter change and keep the section anchor.
      clearParamsOnChange={["page"]}
      urlHash="publications"
      idPrefix="publications"
      rail={{
        railLabel: noun,
        headerText: `${noun.toUpperCase()} (${entities.length})`,
        filterPlaceholder: `Filter ${nounLower}…`,
        noMatchNoun: nounLower,
        variant: "captioned",
      }}
      mobile={{ eyebrow: noun, allLabel: `All ${nounLower}` }}
    >
      {() => (
        <FamilyPublicationLayout
          supercategorySlug={supercategorySlug}
          familySegment={familySegment}
          familyLabel={familyLabel}
          cellLineLabels={cellLineLabels}
          embedded
        />
      )}
    </RailLayout>
  );
}
