/**
 * OverviewIncludePicker — the controlled checklists inside the Sources drawer
 * (#742 v3.1 §3.2 / #875 §5 + §7 the confidence layer). The scholar picks which
 * **publications**, **funding** awards, and **methods** (their #799 method
 * families, #886) ground their generated bio. A pure controlled surface: it owns no
 * fetch and no open state — the parent (`overview-source-drawer.tsx`) holds the
 * {@link OverviewSourceOptions} payload and the {@link OverviewSelection}; this
 * renders them and emits the next selection.
 *
 * #875 §7 confidence layer:
 *   - Each section carries a verbatim §7.1 rule line (the *reassurance*) next to
 *     a labeled sort dropdown (§5, the *mechanic*) — they coexist.
 *   - Per-section quick actions: All · None · Top N by score (respecting caps,
 *     and for Methods the #765 §2 pmid_count >= 2 floor).
 *   - Selected-first ordering: checked items stable-partition to the top.
 *   - The §7.2 whitelist is the ONLY per-item signal shown — publications: role ·
 *     year · impact NUMBER; awards: role · year; methods: publication count. No
 *     model prose (`context` / `impactJustification` / `synopsis`) ever renders.
 *
 * Caps (v3.1 decision 3): publications + funding share a combined ceiling; at the
 * cap, unchecked boxes in those two sections disable. Tools carry their own
 * smaller ceiling. The server re-clamps both regardless (the trust boundary is
 * `normalizeOverviewSelection`).
 *
 * The Methods section is **hidden entirely** when `options.tools` is empty (the
 * scholar has no method families), so the picker degrades cleanly for scholars
 * without a `scholar_family` rollup.
 */
"use client";

import * as React from "react";
import { ExternalLink, Search } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type {
  OverviewSourceFunding,
  OverviewSourceOptions,
  OverviewSourcePublication,
} from "@/lib/edit/overview-facts";
import {
  OVERVIEW_METHOD_PMID_FLOOR,
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  type OverviewSelection,
} from "@/lib/edit/overview-params";
import { cn } from "@/lib/utils";

type ToolOption = OverviewSourceOptions["tools"][number];

type OverviewIncludePickerProps = {
  options: OverviewSourceOptions;
  selection: OverviewSelection;
  onChange: (next: OverviewSelection) => void;
  disabled?: boolean;
};

// §7.1 ranking rules — verbatim (Methods reuses the public Methods & tools copy).
const RULE_PUBLICATIONS =
  "Ranked by citation impact and recency, weighted toward senior-author work.";
const RULE_FUNDING = "Ranked by your role and recency.";
const RULE_METHODS =
  "Inferred from methods named in your publications · ranked by how often each appears.";

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

/** Stable-partition: pinned (selected) members first, original order preserved. */
function selectedFirst<T>(rows: T[], isSelected: (row: T) => boolean): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isSelected(row) ? pinned : rest).push(row);
  return [...pinned, ...rest];
}

type PubSort = "impact" | "year";

export function OverviewIncludePicker({
  options,
  selection,
  onChange,
  disabled = false,
}: OverviewIncludePickerProps) {
  const [query, setQuery] = React.useState("");
  const [pubSort, setPubSort] = React.useState<PubSort>("impact");

  const pmidSet = React.useMemo(() => new Set(selection.pmids), [selection.pmids]);
  const grantSet = React.useMemo(() => new Set(selection.grantIds), [selection.grantIds]);
  const toolSet = React.useMemo(() => new Set(selection.toolNames), [selection.toolNames]);

  // Publications + funding share the combined budget; tools have their own.
  const itemsSelected = selection.pmids.length + selection.grantIds.length;
  const atItemCap = itemsSelected >= OVERVIEW_SELECTION_MAX_ITEMS;
  const atToolCap = selection.toolNames.length >= OVERVIEW_SELECTION_MAX_TOOLS;

  const showTools = options.tools.length > 0;

  // --- Publications: filter, sort, then selected-first. ---
  const visiblePubs = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? options.publications.filter(
          (p) => p.title.toLowerCase().includes(q) || (p.venue ?? "").toLowerCase().includes(q),
        )
      : options.publications;
    const sorted = [...filtered].sort((a, b) =>
      pubSort === "impact"
        ? (b.impact ?? -Infinity) - (a.impact ?? -Infinity)
        : (b.year ?? -Infinity) - (a.year ?? -Infinity),
    );
    return selectedFirst(sorted, (p) => pmidSet.has(p.pmid));
  }, [options.publications, query, pubSort, pmidSet]);

  const visibleFunding = React.useMemo(
    () => selectedFirst(options.funding, (f) => grantSet.has(f.id)),
    [options.funding, grantSet],
  );
  const visibleTools = React.useMemo(
    () => selectedFirst(options.tools, (t) => toolSet.has(t.toolName)),
    [options.tools, toolSet],
  );

  // --- Quick actions: All / None / Top N by score, respecting caps + floors. ---
  // Combined budget for pubs+funding means the remaining room shifts per section.
  function selectAllPubs() {
    const room = OVERVIEW_SELECTION_MAX_ITEMS - selection.grantIds.length;
    onChange({ ...selection, pmids: options.publications.slice(0, room).map((p) => p.pmid) });
  }
  function topNPubs() {
    const room = OVERVIEW_SELECTION_MAX_ITEMS - selection.grantIds.length;
    const top = [...options.publications]
      .sort((a, b) => (b.impact ?? -Infinity) - (a.impact ?? -Infinity))
      .slice(0, Math.min(10, room))
      .map((p) => p.pmid);
    onChange({ ...selection, pmids: top });
  }
  function clearPubs() {
    onChange({ ...selection, pmids: [] });
  }

  function selectAllFunding() {
    const room = OVERVIEW_SELECTION_MAX_ITEMS - selection.pmids.length;
    onChange({ ...selection, grantIds: options.funding.slice(0, room).map((f) => f.id) });
  }
  function topNFunding() {
    const room = OVERVIEW_SELECTION_MAX_ITEMS - selection.pmids.length;
    // Funding arrives role-then-recency ordered; the top N is the leading slice.
    onChange({
      ...selection,
      grantIds: options.funding.slice(0, Math.min(10, room)).map((f) => f.id),
    });
  }
  function clearFunding() {
    onChange({ ...selection, grantIds: [] });
  }

  function selectAllTools() {
    onChange({
      ...selection,
      toolNames: options.tools.slice(0, OVERVIEW_SELECTION_MAX_TOOLS).map((t) => t.toolName),
    });
  }
  function topNTools() {
    // Top N by pmidCount, honoring the #765 §2 floor (>= 2 publications).
    const top = [...options.tools]
      .filter((t) => t.pmidCount >= OVERVIEW_METHOD_PMID_FLOOR)
      .sort((a, b) => b.pmidCount - a.pmidCount)
      .slice(0, OVERVIEW_SELECTION_MAX_TOOLS)
      .map((t) => t.toolName);
    onChange({ ...selection, toolNames: top });
  }
  function clearTools() {
    onChange({ ...selection, toolNames: [] });
  }

  return (
    <div className="flex flex-col gap-5" data-testid="overview-include-picker">
      {/* --- Publications --- */}
      <section>
        <SectionHeader
          title="Publications"
          rule={RULE_PUBLICATIONS}
          sort={
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Sort:</span>
              <select
                value={pubSort}
                disabled={disabled}
                onChange={(e) => setPubSort(e.target.value as PubSort)}
                className="border-apollo-border-strong bg-apollo-surface rounded px-1.5 py-0.5 text-xs"
                data-testid="overview-source-pub-sort"
                aria-label="Sort publications"
              >
                <option value="impact">Impact (high→low)</option>
                <option value="year">Year (newest)</option>
              </select>
            </label>
          }
        />
        <QuickActions
          section="pub"
          onAll={selectAllPubs}
          onNone={clearPubs}
          onTopN={topNPubs}
          disabled={disabled}
        />
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
        {visiblePubs.length === 0 ? (
          <p className="text-muted-foreground py-1 text-xs">
            {options.publications.length === 0
              ? "No scored publications yet."
              : "No papers match your filter."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {visiblePubs.map((p) => (
              <PublicationRow
                key={p.pmid}
                pub={p}
                checked={pmidSet.has(p.pmid)}
                disabled={disabled || (!pmidSet.has(p.pmid) && atItemCap)}
                onToggle={(c) =>
                  onChange({ ...selection, pmids: toggle(selection.pmids, p.pmid, c) })
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* --- Funding --- */}
      <section className="border-apollo-border border-t pt-4">
        <SectionHeader title="Funding" rule={RULE_FUNDING} />
        <QuickActions
          section="funding"
          onAll={selectAllFunding}
          onNone={clearFunding}
          onTopN={topNFunding}
          disabled={disabled}
        />
        {options.funding.length === 0 ? (
          <p className="text-muted-foreground py-1 text-xs">No active awards.</p>
        ) : (
          <ul className="flex flex-col">
            {visibleFunding.map((f) => (
              <FundingRow
                key={f.id}
                funding={f}
                checked={grantSet.has(f.id)}
                disabled={disabled || (!grantSet.has(f.id) && atItemCap)}
                onToggle={(c) =>
                  onChange({ ...selection, grantIds: toggle(selection.grantIds, f.id, c) })
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* --- Methods (dark until C3 — hidden when there are no tools) --- */}
      {showTools && (
        <section
          className="border-apollo-border border-t pt-4"
          data-testid="overview-source-methods"
        >
          <div className="mb-1 flex items-start justify-between gap-2">
            <SectionHeader title="Methods" rule={RULE_METHODS} inline />
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-xs font-medium",
                atToolCap
                  ? "bg-apollo-maroon/10 text-apollo-maroon"
                  : "bg-apollo-surface-2 text-muted-foreground",
              )}
              data-testid="overview-source-tools-counter"
            >
              {selection.toolNames.length} / {OVERVIEW_SELECTION_MAX_TOOLS}
            </span>
          </div>
          <QuickActions
            section="tool"
            onAll={selectAllTools}
            onNone={clearTools}
            onTopN={topNTools}
            disabled={disabled}
          />
          <ul className="flex flex-col">
            {visibleTools.map((t) => (
              <ToolRow
                key={t.toolName}
                tool={t}
                checked={toolSet.has(t.toolName)}
                disabled={disabled || (!toolSet.has(t.toolName) && atToolCap)}
                onToggle={(c) =>
                  onChange({ ...selection, toolNames: toggle(selection.toolNames, t.toolName, c) })
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows — each shows ONLY the §7.2 whitelist signals.
// ---------------------------------------------------------------------------

/** Publication row (§7.2): authorship role · year · impact NUMBER. The title +
 *  venue stay as the item identity; no synopsis / impactJustification prose. */
function PublicationRow({
  pub,
  checked,
  disabled,
  onToggle,
}: {
  pub: OverviewSourcePublication;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const role =
    pub.authorPosition === "first"
      ? "first author"
      : pub.authorPosition === "last"
        ? "last author"
        : null;
  const signals = [role, pub.year != null ? String(pub.year) : null, pub.impact != null ? `impact ${pub.impact}` : null].filter(
    Boolean,
  );
  return (
    <li>
      <label className="flex items-start gap-2.5 py-1.5">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(c) => onToggle(c === true)}
          data-testid={`overview-source-pub-${pub.pmid}`}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm">
            {stripTags(pub.title)}
            <a
              href={`https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`}
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
            {pub.venue ? `${pub.venue} · ` : ""}
            {signals.join(" · ")}
          </span>
        </span>
      </label>
    </li>
  );
}

/** Funding row (§7.2): role · year. The project title / funder stays as the
 *  item identity; no dollar amount surfaces. */
function FundingRow({
  funding,
  checked,
  disabled,
  onToggle,
}: {
  funding: OverviewSourceFunding;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const signals = [funding.role, funding.endYear != null ? String(funding.endYear) : null].filter(
    Boolean,
  );
  return (
    <li>
      <label className="flex items-start gap-2.5 py-1.5">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(c) => onToggle(c === true)}
          data-testid={`overview-source-funding-${funding.id}`}
        />
        <span className="min-w-0">
          <span className="block text-sm">{funding.title ?? funding.funder}</span>
          <span className="text-muted-foreground text-xs">{signals.join(" · ")}</span>
        </span>
      </label>
    </li>
  );
}

/** Method row (§7.2): publication count only. The family label is the identity. */
function ToolRow({
  tool,
  checked,
  disabled,
  onToggle,
}: {
  tool: ToolOption;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <li>
      <label className="flex items-start gap-2.5 py-1.5">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(c) => onToggle(c === true)}
          data-testid={`overview-source-tool-${tool.toolName}`}
        />
        <span className="min-w-0">
          <span className="block text-sm">{tool.toolName}</span>
          <span className="text-muted-foreground text-xs">
            {tool.pmidCount} {tool.pmidCount === 1 ? "publication" : "publications"}
          </span>
        </span>
      </label>
    </li>
  );
}

/** All · None · Top 10 by score — the per-section quick actions. */
function QuickActions({
  section,
  onAll,
  onNone,
  onTopN,
  disabled,
}: {
  section: string;
  onAll: () => void;
  onNone: () => void;
  onTopN: () => void;
  disabled: boolean;
}) {
  const cls = "text-apollo-maroon text-xs font-medium hover:underline disabled:opacity-50";
  return (
    <div className="mb-2 flex items-center gap-3" data-testid={`overview-source-quick-${section}`}>
      <button
        type="button"
        onClick={onAll}
        disabled={disabled}
        className={cls}
        data-testid={`overview-source-all-${section}`}
      >
        All
      </button>
      <button
        type="button"
        onClick={onNone}
        disabled={disabled}
        className={cls}
        data-testid={`overview-source-none-${section}`}
      >
        None
      </button>
      <button
        type="button"
        onClick={onTopN}
        disabled={disabled}
        className={cls}
        data-testid={`overview-source-topn-${section}`}
      >
        Top 10 by score
      </button>
    </div>
  );
}

/** A section header carrying the §7.1 rule line + an optional sort control. */
function SectionHeader({
  title,
  rule,
  sort,
  inline = false,
}: {
  title: string;
  rule: string;
  sort?: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={cn(!inline && "mb-2")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground text-sm font-medium">{title}</span>
        {sort}
      </div>
      <p className="text-muted-foreground text-xs" data-testid={`overview-source-rule-${title.toLowerCase()}`}>
        {rule}
      </p>
    </div>
  );
}
