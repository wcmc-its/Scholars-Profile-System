"use client";

import { useMemo, useState } from "react";
import { PublicationRow } from "@/components/profile/publication-row";
import { groupPublicationsByYear } from "@/lib/profile-pub-grouping";
import type { ProfilePublication } from "@/lib/api/profile";

/**
 * Map publicationType strings (verbatim from PubMed via ReciterDB) to filter
 * chip buckets. Mirrors the mockup chip set; the long-tail types (case reports,
 * preprints, letters, errata) reach the "All" view but don't get their own
 * chip — too small a slice and the chip set stays readable.
 */
type Bucket = "all" | "article" | "review" | "editorial";

function bucketOf(publicationType: string | null): Bucket | null {
  if (publicationType === "Academic Article") return "article";
  if (publicationType === "Review") return "review";
  if (publicationType === "Editorial Article") return "editorial";
  return null;
}

const BUCKET_ORDER: ReadonlyArray<{ key: Bucket; label: string }> = [
  { key: "all", label: "All" },
  { key: "article", label: "Research Articles" },
  { key: "review", label: "Reviews" },
  { key: "editorial", label: "Editorials" },
];

export function PublicationsSection({
  publications,
  filterActive = false,
}: {
  publications: ProfilePublication[];
  /** Set by `<ProfilePubsCluster>` when a topic filter is active. Expands
   *  every year-group within the last 10 years (per the published max year)
   *  on top of the default "first group only" behavior, so users browsing a
   *  filtered set don't have to click open year after year (issue #73). */
  filterActive?: boolean;
}) {
  const [bucket, setBucket] = useState<Bucket>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      all: publications.length,
      article: 0,
      review: 0,
      editorial: 0,
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
      if (q.length === 0) return true;
      const hay =
        (p.title ?? "") +
        " " +
        (p.journal ?? "") +
        " " +
        (p.authorsString ?? "");
      return hay.toLowerCase().includes(q);
    });
  }, [publications, bucket, query]);

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
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this list…"
          className="border-border-strong ml-auto h-7 w-[220px] rounded-full border bg-muted px-3 text-sm focus:border-[var(--color-accent-slate)] focus:bg-background focus:outline-none"
        />
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
