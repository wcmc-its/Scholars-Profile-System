"use client";

import { useEffect, useState } from "react";
import { isNihAwardNumber } from "@/lib/award-number";

/**
 * Resolve a batch of award numbers to NIH RePORTER applIds via
 * `/api/nih-resolve`. Fires once per render of the input set; the upstream
 * call happens after first paint so the user never waits on the round-trip.
 *
 * Used by both the profile Grants section and the funding-tab result list
 * so a single POST covers every NIH award visible on the page.
 */
export function useNihApplIdMap(
  awardNumbers: ReadonlyArray<string | null | undefined>,
): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>({});

  // Stable JSON key avoids re-firing the request when the same set
  // reappears in a different array reference.
  const key = JSON.stringify(
    Array.from(
      new Set(
        awardNumbers.filter((x): x is string => !!x && isNihAwardNumber(x)),
      ),
    ).sort(),
  );

  useEffect(() => {
    const nums: string[] = JSON.parse(key);
    if (nums.length === 0) {
      setMap({});
      return;
    }
    const ctrl = new AbortController();
    fetch("/api/nih-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nums }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((data: { results: Array<{ award: string; applId: number | null }> }) => {
        const next: Record<string, number> = {};
        for (const { award, applId } of data.results) {
          if (applId) next[award] = applId;
        }
        setMap(next);
      })
      .catch(() => {
        /* fire-and-forget — fall back to plain-text award numbers */
      });
    return () => ctrl.abort();
  }, [key]);

  return map;
}
