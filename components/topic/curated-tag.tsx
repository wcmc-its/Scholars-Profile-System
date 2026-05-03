"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PUBLICATION_CENTRIC_COPY =
  "Ranked by ReCiterAI weekly. Scoring covers publications co-authored by full-time WCM faculty; co-authors of those publications appear regardless of role.";
const SCHOLAR_CENTRIC_COPY =
  "Ranked by ReCiterAI weekly. Surfaces full-time faculty, postdocs, fellows, and doctoral students whose recent first-author or senior-author work has been scored.";

export function CuratedTag({
  surface,
}: {
  surface: "publication_centric" | "scholar_centric";
}) {
  const copy =
    surface === "publication_centric" ? PUBLICATION_CENTRIC_COPY : SCHOLAR_CENTRIC_COPY;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 rounded-sm bg-[#e8eff5] px-[6px] py-1 text-sm text-[var(--color-accent-slate)]">
            <span>Curated</span>
            <Info
              className="size-3 text-[var(--color-accent-slate)]"
              aria-label="Learn more about Curated ranking"
            />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-sm">{copy}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
