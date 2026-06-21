"use client";

/**
 * #1166 Surface B (§5.2/§5.3) — the ranked "Specific cell lines used" strip + the
 * persistent verbatim rail, on the method-family page. Replaces the #1119 prose
 * "How researchers use these tools" block when the family resolves to specific
 * cell-line entities (the page chooses).
 *
 * Single-select (RADIO) by design — DELIBERATELY different from Surface A's
 * checkbox/multi-select (spec §8 hard rule: do not unify the control). The
 * selection is the shared, URL-addressable filter (`?cellLine=<id>`, spec §6/D4):
 * the strip, the directory, and the feed's context-bar chip all reflect and mutate
 * the same param. Hover/focus only PREVIEWS the verbatim sentence in the rail (no
 * commit); a click toggles the filter and the feed (publication-feed.tsx, reading
 * the same param) reveals the per-(pub × entity) snippet on each matching paper.
 *
 * "N more cell lines" opens the all-cell-lines directory (§5.6) via `?dir=open`.
 */
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { ProvenanceRail, type ProvenanceRailItem } from "@/components/method/provenance-rail";
import type { CellLineEntity, CellLineRailPreview } from "@/lib/api/methods";

/** How many ranked rows the compact strip shows before the directory takes over. */
const STRIP_CAP = 7;
const RAIL_EYEBROW = "Verbatim, from a paper using it";

export function CellLineStrip({
  entities,
  railPreviews,
}: {
  /** The family's specific cell lines, usage_count-desc (the full set; capped here). */
  entities: CellLineEntity[];
  /** Best (highest-centrality) sentence per evidenced entity, for the hover rail. */
  railPreviews: Record<string, CellLineRailPreview>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { open: openModal } = usePublicationModal();

  const active = searchParams.get("cellLine");
  const shown = entities.slice(0, STRIP_CAP);
  const moreCount = entities.length - shown.length;
  const maxCount = entities.reduce((m, e) => Math.max(m, e.usageCount), 0) || 1;

  // The rail previews the hovered/focused entity; before any interaction it shows
  // the active filter, else the top-ranked entity (the strip's natural default).
  const [hovered, setHovered] = useState<string | null>(null);
  const railId = hovered ?? active ?? shown[0]?.entityId ?? null;

  const setParam = (next: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    // Reset the feed to page 1 on a filter change.
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}#publications` : `${pathname}#publications`, {
      scroll: false,
    });
  };

  const toggle = (id: string) => setParam({ cellLine: active === id ? null : id });

  const railItem: ProvenanceRailItem | null = useMemo(() => {
    if (!railId) return null;
    const entity = entities.find((e) => e.entityId === railId);
    if (!entity) return null;
    const preview = railPreviews[railId];
    if (!preview) {
      return {
        eyebrow: "Where it appears",
        term: entity.label,
        sentence: "No verbatim sentence is recorded for this cell line yet.",
        matchedSpan: null,
        source: null,
      };
    }
    return {
      eyebrow: RAIL_EYEBROW,
      term: entity.label,
      sentence: preview.sentence,
      matchedSpan: preview.matchedSpan,
      source: { label: "Source publication", onSelect: () => openModal(preview.pmid) },
    };
  }, [railId, entities, railPreviews, openModal]);

  return (
    <section
      className="mb-10 rounded-[var(--border-radius-lg)] bg-[var(--color-background-secondary)] p-5"
      aria-labelledby="cell-line-strip-heading"
    >
      <div className="mb-3">
        <h2
          id="cell-line-strip-heading"
          className="text-lg font-medium text-[var(--color-text-primary)]"
        >
          Specific cell lines used
        </h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-text-secondary)]">
          The named cell lines this method resolves to across these papers · select one to filter
          the list below.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,1fr)_236px]">
        {/* The ranked radio strip. */}
        <div className="rounded-[var(--border-radius-lg)] border-[0.5px] border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-1.5">
          <ul role="radiogroup" aria-label="Specific cell lines">
            {shown.map((e) => {
              const on = active === e.entityId;
              return (
                <li key={e.entityId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => toggle(e.entityId)}
                    onMouseEnter={() => setHovered(e.entityId)}
                    onFocus={() => setHovered(e.entityId)}
                    onMouseLeave={() => setHovered(null)}
                    className={
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--color-background-secondary)]" +
                      (on ? " bg-[var(--color-background-info)]" : "")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "box-border h-3.5 w-3.5 flex-none rounded-full " +
                        (on
                          ? "border-4 border-[var(--color-text-info)]"
                          : "border-[1.5px] border-[var(--color-border-primary)]")
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          "block truncate text-[13.5px] font-medium " +
                          (on
                            ? "text-[var(--color-text-info)]"
                            : "text-[var(--color-text-primary)]")
                        }
                      >
                        {e.label}
                      </span>
                      <span className="mt-[5px] block h-[3px] max-w-[130px] overflow-hidden rounded-full bg-[var(--color-border-tertiary)]">
                        <span
                          className={
                            "block h-full rounded-full " +
                            (on
                              ? "bg-[var(--color-text-info)]"
                              : "bg-[var(--color-text-tertiary)]")
                          }
                          style={{ width: `${Math.round((e.usageCount / maxCount) * 100)}%` }}
                        />
                      </span>
                    </span>
                    <span
                      className={
                        "flex-none font-mono text-[13px] " +
                        (on ? "text-[var(--color-text-info)]" : "text-[var(--color-text-secondary)]")
                      }
                    >
                      {e.usageCount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {moreCount > 0 && (
            <button
              type="button"
              onClick={() => setParam({ dir: "open" })}
              className="mt-[3px] flex w-full items-center gap-1.5 border-t-[0.5px] border-[var(--color-border-tertiary)] px-2.5 py-2.5 text-[12.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              <span aria-hidden="true">▾</span>
              {moreCount} more cell {moreCount === 1 ? "line" : "lines"}
            </button>
          )}
        </div>

        {/* The persistent verbatim rail (reused from Surface A). */}
        <ProvenanceRail
          item={railItem}
          className="bg-[var(--color-background-primary)]"
          placeholder="Hover a cell line to preview the verbatim sentence it came from."
        />
      </div>
    </section>
  );
}
