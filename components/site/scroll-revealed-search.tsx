"use client";

import { useEffect, useState } from "react";
import { SearchAutocomplete } from "@/components/search/autocomplete";

/**
 * Header search variant that stays hidden while a sentinel element (typically
 * the homepage hero search) is in view, then fades in once the user scrolls
 * past it. Resolves issue #215 — duplicate search affordance on home-page
 * first paint.
 *
 * Falls back to always-revealed in two cases so the search is never trapped
 * invisible: (a) the sentinel element isn't in the DOM, (b) IntersectionObserver
 * isn't available (very old browsers, SSR — although this component is
 * client-only so SSR isn't a concern, the first paint still needs a sensible
 * default before the effect runs).
 */
export function ScrollRevealedSearch({ sentinelId }: { sentinelId: string }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const target = document.getElementById(sentinelId);
    if (!target || typeof IntersectionObserver === "undefined") {
      setRevealed(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setRevealed(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [sentinelId]);

  return (
    <div
      aria-hidden={!revealed}
      className={`transition-opacity duration-200 ${
        revealed ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <SearchAutocomplete />
    </div>
  );
}
