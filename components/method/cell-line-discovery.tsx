"use client";

/**
 * #1166 Surface B — the cell-line discovery block on the method-family page. Shows
 * the ranked strip (§5.2) by default and swaps to the all-cell-lines directory
 * (§5.6) when `?dir=open` (URL-addressable, D4). Both views share the `?cellLine=`
 * filter that the publication feed reads (spec §6 — one shared, singular filter).
 *
 * The page server-computes the data (entities, rail previews, grouped directory
 * nodes) and passes it down; only TYPE imports cross into this client component.
 */
import { useSearchParams } from "next/navigation";
import { CellLineStrip } from "@/components/method/cell-line-strip";
import { CellLineDirectory } from "@/components/method/cell-line-directory";
import type {
  CellLineDirectoryNode,
  CellLineEntity,
  CellLineRailPreview,
} from "@/lib/api/methods";

export function CellLineDiscovery({
  entities,
  railPreviews,
  directoryNodes,
  familyLabel,
  totalPapers,
}: {
  entities: CellLineEntity[];
  railPreviews: Record<string, CellLineRailPreview>;
  directoryNodes: CellLineDirectoryNode[];
  familyLabel: string;
  totalPapers: number;
}) {
  const open = useSearchParams().get("dir") === "open";
  return open ? (
    <CellLineDirectory
      nodes={directoryNodes}
      familyLabel={familyLabel}
      entityCount={entities.length}
      totalPapers={totalPapers}
    />
  ) : (
    <CellLineStrip entities={entities} railPreviews={railPreviews} />
  );
}
