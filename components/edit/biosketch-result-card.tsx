/**
 * `BiosketchResultCard` — renders the result of one NIH-biosketch generation
 * (#917 v5). The entries are a COPY/EXPORT grant-application artifact, NOT a
 * saved profile field: there is per-entry Copy + a Download-all action, and
 * deliberately NO accept/save-to-profile button (cf. the overview review card,
 * which lands a draft into the editor).
 *
 * The entries are PLAIN TEXT — never HTML. They render through a
 * `whitespace-pre-wrap` block (NOT `dangerouslySetInnerHTML`) so the model's
 * paragraphs survive while any stray markup is shown literally, not executed.
 *
 * Each entry shows its character count against the mode's ceiling
 * (`biosketchCharCap`) and an over-cap badge when the server's `overflow` flags
 * it (the ceiling is never hard-trimmed server-side — trimming grounded prose
 * mid-sentence would corrupt it — so the card surfaces the overage instead).
 * `removedCount` (spans the faithfulness pass stripped) is shown when > 0.
 */
"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { biosketchCharCap, type BiosketchMode } from "@/lib/edit/biosketch-params";
import { cn } from "@/lib/utils";

/** The success payload the `POST /api/edit/biosketch/generate` route returns. */
export type BiosketchGenerateResult = {
  mode: BiosketchMode;
  entries: string[];
  model: string;
  overflow: { index: number; chars: number }[];
  removedCount: number;
  generationId: string | null;
};

export function BiosketchResultCard({ result }: { result: BiosketchGenerateResult }) {
  const cap = biosketchCharCap(result.mode);
  const overflowIndexes = React.useMemo(
    () => new Set(result.overflow.map((o) => o.index)),
    [result.overflow],
  );
  const isContributions = result.mode === "contributions";

  function downloadAll() {
    // Number the contributions in the export; the single Personal Statement is
    // emitted bare. Blank line between entries, trailing newline at the end.
    const body = isContributions
      ? result.entries.map((e, i) => `${i + 1}. ${e}`).join("\n\n")
      : result.entries.join("\n\n");
    const blob = new Blob([`${body}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = isContributions
      ? "nih-contributions-to-science.txt"
      : "nih-personal-statement.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="border-apollo-border bg-apollo-surface flex flex-col gap-4 rounded-lg border p-4"
      data-slot="biosketch-result-card"
      data-testid="biosketch-result"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-foreground text-base font-semibold">
            {isContributions ? "Contributions to Science" : "Personal Statement"}
          </h2>
          <p className="text-muted-foreground text-xs">
            Copy these into your grant application. Nothing here is saved to your profile.
          </p>
        </div>
        {result.entries.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={downloadAll}
            data-testid="biosketch-download-all"
          >
            <Download className="size-4" />
            Download all (.txt)
          </Button>
        )}
      </div>

      {result.removedCount > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="biosketch-removed-count">
          Trimmed {result.removedCount}{" "}
          {result.removedCount === 1 ? "unverifiable detail" : "unverifiable details"} that could
          not be grounded in your indexed work.
        </p>
      )}

      <ol className="flex flex-col gap-4">
        {result.entries.map((entry, index) => {
          const over = overflowIndexes.has(index);
          return (
            <BiosketchEntry
              key={index}
              index={index}
              entry={entry}
              cap={cap}
              over={over}
              showNumber={isContributions}
            />
          );
        })}
      </ol>
    </div>
  );
}

function BiosketchEntry({
  index,
  entry,
  cap,
  over,
  showNumber,
}: {
  index: number;
  entry: string;
  cap: number;
  over: boolean;
  showNumber: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(entry);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject (permissions / insecure context). Leave the button
      // in its default state rather than asserting a copy that didn't happen.
    }
  }

  return (
    <li
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-2 rounded-md border p-3"
      data-testid={`biosketch-entry-${index}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {showNumber && (
            <span className="text-foreground text-sm font-semibold tabular-nums">{index + 1}.</span>
          )}
          <span
            className={cn(
              "text-xs tabular-nums",
              over ? "text-destructive" : "text-muted-foreground",
            )}
            data-testid={`biosketch-entry-count-${index}`}
          >
            {entry.length.toLocaleString()}/{cap.toLocaleString()} characters
          </span>
          {over && (
            <span
              className="bg-destructive/10 text-destructive rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
              data-testid={`biosketch-entry-overflow-${index}`}
            >
              Over cap
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          data-testid={`biosketch-entry-copy-${index}`}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p
        className="text-foreground text-sm whitespace-pre-wrap"
        data-testid={`biosketch-entry-text-${index}`}
      >
        {entry}
      </p>
    </li>
  );
}
