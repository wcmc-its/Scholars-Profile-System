import { HelpCircle, Tag } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Issue #163 — copy describing how Topics are derived. Matches the wording
// pattern used elsewhere on the site (DisclosureInfoTooltip): one paragraph,
// plain English, no marketing tone.
const TOPICS_INFO_COPY =
  "Topics are derived from MeSH descriptors on the publications attributed to this scholar. Each pill shows the number of accepted publications tagged with that descriptor; clicking filters the Publications list to that topic.";

/**
 * The "Topics" heading with its info tooltip. Shared by TopicsSection and the
 * TopicsUpdatingPlaceholder so both render an identical header (#118).
 */
export function TopicsHeading() {
  return (
    <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
      <Tag className="text-muted-foreground size-[18px] shrink-0" aria-hidden="true" />
      Topics
      {/* Issue #163 — use the shared dark-tooltip pattern (matches
          DisclosureInfoTooltip) instead of the native browser `title`
          attribute so styling is consistent across the site. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="About Topics"
              className="inline-flex h-5 w-5 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-sm leading-relaxed">
            {TOPICS_INFO_COPY}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </h2>
  );
}
