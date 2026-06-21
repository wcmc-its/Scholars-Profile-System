"use client";

/**
 * #1166 Surface B — the master-detail cell-line rail on the method-family page, the
 * left column of the publications master-detail (the family-page analog of the
 * supercategory `FamilyRail`). Lists the specific cell lines the family resolves to,
 * usage_count-desc; selecting one sets the shared `?cellLine=<entityId>` filter that
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
import type { CellLineEntity } from "@/lib/api/methods";

export function CellLineRail({ entities }: { entities: CellLineEntity[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const active = searchParams.get("cellLine");

  const onSelect = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === null) params.delete("cellLine");
    else params.set("cellLine", id);
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
      // Punch #1 — only evidenced entities are selectable (an unevidenced one would
      // filter the feed to zero results). Unevidenced rows are plain labels.
      interactive: e.evidenced,
    };
  });

  return (
    <EntityRail
      items={items}
      activeId={active}
      onSelect={onSelect}
      railLabel="Cell lines"
      headerText={`CELL LINES (${entities.length})`}
      filterPlaceholder="Filter cell lines…"
      noMatchNoun="cell lines"
    />
  );
}
