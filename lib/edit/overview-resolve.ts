/**
 * Client-safe resolver between the durable three-state DELTAS (#742 §2.5) and the
 * snapshot {@link OverviewSelection} the generate route consumes.
 *
 * Phase 2 wires the drawer to edit `OverviewSelectionDeltas` (pinned / excluded /
 * toggles), persisted via `/api/edit/overview/selection`. The generation path,
 * the §6 pre-generation hints, and the source-count readout still speak the
 * resolved snapshot — so the consumer derives one from the auto-set + the deltas
 * with {@link resolveOverviewSelection}, and maps a restored snapshot back to
 * deltas (#765 "Use these settings") with {@link selectionToDeltas}.
 *
 * `import type` only from `overview-facts` — the value side pulls in the Prisma
 * server module, and this runs in the browser bundle.
 */
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  normalizeOverviewSelectionDeltas,
  type OverviewSelection,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";

/** Resolve one type's effective id list: pins first (so a deliberate pin survives
 *  the downstream cap), then the recommended default order, minus any veto. A pin
 *  that no longer matches a candidate is dropped (a stale durable delta). */
function resolveIds(
  candidateIds: string[],
  defaultIds: string[],
  pinned: string[] | undefined,
  excluded: string[] | undefined,
): string[] {
  const candidates = new Set(candidateIds);
  const excl = new Set(excluded ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of pinned ?? []) {
    if (!candidates.has(id) || excl.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of defaultIds) {
    if (excl.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The resolved snapshot the generator consumes: the recommended auto-set
 *  (`defaultSelected`) with the scholar's pins layered in (first) and vetoes
 *  removed. With empty deltas this equals the pure default selection. */
export function resolveOverviewSelection(
  options: OverviewSourceOptions,
  deltas: OverviewSelectionDeltas,
): OverviewSelection {
  return {
    pmids: resolveIds(
      options.publications.map((p) => p.pmid),
      options.publications.filter((p) => p.defaultSelected).map((p) => p.pmid),
      deltas.pinned.publication,
      deltas.excluded.publication,
    ),
    grantIds: resolveIds(
      options.funding.map((f) => f.id),
      options.funding.filter((f) => f.defaultSelected).map((f) => f.id),
      deltas.pinned.funding,
      deltas.excluded.funding,
    ),
    toolNames: resolveIds(
      options.tools.map((t) => t.toolName),
      options.tools.filter((t) => t.defaultSelected).map((t) => t.toolName),
      deltas.pinned.method,
      deltas.excluded.method,
    ),
  };
}

/** One type's delta diff of a target snapshot against the current auto-set:
 *  a kept non-default record becomes a pin; a dropped default becomes a veto. */
function diffType(
  candidateIds: string[],
  defaultIds: string[],
  selectedIds: string[],
): { pinned: string[]; excluded: string[] } {
  const selected = new Set(selectedIds);
  const def = new Set(defaultIds);
  const pinned: string[] = [];
  const excluded: string[] = [];
  for (const id of candidateIds) {
    if (selected.has(id) && !def.has(id)) pinned.push(id);
    else if (!selected.has(id) && def.has(id)) excluded.push(id);
  }
  return { pinned, excluded };
}

/**
 * Map a resolved snapshot back to deltas against the current auto-set — the #765
 * "Use these settings" restore in the deltas world. Position toggles carry over
 * from `base` (a snapshot doesn't encode them). The result is normalized so empty
 * bags drop out and the status line reads correctly.
 */
export function selectionToDeltas(
  options: OverviewSourceOptions,
  selection: OverviewSelection,
  base: OverviewSelectionDeltas,
): OverviewSelectionDeltas {
  const pub = diffType(
    options.publications.map((p) => p.pmid),
    options.publications.filter((p) => p.defaultSelected).map((p) => p.pmid),
    selection.pmids,
  );
  const fund = diffType(
    options.funding.map((f) => f.id),
    options.funding.filter((f) => f.defaultSelected).map((f) => f.id),
    selection.grantIds,
  );
  const meth = diffType(
    options.tools.map((t) => t.toolName),
    options.tools.filter((t) => t.defaultSelected).map((t) => t.toolName),
    selection.toolNames,
  );
  return normalizeOverviewSelectionDeltas({
    pinned: { publication: pub.pinned, funding: fund.pinned, method: meth.pinned },
    excluded: { publication: pub.excluded, funding: fund.excluded, method: meth.excluded },
    publicationPositions: base.publicationPositions,
    fundingRoles: base.fundingRoles,
  });
}
