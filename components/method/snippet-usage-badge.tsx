import { cn } from "@/lib/utils";

/**
 * Usage-type badge for a verbatim snippet: "How it was used" (a specific
 * experimental use) vs "Where it appears" (a generic background mention).
 *
 * The distinction is the output of the producer's informativeness pass
 * (ReciterAI #253 / WS-C, covering all tools, methods, and entities). Until that
 * signal exists we DEFAULT to "How it was used" — the extraction targets usage
 * sentences, so it is right for the majority. A genuine generic mention is
 * therefore temporarily labelled as usage: a soft, reversible editorial default
 * that WS-C downgrades to "Where it appears" once `informativeness_score` lands.
 */
export type SnippetUsage = "used" | "appears";

export function SnippetUsageBadge({
  usage = "used",
  className,
}: {
  usage?: SnippetUsage;
  className?: string;
}) {
  const isUsed = usage === "used";
  return (
    <span
      className={cn(
        "mr-2 inline-block whitespace-nowrap rounded-[4px] px-1.5 py-px align-[1px] text-[10.5px] font-semibold uppercase tracking-[0.3px]",
        isUsed
          ? "bg-[var(--color-apollo-green-tint)] text-[var(--color-apollo-green)]"
          : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
        className,
      )}
    >
      {isUsed ? "How it was used" : "Where it appears"}
    </span>
  );
}
