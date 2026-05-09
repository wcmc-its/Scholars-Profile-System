"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  deriveAuthorPositionRole,
  matchesAnyPosition,
  matchesPositionFilter,
  type PositionFilter,
  type SelectedPositions,
} from "@/components/profile/author-position-badge";
import { PublicationRow } from "@/components/profile/publication-row";
import { groupPublicationsByYear } from "@/lib/profile-pub-grouping";
import type { ProfilePublication } from "@/lib/api/profile";

/**
 * Map publicationType strings (verbatim from PubMed via ReciterDB) to filter
 * chip buckets. Issue #72 trims this to a binary axis: "everything" vs
 * "research articles only." Reviews, editorials, and the long-tail types
 * still surface under All; they're just not isolatable on their own.
 */
type Bucket = "all" | "article";

function bucketOf(publicationType: string | null): Bucket | null {
  if (publicationType === "Academic Article") return "article";
  return null;
}

const BUCKET_ORDER: ReadonlyArray<{ key: Bucket; label: string }> = [
  { key: "all", label: "All" },
  { key: "article", label: "Research Articles" },
];

type NonAllPosition = Exclude<PositionFilter, "all">;

const POSITION_OPTIONS: ReadonlyArray<{ key: NonAllPosition; label: string }> = [
  { key: "first", label: "First author" },
  { key: "senior", label: "Senior author" },
  { key: "co_author", label: "Co-author" },
];

const POSITION_SHORT_LABEL: Record<NonAllPosition, string> = {
  first: "First author",
  senior: "Senior author",
  co_author: "Co-author",
};

export function PublicationsSection({
  publications,
  filterActive = false,
  positions = [],
  onPositionsChange,
}: {
  publications: ProfilePublication[];
  /** Set by `<ProfilePubsCluster>` when a topic filter is active. Expands
   *  every year-group within the last 10 years (per the published max year)
   *  on top of the default "first group only" behavior, so users browsing a
   *  filtered set don't have to click open year after year (issue #73). */
  filterActive?: boolean;
  /** Author-position filter (#72, multi-select via #77) — controlled by the
   *  cluster wrapper so the active-filter banner can compose position with
   *  topic. Empty array = no position filter. */
  positions?: SelectedPositions;
  onPositionsChange?: (next: SelectedPositions) => void;
}) {
  const [bucket, setBucket] = useState<Bucket>("all");
  const [query, setQuery] = useState("");

  // Per-position counts over the full input set — they don't shift as the
  // user toggles the type chip or the search box. Same stability principle
  // as the keyword pill counts (#73): the dropdown reflects "what would
  // match if I picked this position alone", not the post-intersection size.
  const positionCounts = useMemo(() => {
    const c: Record<NonAllPosition, number> = { first: 0, senior: 0, co_author: 0 };
    for (const p of publications) {
      const role = deriveAuthorPositionRole(p.authorship, p.wcmAuthors);
      if (matchesPositionFilter(role, "first")) c.first += 1;
      if (matchesPositionFilter(role, "senior")) c.senior += 1;
      if (matchesPositionFilter(role, "co_author")) c.co_author += 1;
    }
    return c;
  }, [publications]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      all: publications.length,
      article: 0,
    };
    for (const p of publications) {
      const b = bucketOf(p.publicationType);
      if (b !== null) c[b] += 1;
    }
    return c;
  }, [publications]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return publications.filter((p) => {
      if (bucket !== "all" && bucketOf(p.publicationType) !== bucket) return false;
      if (positions.length > 0) {
        const role = deriveAuthorPositionRole(p.authorship, p.wcmAuthors);
        if (!matchesAnyPosition(role, positions)) return false;
      }
      if (q.length === 0) return true;
      const hay =
        (p.title ?? "") +
        " " +
        (p.journal ?? "") +
        " " +
        (p.authorsString ?? "");
      return hay.toLowerCase().includes(q);
    });
  }, [publications, bucket, positions, query]);

  const searchActive = query.trim().length > 0;

  const pubGroups = useMemo(() => groupPublicationsByYear(filtered), [filtered]);

  // For filterActive: expand every year-group whose latest year is within 10
  // of the most recent year in the filtered set. Individual-year groups use
  // their year directly; bucket groups use their `bucketEnd`. Undated groups
  // never auto-open.
  const recentGroupKeys = useMemo(() => {
    if (!filterActive || pubGroups.length === 0) return new Set<string>();
    let maxYear = 0;
    for (const g of pubGroups) {
      const y = g.key.startsWith("y")
        ? Number(g.key.slice(1))
        : g.key.startsWith("b")
          ? Number(g.key.split("-").pop())
          : NaN;
      if (Number.isFinite(y) && y > maxYear) maxYear = y;
    }
    if (maxYear === 0) return new Set<string>();
    const threshold = maxYear - 9;
    const keys = new Set<string>();
    for (const g of pubGroups) {
      const latestInGroup = g.key.startsWith("y")
        ? Number(g.key.slice(1))
        : g.key.startsWith("b")
          ? Number(g.key.split("-").pop())
          : NaN;
      if (Number.isFinite(latestInGroup) && latestInGroup >= threshold) {
        keys.add(g.key);
      }
    }
    return keys;
  }, [pubGroups, filterActive]);

  return (
    <>
      {/* Toolbar: type chips + search */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-4">
        {BUCKET_ORDER.map(({ key, label }) => {
          if (key !== "all" && counts[key] === 0) return null;
          const active = bucket === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setBucket(key)}
              className={
                active
                  ? "inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white"
                  : "border-border-strong inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-3 text-sm text-zinc-700 hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] dark:text-zinc-200"
              }
            >
              {label}
              <span className={active ? "text-[11px] opacity-90" : "text-[11px] opacity-70"}>
                {counts[key]}
              </span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <PositionMultiSelect
            positions={positions}
            counts={positionCounts}
            onChange={(next) => onPositionsChange?.(next)}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this list…"
            className="border-border-strong h-7 w-[220px] rounded-full border bg-muted px-3 text-sm focus:border-[var(--color-accent-slate)] focus:bg-background focus:outline-none"
          />
        </div>
      </div>

      {pubGroups.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">
          No publications match this filter.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {pubGroups.map((g, gi) => {
            const open = searchActive || gi === 0 || recentGroupKeys.has(g.key);
            // Bake the controlling flags into the React key so toggling them
            // re-mounts the <details> element, letting the new `open` value
            // win over the user's accumulated click state. Without this,
            // native <details> remains in whatever state the user last set.
            const controlSig = `${searchActive ? "s" : ""}${filterActive ? "f" : ""}` || "auto";
            return (
              <details
                key={`${g.key}:${controlSig}`}
                open={open}
                className="group"
              >
                <summary className="flex cursor-pointer list-none items-baseline gap-3 py-4 hover:text-[var(--color-accent-slate)] [&::-webkit-details-marker]:hidden">
                  <span className="text-muted-foreground inline-block w-3 text-[10px] transition-transform group-open:rotate-90">
                    ▶
                  </span>
                  <span className="text-lg font-semibold tracking-tight">{g.label}</span>
                  <span className="text-muted-foreground text-sm">
                    {g.count} {g.count === 1 ? "publication" : "publications"}
                  </span>
                </summary>
                <ul className="pb-4">
                  {g.pubs.map((p) => (
                    <li
                      key={p.pmid}
                      className="border-t border-border py-3 pl-[24px] first:border-t-0"
                    >
                      <PublicationRow pub={p} compact />
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Multi-select dropdown for the Position filter (issue #77). Trigger displays
 * a short summary ("All", "First author", "2 selected"); panel shows a
 * checkbox list with per-bucket counts. Click outside closes; Escape closes
 * and returns focus to the trigger.
 */
function PositionMultiSelect({
  positions,
  counts,
  onChange,
}: {
  positions: SelectedPositions;
  counts: Record<NonAllPosition, number>;
  onChange: (next: SelectedPositions) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const summary =
    positions.length === 0
      ? "All"
      : positions.length === 1
        ? POSITION_SHORT_LABEL[positions[0]]
        : `${positions.length} selected`;

  const toggle = (key: NonAllPosition) => {
    const next: SelectedPositions = positions.includes(key)
      ? positions.filter((p) => p !== key)
      : [...positions, key];
    onChange(next);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Position filter"
        onClick={() => setOpen((v) => !v)}
        className="border-border-strong inline-flex h-7 items-center gap-1 rounded-full border bg-background px-3 text-sm hover:border-[var(--color-accent-slate)]"
      >
        <span className="text-muted-foreground">Position:</span>
        <span>{summary}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute right-0 z-20 mt-1 w-[200px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {POSITION_OPTIONS.map(({ key, label }) => {
            const checked = positions.includes(key);
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(key)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {checked ? (
                    <Check className="size-3.5 text-[var(--color-accent-slate)]" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="flex-1">{label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {counts[key]}
                </span>
              </button>
            );
          })}
          {positions.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 flex w-full items-center justify-center rounded border-t border-border px-2 py-1.5 text-xs font-medium text-[var(--color-accent-slate)] hover:bg-accent"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
