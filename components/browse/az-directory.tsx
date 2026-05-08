"use client";

/**
 * A-Z Directory.
 * Client Component. All data is pre-bucketed by getAZBuckets() in
 * lib/api/browse.ts and passed as props at server render time. The only
 * runtime state is `openLetter` — single-letter-open toggle behavior.
 *
 * Renders on /search's empty People tab (relocated from /browse per
 * docs/browse-vs-search.md). Container margin is unset; the parent
 * decides spacing.
 *
 * No fetches, no Prisma calls inside this file.
 */
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { AZBucket } from "@/lib/api/browse";

const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function AZDirectory({ buckets }: { buckets: AZBucket[] }) {
  const [openLetter, setOpenLetter] = useState<string | null>(null);
  const bucketMap = new Map(buckets.map((b) => [b.letter, b]));

  function handleLetterClick(letter: string) {
    const b = bucketMap.get(letter);
    if (!b || b.count === 0) return;
    setOpenLetter((prev) => (prev === letter ? null : letter));
  }

  const openBucket = openLetter ? bucketMap.get(openLetter) : undefined;

  return (
    <section id="az-directory">
      <h2 className="text-lg font-semibold">A&ndash;Z Directory</h2>

      <div className="bg-muted rounded-lg p-3 mt-3 flex flex-wrap gap-1">
        {ALL_LETTERS.map((letter) => {
          const b = bucketMap.get(letter);
          const hasScholars = !!b && b.count > 0;
          if (!hasScholars) {
            return (
              <span
                key={letter}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-sm font-semibold text-muted-foreground cursor-default opacity-40"
                aria-disabled="true"
              >
                {letter}
              </span>
            );
          }
          const isOpen = openLetter === letter;
          return (
            <button
              key={letter}
              type="button"
              onClick={() => handleLetterClick(letter)}
              aria-expanded={isOpen}
              aria-label={`Show scholars with last name starting with ${letter}`}
              className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-sm font-semibold transition-colors ${
                isOpen
                  ? "bg-[var(--color-accent-slate)] text-white"
                  : "text-foreground hover:bg-background hover:shadow-sm"
              }`}
            >
              {letter}
            </button>
          );
        })}
      </div>

      {openLetter && openBucket && (
        <Collapsible
          open={true}
          onOpenChange={(open) => {
            if (!open) setOpenLetter(null);
          }}
        >
          <CollapsibleContent>
            <div className="mt-4 pt-4 border-t border-border">
              <h3 className="text-lg font-semibold mb-3">{openLetter}</h3>
              <ul className="grid grid-cols-1 gap-y-1 sm:grid-cols-2">
                {openBucket.scholars.map((s) => (
                  <li key={s.slug}>
                    <a
                      href={`/scholars/${s.slug}`}
                      className="text-base hover:underline hover:text-[var(--color-accent-slate)]"
                    >
                      {s.name}
                    </a>{" "}
                    <span className="text-sm text-muted-foreground">
                      &middot; {s.department}
                    </span>
                  </li>
                ))}
              </ul>
              {openBucket.count > 10 && (
                <a
                  href={`/search?q=${openLetter}&tab=people`}
                  className="mt-4 block text-sm text-[var(--color-accent-slate)] hover:underline"
                >
                  View all {openBucket.count} scholars with last name
                  starting with {openLetter} &#x2192;
                </a>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
