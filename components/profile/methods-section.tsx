import { MethodsHeading } from "@/components/profile/methods-heading";
import type { ScholarFamilyView } from "@/lib/api/profile";

const INITIAL_VISIBLE = 8;

/**
 * The family-primary "Methods & tools" lens (#799), rendered beside the Subjects
 * lens (TopicsSection) per docs/mockups/methods-lens/two-lens-subjects-vs-methods.html.
 *
 * Display-only: each row is a method family (the entity), with its representative
 * member tools as a monospace sub-line and the publication count right-aligned —
 * the mockup's `.mrow` (label / exemplars / count). Families arrive pre-ranked by
 * `pubCount` desc from the data layer (already #800-suppressed / #801-gated).
 *
 * "All work" only: the surfaced count is the lead/senior-scoped corpus's single
 * publication count. A lead-vs-all toggle (the mockup's segmented control) is
 * intentionally omitted until ReciterAI publishes a per-role count split — a
 * non-functional toggle would render identical numbers. Member-tool expansion is
 * likewise deferred (the mockup shows exemplars as static text).
 */
export function MethodsSection({ families }: { families: ScholarFamilyView[] }) {
  if (families.length === 0) return null;

  const visible = families.slice(0, INITIAL_VISIBLE);
  const remaining = families.length - visible.length;

  return (
    <section className="mb-6">
      <MethodsHeading />
      <p className="text-muted-foreground mb-3 text-sm">
        Inferred from the datasets, models &amp; methods named in this scholar&apos;s publications
      </p>
      <ul className="divide-border border-border divide-y border-t">
        {visible.map((f) => (
          <li key={f.familyId} className="flex items-start gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-foreground text-sm">{f.familyLabel}</div>
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
      {remaining > 0 ? (
        <p className="text-muted-foreground mt-2 text-xs">
          + {remaining} more method {remaining === 1 ? "family" : "families"}
        </p>
      ) : null}
    </section>
  );
}
