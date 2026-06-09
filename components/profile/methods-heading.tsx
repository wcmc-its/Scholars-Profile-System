import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// #799 — copy describing how the Methods & tools lens is derived. Matches the
// plain-English, one-paragraph pattern of TopicsHeading / DisclosureInfoTooltip.
const METHODS_INFO_COPY =
  "Methods and tools are inferred from the datasets, models, instruments, and assays named in this scholar's publications, grouped into method families from the canonical taxonomy. Each row counts the publications a family appears in; the sub-line names a few representative member tools.";

/**
 * The "Methods & tools" heading with its info tooltip — the methods-lens
 * counterpart of TopicsHeading (#799), rendered identically so the two lenses
 * read as a matched pair.
 */
export function MethodsHeading() {
  return (
    <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
      Methods &amp; tools
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="About Methods & tools"
              className="text-muted-foreground hover:text-foreground inline-flex h-5 w-5 items-center justify-center self-center rounded-full"
            >
              <HelpCircle className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-sm leading-relaxed">
            {METHODS_INFO_COPY}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </h2>
  );
}
