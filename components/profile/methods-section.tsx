"use client";

import { useEffect, useState } from "react";
import { EyeOff } from "lucide-react";

import { MethodsHeading } from "@/components/profile/methods-heading";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScholarFamilyView } from "@/lib/api/profile";

const INITIAL_VISIBLE = 8;

type Row = ScholarFamilyView & { sensitive: boolean };

/**
 * The family-primary "Methods & tools" lens (#799), rendered beside the Subjects
 * lens per docs/mockups/methods-lens/two-lens-subjects-vs-methods.html.
 *
 * Display-only rows (label / monospace exemplar tools / publication count),
 * pre-ranked by `pubCount` desc. The public `families` prop already excludes
 * #800-suppressed and #801-sensitive families.
 *
 * #801 reveal: when the audience gate is active (`sensitiveGateActive`), this
 * island fetches the scholar's gated families from the cookie-forwarding
 * /api/edit/methods-sensitive route. The route returns them ONLY to the scholar
 * themselves and site admins (anonymous/other viewers get []), so a public
 * viewer sees exactly the unmarked public list. Revealed families merge into the
 * list in rank order, each flagged with a light "hidden from the public profile"
 * marker (an eye-off icon + hover tooltip).
 *
 * "All work" only: the count is the lead/senior-scoped corpus's single
 * publication count; the mockup's lead/all toggle is omitted until ReciterAI
 * publishes a per-role split. Member-tool expansion is likewise deferred.
 */
export function MethodsSection({
  families,
  scholarCwid,
  sensitiveGateActive = false,
}: {
  families: ScholarFamilyView[];
  /** Cwid of the profile being viewed; needed for the #801 reveal fetch. */
  scholarCwid?: string;
  /** Whether METHODS_LENS_SENSITIVE_GATE is on — gates the reveal fetch so a
   *  profile view makes no extra request when #801 is dormant. */
  sensitiveGateActive?: boolean;
}) {
  const [revealed, setRevealed] = useState<ScholarFamilyView[]>([]);

  useEffect(() => {
    if (!sensitiveGateActive || !scholarCwid) return;
    let cancelled = false;
    fetch(`/api/edit/methods-sensitive/${encodeURIComponent(scholarCwid)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : { families: [] }))
      .then((d: { families?: ScholarFamilyView[] }) => {
        if (!cancelled) setRevealed(Array.isArray(d.families) ? d.families : []);
      })
      .catch(() => {
        // A failed probe (401 for anon/other, network) just means no reveal —
        // the public list stands. Never surface an error here.
      });
    return () => {
      cancelled = true;
    };
  }, [scholarCwid, sensitiveGateActive]);

  // Merge public (unmarked) + revealed (sensitive), de-duped by familyId, in
  // rank order. A revealed family is never also in the public set (the server
  // partitions them), but dedup defensively.
  const seen = new Set(families.map((f) => f.familyId));
  const rows: Row[] = [
    ...families.map((f) => ({ ...f, sensitive: false })),
    ...revealed.filter((f) => !seen.has(f.familyId)).map((f) => ({ ...f, sensitive: true })),
  ].sort((a, b) => b.pubCount - a.pubCount || a.familyLabel.localeCompare(b.familyLabel));

  if (rows.length === 0) return null;

  const visible = rows.slice(0, INITIAL_VISIBLE);
  const remaining = rows.length - visible.length;

  return (
    <section className="mb-6">
      <MethodsHeading />
      <p className="text-muted-foreground mb-3 text-sm">
        Inferred from the datasets, models &amp; methods named in this scholar&apos;s publications
      </p>
      <TooltipProvider>
        <ul className="divide-border border-border divide-y border-t">
          {visible.map((f) => (
            <li key={f.familyId} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-foreground flex items-center gap-1.5 text-sm">
                  <span>{f.familyLabel}</span>
                  {f.sensitive ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="text-muted-foreground inline-flex items-center"
                          aria-label="Hidden from the public profile"
                        >
                          <EyeOff className="size-3.5" aria-hidden="true" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-sm leading-relaxed">
                        Hidden from the public profile — shown only to the scholar and site admins
                        (audience-gated family).
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
                {f.exemplarTools.length > 0 ? (
                  <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                    {f.exemplarTools.join(" · ")}
                  </div>
                ) : null}
              </div>
              <span className="text-muted-foreground shrink-0 pt-0.5 text-sm tabular-nums">
                {f.pubCount}
              </span>
            </li>
          ))}
        </ul>
      </TooltipProvider>
      {remaining > 0 ? (
        <p className="text-muted-foreground mt-2 text-xs">
          + {remaining} more method {remaining === 1 ? "family" : "families"}
        </p>
      ) : null}
    </section>
  );
}
