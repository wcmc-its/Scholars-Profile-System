"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CoPublication } from "@/lib/api/mentoring";

/** Above this count we collapse to the most-recent N and show a "Show all"
 *  toggle inside the popover. Investigation (#181): p95=9, p99=37, max=41 —
 *  only ~4% of mentor-mentee pairs exceed 10 co-pubs, so the collapse only
 *  fires for the long tail. No navigation fallback: 75% of mentees with
 *  co-pubs are unlinked alumni with no profile to navigate to. */
const SOFT_CAP = 15;

export function CoPubPopover({
  copublications,
  menteeFullName,
  mentorCwid,
  menteeCwid,
}: {
  copublications: CoPublication[];
  menteeFullName: string;
  mentorCwid: string;
  menteeCwid: string;
}) {
  const n = copublications.length;
  const [showAll, setShowAll] = React.useState(false);

  const visible = showAll ? copublications : copublications.slice(0, SOFT_CAP);
  const hiddenCount = n - visible.length;

  function handleOpenChange(open: boolean) {
    if (open) {
      try {
        const body = JSON.stringify({
          event: "mentoring_copubs_open",
          mentorCwid,
          menteeCwid,
          n,
          ts: Date.now(),
        });
        navigator.sendBeacon?.("/api/analytics", body);
      } catch {
        // Fire-and-forget telemetry must never break the interaction.
      }
    }
  }

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label={`View ${n} publication${n === 1 ? "" : "s"} co-authored with ${menteeFullName}`}
        >
          <Badge
            variant="secondary"
            className="whitespace-nowrap transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            {n} co-pub{n === 1 ? "" : "s"}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-sm font-semibold">Co-authored publications</div>
          <div className="text-muted-foreground text-xs">
            with {menteeFullName} · {n}
          </div>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {visible.map((p) => (
            <li key={p.pmid}>
              <a
                href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded px-2 py-1.5 text-xs leading-snug hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className="line-clamp-2">{p.title}</span>
                {p.year ? (
                  <span className="text-muted-foreground mt-0.5 block text-[11px]">
                    {p.year}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 ? (
          <div className="border-t border-border px-3 py-2">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
            >
              Show all {n}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
