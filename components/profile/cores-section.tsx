import { HelpCircle, FlaskConical } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScholarCoreUsage } from "@/lib/api/scholar-cores";

// Plain-English copy describing how the cores are derived, matching the
// TopicsHeading / DisclosureInfoTooltip wording pattern (one paragraph, no
// marketing tone).
const CORES_INFO_COPY =
  "Core facilities are WCM shared-resource labs (imaging, flow cytometry, genomics, and others) that this scholar's publications used. A core is shown once its usage is confirmed — either by an automated match or by a core's owner; the count is the number of publications confirmed for that core.";

/**
 * "Cores used" — a read-only chip row of the WCM core facilities a scholar's
 * publications confirmed-used. DISPLAY-ONLY (no click-to-filter, unlike Topics
 * and Methods): each chip is a core facility + its confirmed publication count.
 * Renders nothing when there is no confirmed core usage — which is always the
 * case while the cores lens flag is off, since `cores` is then never populated.
 */
export function CoresSection({ cores }: { cores: ScholarCoreUsage[] }) {
  if (cores.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
        <FlaskConical className="text-muted-foreground size-[18px] shrink-0" aria-hidden="true" />
        Cores used
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About core facilities"
                className="inline-flex h-5 w-5 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <HelpCircle className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm text-sm leading-relaxed">
              {CORES_INFO_COPY}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </h2>
      <p className="text-muted-foreground mb-3 text-sm">
        Shared research facilities this scholar&apos;s publications used
      </p>
      <ul className="flex flex-wrap gap-2">
        {cores.map((c) => (
          <li key={c.coreId}>
            <span className="border-border-strong inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-background px-3 text-sm text-zinc-700 dark:text-zinc-200">
              <span>{c.name}</span>
              <span className="text-[11px] tabular-nums opacity-55">{c.pubCount}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
