"use client";

/**
 * #1166 Surface B (§5.6) — the all-cell-lines directory: a searchable, sortable
 * index of every named cell line a family resolves to, with differentiation forms
 * NESTED under a shared parent (e.g. the two 3T3-L1 forms under
 * "3T3-L1 · mouse fibroblast line · 2 forms"). Opened from the strip's "N more"
 * via `?dir=open` (URL-addressable, D4); selecting a row applies the shared
 * `?cellLine=` filter and closes the directory (spec §6 — one shared filter).
 *
 * Pure presentation over server-grouped `nodes` (groupCellLineDirectory); search +
 * sort are client-side. A parent group whose forms are all filtered out collapses.
 */
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CellLineDirectoryNode, CellLineEntity } from "@/lib/api/methods";

type SortMode = "use" | "az";

export function CellLineDirectory({
  nodes,
  familyLabel,
  entityCount,
  totalPapers,
}: {
  nodes: CellLineDirectoryNode[];
  familyLabel: string;
  entityCount: number;
  totalPapers: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("use");

  const select = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("cellLine", id);
    params.delete("dir");
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}#publications`, { scroll: false });
  };
  const close = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("dir");
    router.replace(params.toString() ? `${pathname}?${params.toString()}` : pathname, {
      scroll: false,
    });
  };

  const filtered = useMemo(() => filterAndSortNodes(nodes, query, sort), [nodes, query, sort]);
  const empty = filtered.length === 0;

  return (
    <section
      className="mb-10 rounded-[var(--border-radius-lg)] bg-[var(--color-background-secondary)] p-5"
      aria-labelledby="cell-line-directory-heading"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2
            id="cell-line-directory-heading"
            className="text-lg font-medium text-[var(--color-text-primary)]"
          >
            All cell lines used
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-text-secondary)]">
            {familyLabel} · {entityCount} cell {entityCount === 1 ? "line" : "lines"}
            {totalPapers > 0
              ? ` across ${totalPapers} ${totalPapers === 1 ? "paper" : "papers"}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="flex-none text-[13px] text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          ← Back to strip
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter cell lines…"
          aria-label="Filter cell lines"
          className="flex-1 rounded-md border-[0.5px] border-[var(--color-border-secondary)] bg-[var(--color-background-primary)] px-3 py-2 text-[13.5px] text-[var(--color-text-primary)]"
        />
        <span
          role="group"
          aria-label="Sort"
          className="inline-flex flex-none overflow-hidden rounded-full border-[0.5px] border-[var(--color-border-secondary)]"
        >
          {(["use", "az"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSort(m)}
              aria-pressed={sort === m}
              className={
                "px-3 py-1.5 text-[12.5px] " +
                (sort === m
                  ? "bg-[var(--color-background-info)] text-[var(--color-text-info)]"
                  : "text-[var(--color-text-secondary)]")
              }
            >
              {m === "use" ? "Most used" : "A–Z"}
            </button>
          ))}
        </span>
      </div>

      <div className="rounded-[var(--border-radius-lg)] border-[0.5px] border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] px-3 py-1.5">
        {empty ? (
          <p className="px-2 py-4 text-[13px] text-[var(--color-text-tertiary)]">
            No cell lines match that filter.
          </p>
        ) : (
          filtered.map((node, i) =>
            node.kind === "group" ? (
              <div key={node.parentEntityId}>
                {i > 0 && (
                  <div className="my-1.5 border-t-[0.5px] border-[var(--color-border-tertiary)]" />
                )}
                <div className="flex items-center gap-2 px-1 pt-2 pb-0.5">
                  <span className="text-[13.5px] font-medium text-[var(--color-text-primary)]">
                    {node.parentLabel}
                  </span>
                  <span className="text-[12px] text-[var(--color-text-tertiary)]">
                    {node.parentDescriptor ? `· ${node.parentDescriptor} ` : ""}· {node.forms.length}{" "}
                    forms
                  </span>
                </div>
                <div className="ml-1.5 border-l-2 border-[var(--color-border-tertiary)] pl-3.5">
                  {node.forms.map((f) => (
                    <DirectoryRow key={f.entityId} entity={f} onSelect={select} />
                  ))}
                </div>
              </div>
            ) : (
              <div key={node.entity.entityId}>
                {i > 0 && (
                  <div className="my-1.5 border-t-[0.5px] border-[var(--color-border-tertiary)]" />
                )}
                <DirectoryRow entity={node.entity} onSelect={select} />
              </div>
            ),
          )
        )}
      </div>

      <p className="flex items-start gap-1.5 px-0.5 pt-2 text-[11.5px] leading-[1.5] text-[var(--color-text-tertiary)]">
        Selecting a cell line filters the article list below to the papers using it.
      </p>
    </section>
  );
}

function DirectoryRow({
  entity,
  onSelect,
}: {
  entity: CellLineEntity;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entity.entityId)}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left hover:bg-[var(--color-background-secondary)]"
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--color-text-primary)]">
        {entity.label}
      </span>
      <span className="flex-none font-mono text-[12.5px] text-[var(--color-text-secondary)]">
        {entity.usageCount}
      </span>
      <span aria-hidden="true" className="flex-none text-[var(--color-text-tertiary)]">
        ↗
      </span>
    </button>
  );
}

/** Substring-filter rows (collapsing an emptied parent group) then sort within the
 *  surviving structure (groups by their rank metric; forms within a group). Pure. */
function filterAndSortNodes(
  nodes: CellLineDirectoryNode[],
  query: string,
  sort: SortMode,
): CellLineDirectoryNode[] {
  const q = query.trim().toLowerCase();
  const matches = (e: CellLineEntity) => !q || e.label.toLowerCase().includes(q);
  const byMode = (a: CellLineEntity, b: CellLineEntity) =>
    sort === "az" ? a.label.localeCompare(b.label) : b.usageCount - a.usageCount;

  const out: CellLineDirectoryNode[] = [];
  for (const node of nodes) {
    if (node.kind === "group") {
      const forms = node.forms.filter(matches).sort(byMode);
      if (forms.length > 0) out.push({ ...node, forms });
    } else if (matches(node.entity)) {
      out.push(node);
    }
  }
  const rankOf = (n: CellLineDirectoryNode) =>
    n.kind === "group" ? n.parentLabel.toLowerCase() : n.entity.label.toLowerCase();
  const useOf = (n: CellLineDirectoryNode) => (n.kind === "group" ? n.usageCount : n.entity.usageCount);
  return out.sort((a, b) => (sort === "az" ? rankOf(a).localeCompare(rankOf(b)) : useOf(b) - useOf(a)));
}
