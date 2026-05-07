"use client";

/**
 * Rotating "Try:" suggestion chips beneath the home-page hero search.
 *
 * Picks a random sample from the 200-entry pool at mount, so each visitor
 * sees a different cross-section of departments, topics, and subtopics.
 * Client-only sampling avoids ISR cache freeze (server-rendered chips would
 * be identical for every visitor inside the 6h revalidate window).
 *
 * SSR renders nothing in this slot; hydration paints the chips. Acceptable
 * because the chips are decorative discovery seeds, not load-bearing.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { sampleHeroSuggestions } from "@/lib/hero-search-suggestions";

export function TrySuggestionsChips({ count = 6 }: { count?: number }) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    setSuggestions(sampleHeroSuggestions(count));
  }, [count]);

  if (suggestions.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-zinc-500">
      <span>Try:</span>
      {suggestions.map((s) => (
        <Link
          key={s}
          href={`/search?q=${encodeURIComponent(s)}`}
          className="rounded-full border border-zinc-200 bg-white px-3 py-0.5 text-zinc-600 transition-colors hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] hover:no-underline"
        >
          {s}
        </Link>
      ))}
    </div>
  );
}
