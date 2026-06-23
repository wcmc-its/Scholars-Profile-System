"use client";

/**
 * #1166 Surface B — the master-detail cell-line rail on the method-family page, the
 * left column of the publications master-detail (the family-page analog of the
 * supercategory `FamilyRail`). Lists the specific cell lines the family resolves to,
 * usage_count-desc; selecting one sets the shared `?entity=<entityId>` filter that
 * the publication feed reads (spec §6 — one shared, singular filter). No "All" row:
 * no selection ⇒ the full family list (the feed's default); clicking the active row
 * clears the filter back to the full list.
 *
 * Punch #1 — non-evidenced entities (no recorded verbatim usage fact) would yield an
 * empty feed if selected, so they render as PLAIN, non-interactive labels (no toggle)
 * rather than clickable rows. Rows still show label + descriptor + usage count.
 *
 * Pure presentation over a neutral <EntityRail>; the page server-assembles the
 * entities and passes them as serializable props.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EntityRail, type RailItem } from "@/components/method/entity-rail";
import { entityKindNoun } from "@/lib/methods/entity-kind-noun";
import type { CellLineEntity } from "@/lib/api/methods";

export function CellLineRail({ entities }: { entities: CellLineEntity[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const active = searchParams.get("entity");

  // #1168 — the rail noun comes from the family's dominant entity kind (all
  // entities in a family share it), so a reagent/instrument/dataset family reads
  // the right header instead of the cell-line-only "Cell lines" v1 shipped with.
  const noun = entityKindNoun(entities[0]?.dominantKind);
  const nounLower = noun.toLowerCase();

  const onSelect = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === null) params.delete("entity");
    else params.set("entity", id);
    // Reset the feed to page 1 on a filter change (mirrors the prior strip).
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}#publications` : `${pathname}#publications`, {
      scroll: false,
    });
  };

  const items: RailItem[] = entities.map((e) => {
    // Descriptor BENEATH the label: the lineage/organism display (e.g. "human
    // embryonic kidney"), preferring the curated descriptor over the bare parent.
    const descriptor = e.parentDescriptor ?? e.parentLabel ?? null;
    return {
      id: e.entityId,
      label: e.label,
      descriptor,
      count: e.usageCount,
      countLabel: "papers",
      ariaLabel: e.evidenced
        ? `${e.label}, ${e.usageCount.toLocaleString()} papers`
        : `${e.label}, ${e.usageCount.toLocaleString()} papers (no verbatim evidence recorded)`,
      // Punch #1 / #1168 WS-B — only evidenced, non-generic entities are selectable.
      // An unevidenced one would filter the feed to zero; a generic one ("macrophage
      // cell line") is a non-specific bucket. Both render as plain, non-clickable
      // rows (soft suppression — present in the list, not interactive).
      interactive: e.evidenced && !e.isGeneric,
    };
  });

  return (
    <EntityRail
      items={items}
      activeId={active}
      onSelect={onSelect}
      railLabel={noun}
      headerText={`${noun.toUpperCase()} (${entities.length})`}
      filterPlaceholder={`Filter ${nounLower}…`}
      noMatchNoun={nounLower}
    />
  );
}
