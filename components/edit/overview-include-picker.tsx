/**
 * OverviewIncludePicker — the controlled checklists inside the Sources drawer
 * (#742 v3.1 §3.2). The scholar picks which **publications** and **funding**
 * awards ground their generated bio (and, once C3 lands the data, which
 * **methods**). A pure controlled surface: it owns no fetch and no open state —
 * the parent (`overview-source-drawer.tsx`) holds the {@link OverviewSourceOptions}
 * payload and the {@link OverviewSelection}; this renders them and emits the next
 * selection.
 *
 * Caps (v3.1 decision 3): publications + funding share a combined ceiling; at the
 * cap, unchecked boxes in those two sections disable. Tools carry their own
 * smaller ceiling. The server re-clamps both regardless (the trust boundary is
 * `normalizeOverviewSelection`).
 *
 * The Methods section is **hidden entirely** when `options.tools` is empty (it
 * ships dark until C3), so the picker degrades cleanly before the ETL exists.
 */
"use client";

import * as React from "react";
import { ExternalLink, Search } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  type OverviewSelection,
} from "@/lib/edit/overview-params";
import { cn } from "@/lib/utils";

type OverviewIncludePickerProps = {
  options: OverviewSourceOptions;
  selection: OverviewSelection;
  onChange: (next: OverviewSelection) => void;
  disabled?: boolean;
};

/** PubMed titles embed formatting tags (`<i>`, `<sub>`); strip them for the
 *  plain checkbox label so they don't render as literal angle-bracket text. */
function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

/** Toggle `value` in `list` (add if checked + absent, remove if unchecked). */
function toggle(list: string[], value: string, checked: boolean): string[] {
  const has = list.includes(value);
  if (checked === has) return list;
  return checked ? [...list, value] : list.filter((v) => v !== value);
}

export function OverviewIncludePicker({
  options,
  selection,
  onChange,
  disabled = false,
}: OverviewIncludePickerProps) {
  const [query, setQuery] = React.useState("");

  const pmidSet = React.useMemo(() => new Set(selection.pmids), [selection.pmids]);
  const grantSet = React.useMemo(() => new Set(selection.grantIds), [selection.grantIds]);
  const toolSet = React.useMemo(() => new Set(selection.toolNames), [selection.toolNames]);

  // Publications + funding share the combined budget; tools have their own.
  const itemsSelected = selection.pmids.length + selection.grantIds.length;
  const atItemCap = itemsSelected >= OVERVIEW_SELECTION_MAX_ITEMS;
  const atToolCap = selection.toolNames.length >= OVERVIEW_SELECTION_MAX_TOOLS;

  const filteredPubs = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.publications;
    return options.publications.filter(
      (p) => p.title.toLowerCase().includes(q) || (p.venue ?? "").toLowerCase().includes(q),
    );
  }, [options.publications, query]);

  const showTools = options.tools.length > 0;

  return (
    <div className="flex flex-col gap-5" data-testid="overview-include-picker">
      {/* --- Publications --- */}
      <section>
        <SectionHeader title="Publications" note="scored · impact desc" />
        <div className="border-apollo-border mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5">
          <Search className="text-muted-foreground size-3.5" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter your papers…"
            disabled={disabled}
            className="h-auto border-0 p-0 text-sm shadow-none focus-visible:ring-0"
            data-testid="overview-source-search"
            aria-label="Filter publications"
          />
        </div>
        {filteredPubs.length === 0 ? (
          <p className="text-muted-foreground py-1 text-xs">
            {options.publications.length === 0
              ? "No scored publications yet."
              : "No papers match your filter."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {filteredPubs.map((p) => {
              const checked = pmidSet.has(p.pmid);
              const marker =
                p.authorPosition === "first"
                  ? "first author"
                  : p.authorPosition === "last"
                    ? "last author"
                    : null;
              return (
                <li key={p.pmid}>
                  <label className="flex items-start gap-2.5 py-1.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      disabled={disabled || (!checked && atItemCap)}
                      onCheckedChange={(c) =>
                        onChange({
                          ...selection,
                          pmids: toggle(selection.pmids, p.pmid, c === true),
                        })
                      }
                      data-testid={`overview-source-pub-${p.pmid}`}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm">
                        {stripTags(p.title)}
                        <a
                          href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="View on PubMed"
                          className="text-[#185FA5]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {[p.venue, p.year].filter(Boolean).join(" ")}
                        {p.impact != null && ` · impact ${p.impact}`}
                        {marker && (
                          <>
                            {" · "}
                            <span className="text-apollo-green">{marker}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- Funding --- */}
      <section className="border-apollo-border border-t pt-4">
        <SectionHeader title="Funding" note="active awards · PI first" />
        {options.funding.length === 0 ? (
          <p className="text-muted-foreground py-1 text-xs">No active awards.</p>
        ) : (
          <ul className="flex flex-col">
            {options.funding.map((f) => {
              const checked = grantSet.has(f.id);
              return (
                <li key={f.id}>
                  <label className="flex items-start gap-2.5 py-1.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      disabled={disabled || (!checked && atItemCap)}
                      onCheckedChange={(c) =>
                        onChange({
                          ...selection,
                          grantIds: toggle(selection.grantIds, f.id, c === true),
                        })
                      }
                      data-testid={`overview-source-funding-${f.id}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{f.title ?? f.funder}</span>
                      <span className="text-muted-foreground text-xs">
                        {[f.role, f.funder, f.award].filter(Boolean).join(" · ")}
                        {f.endYear != null && ` · ends ${f.endYear}`}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- Methods (dark until C3 — hidden when there are no tools) --- */}
      {showTools && (
        <section
          className="border-apollo-border border-t pt-4"
          data-testid="overview-source-methods"
        >
          <div className="mb-2 flex items-center justify-between">
            <SectionHeader title="Methods" note="across your papers" inline />
            <span
              className={cn(
                "rounded-md px-2 py-0.5 text-xs font-medium",
                atToolCap
                  ? "bg-apollo-maroon/10 text-apollo-maroon"
                  : "bg-apollo-surface-2 text-muted-foreground",
              )}
              data-testid="overview-source-tools-counter"
            >
              {selection.toolNames.length} / {OVERVIEW_SELECTION_MAX_TOOLS}
            </span>
          </div>
          <ul className="flex flex-col">
            {options.tools.map((t) => {
              const checked = toolSet.has(t.toolName);
              return (
                <li key={t.toolName}>
                  <label className="flex items-start gap-2.5 py-1.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      disabled={disabled || (!checked && atToolCap)}
                      onCheckedChange={(c) =>
                        onChange({
                          ...selection,
                          toolNames: toggle(selection.toolNames, t.toolName, c === true),
                        })
                      }
                      data-testid={`overview-source-tool-${t.toolName}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{t.toolName}</span>
                      <span className="text-muted-foreground text-xs">
                        {[t.category, `used in ${t.pmidCount} papers`].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  note,
  inline = false,
}: {
  title: string;
  note: string;
  inline?: boolean;
}) {
  return (
    <div className={cn(!inline && "mb-2 flex items-center justify-between")}>
      <div className="text-muted-foreground text-sm font-medium">
        {title} <span className="text-muted-foreground/70 font-normal">· {note}</span>
      </div>
    </div>
  );
}
