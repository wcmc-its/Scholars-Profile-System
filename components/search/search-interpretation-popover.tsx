"use client";

/**
 * Issue #265 Phase 1 — Search interpretation popover.
 *
 * Click-to-toggle popover that explains, in plain language, how the engine
 * treated the user's query. Phase 1 has two states:
 *
 *   - `mesh-expanded`: a MeSH descriptor resolved upstream (#259).
 *     Renders the descriptor name + UI, scope note (when present),
 *     entry-term list (capped at 12 with a "Show all N" toggle), and
 *     a "View in MeSH browser →" link to NLM.
 *
 *   - `free-text`: no MeSH match. Renders the "no concept matched"
 *     explainer so the user understands results came from
 *     title/abstract/journal/author matching, not MeSH expansion.
 *
 * The strict `?searchMode=mesh-only` filter CTA — including its
 * `mesh-only` enum value, URL contract, count rewrite, and
 * `search_popover_mesh_restrict_clicked` telemetry — is carved out
 * to #396 pending the MEDLINE-indexed-vs-has-MeSH semantic decision.
 * Phase 2 (#265) introduces author / journal detection and the
 * `ambiguous` multi-interpretation state.
 *
 * Telemetry fires through the existing `/api/analytics` beacon endpoint
 * (`lib/api/analytics.ts`). `search_popover_opened` fires once per open
 * transition; `search_popover_mesh_browser_clicked` fires when the user
 * clicks the NLM link. Both are fire-and-forget — telemetry failures
 * never block the interaction.
 */
import * as React from "react";
import { Info } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SearchInterpretation } from "@/lib/api/search-interpretation";

const ENTRY_TERM_CAP = 12;

export type SearchInterpretationPopoverProps = {
  interpretation: SearchInterpretation;
  /** Raw query, echoed verbatim into telemetry. Same convention as the
   *  existing `search_page_render` / `search_query` logs. */
  q: string;
};

function emitBeacon(payload: Record<string, unknown>): void {
  if (typeof navigator === "undefined") return;
  try {
    navigator.sendBeacon?.(
      "/api/analytics",
      JSON.stringify({ ...payload, ts: Date.now() }),
    );
  } catch {
    // Telemetry must never break the interaction.
  }
}

export function SearchInterpretationPopover({
  interpretation,
  q,
}: SearchInterpretationPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const [showAllTerms, setShowAllTerms] = React.useState(false);

  const match = interpretation.meshMatches[0] ?? null;
  const isMeshExpanded = interpretation.mode === "mesh-expanded" && match !== null;

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        emitBeacon({
          event: "search_popover_opened",
          q,
          mode: interpretation.mode,
          descriptorId: match?.descriptorId ?? null,
        });
      }
    },
    [q, interpretation.mode, match],
  );

  const handleMeshBrowserClick = React.useCallback(() => {
    if (!match) return;
    emitBeacon({
      event: "search_popover_mesh_browser_clicked",
      q,
      descriptorId: match.descriptorId,
    });
  }, [q, match]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label="Search interpretation"
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1 text-[12.5px] leading-none text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/40"
      >
        <Info aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Search interpretation</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[420px] max-w-[calc(100vw-32px)] p-4 text-[13px] leading-relaxed text-zinc-700"
      >
        <h2 className="sr-only">Search interpretation</h2>

        {isMeshExpanded ? (
          <MeshExpandedBody
            match={match}
            showAllTerms={showAllTerms}
            onToggleTerms={() => setShowAllTerms((v) => !v)}
            onBrowserClick={handleMeshBrowserClick}
          />
        ) : (
          <FreeTextBody q={q} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function MeshExpandedBody({
  match,
  showAllTerms,
  onToggleTerms,
  onBrowserClick,
}: {
  match: NonNullable<SearchInterpretation["meshMatches"][number]>;
  showAllTerms: boolean;
  onToggleTerms: () => void;
  onBrowserClick: () => void;
}) {
  const terms = showAllTerms
    ? match.entryTerms
    : match.entryTerms.slice(0, ENTRY_TERM_CAP);
  const hiddenCount = Math.max(0, match.entryTerms.length - ENTRY_TERM_CAP);

  return (
    <div className="space-y-3">
      <p>
        Matched the MeSH concept{" "}
        <strong className="font-semibold text-zinc-900">{match.name}</strong>{" "}
        <span className="text-zinc-500">({match.descriptorId})</span>.
      </p>

      {match.confidence === "entry-term" ? (
        <p className="text-[12.5px] text-zinc-500">
          Matched via an entry term, not the descriptor name.
        </p>
      ) : null}

      {match.scopeNote ? (
        <p className="text-[12.5px] text-zinc-600">{match.scopeNote}</p>
      ) : null}

      {match.entryTerms.length > 0 ? (
        <div className="text-[12.5px]">
          <div className="font-medium text-zinc-700">Also matches</div>
          <div className="mt-1 text-zinc-600">
            {terms.join(", ")}
            {hiddenCount > 0 && !showAllTerms ? "…" : null}
          </div>
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={onToggleTerms}
              className="mt-1 text-[12px] text-zinc-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/40"
            >
              {showAllTerms ? "Show fewer" : `Show all ${match.entryTerms.length}`}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="pt-1">
        <a
          href={`https://meshb.nlm.nih.gov/record/ui?ui=${encodeURIComponent(match.descriptorId)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onBrowserClick}
          className="text-[12.5px] font-medium text-zinc-900 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/40"
        >
          View in MeSH browser →
        </a>
      </div>
    </div>
  );
}

function FreeTextBody({ q }: { q: string }) {
  return (
    <div className="space-y-2">
      <p>
        No MeSH concept matched{" "}
        <strong className="font-semibold text-zinc-900">{q}</strong>.
      </p>
      <p className="text-[12.5px] text-zinc-600">
        Showing results matched by title, abstract, journal, and author.
      </p>
    </div>
  );
}
