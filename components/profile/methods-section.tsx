"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, EyeOff } from "lucide-react";

import { MethodsHeading } from "@/components/profile/methods-heading";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScholarFamilyView } from "@/lib/api/profile";
import { methodFamilyPath } from "@/lib/method-url";

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
  filterEnabled = false,
  pagesEnabled = false,
  selectedFamilyIds,
  onFamilyToggle,
  onRevealedFamilies,
}: {
  families: ScholarFamilyView[];
  /** Cwid of the profile being viewed; needed for the #801 reveal fetch. */
  scholarCwid?: string;
  /** Whether METHODS_LENS_SENSITIVE_GATE is on — gates the reveal fetch so a
   *  profile view makes no extra request when #801 is dormant. */
  sensitiveGateActive?: boolean;
  /** #819 — when on, family labels become buttons that toggle the publication
   *  filter (mirrors Topics). When off, the lens is display-only (default). */
  filterEnabled?: boolean;
  /** METHODS_LENS_PAGES — when on, each row gets a SEPARATE trailing outbound
   *  link to the cross-scholar `/methods/**` family page, and the "+ N more"
   *  line links to the `/methods` hub. Distinct from the #819 filter (a
   *  different DOM target, action, route, and flag): the family LABEL is never
   *  the link, so it cannot collide with the click-to-filter button. */
  pagesEnabled?: boolean;
  /** #819 — familyIds currently selected (drives the row's pressed state). */
  selectedFamilyIds?: string[];
  /** #819 — toggle a family in the filter. */
  onFamilyToggle?: (familyId: string) => void;
  /** #819 — hands the revealed (#801) families back up to the owner so the family
   *  filter can resolve their PMIDs; fired once when the reveal fetch resolves. */
  onRevealedFamilies?: (families: ScholarFamilyView[]) => void;
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
        if (cancelled) return;
        const fams = Array.isArray(d.families) ? d.families : [];
        setRevealed(fams);
        onRevealedFamilies?.(fams);
      })
      .catch(() => {
        // A failed probe (401 for anon/other, network) just means no reveal —
        // the public list stands. Never surface an error here.
      });
    return () => {
      cancelled = true;
    };
  }, [scholarCwid, sensitiveGateActive, onRevealedFamilies]);

  const selectedSet = new Set(selectedFamilyIds ?? []);
  const filterable = filterEnabled && typeof onFamilyToggle === "function";

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
      <MethodsHeading pagesEnabled={pagesEnabled} />
      <p className="text-muted-foreground mb-3 text-sm">
        Inferred from the datasets, models &amp; methods named in this scholar&apos;s publications
        {filterable ? " · click to filter publications" : ""}
      </p>
      <TooltipProvider>
        <ul className="divide-border border-border divide-y border-t">
          {visible.map((f) => (
            <li
              key={f.familyId}
              className={
                // #819 — when the row is a filter toggle, `relative` anchors the
                // button's `after:inset-0` overlay so the WHOLE row is the click
                // target (the interactive children below opt out via `z-10`).
                filterable
                  ? "relative flex items-start gap-3 py-2.5"
                  : "flex items-start gap-3 py-2.5"
              }
            >
              <div className="min-w-0 flex-1">
                <div className="text-foreground flex items-center gap-1.5 text-sm">
                  {filterable ? (
                    <button
                      type="button"
                      aria-pressed={selectedSet.has(f.familyId)}
                      onClick={() => onFamilyToggle?.(f.familyId)}
                      className={
                        // Selected: a filled accent-slate pill (mirrors a selected
                        // Topics chip) with the count badge pulled in. Unselected:
                        // plain label that underlines on (whole-row) hover. Both
                        // stretch their hit area across the row via `after:inset-0`.
                        selectedSet.has(f.familyId)
                          ? "inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-2.5 py-0.5 text-left text-sm font-medium text-white after:absolute after:inset-0 after:content-['']"
                          : "inline-flex items-center gap-1 text-left underline-offset-4 after:absolute after:inset-0 after:content-[''] hover:text-[var(--color-accent-slate)] hover:underline"
                      }
                    >
                      <span>{f.familyLabel}</span>
                      {selectedSet.has(f.familyId) ? (
                        <>
                          <span className="rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums">
                            {f.pubCount}
                          </span>
                          <span
                            aria-hidden="true"
                            className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[11px] leading-none"
                          >
                            ×
                          </span>
                        </>
                      ) : null}
                    </button>
                  ) : (
                    <span>{f.familyLabel}</span>
                  )}
                  {f.sensitive ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="text-muted-foreground relative z-10 inline-flex items-center"
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
              {/* #819 — the count sits in the right-hand column, EXCEPT when this
                  family is the active filter: then it rides inside the pill (like
                  a Topics chip) and the column is blank for that row. */}
              {filterable && selectedSet.has(f.familyId) ? null : (
                <span className="text-muted-foreground shrink-0 pt-0.5 text-sm tabular-nums">
                  {f.pubCount}
                </span>
              )}
              {/* METHODS_LENS_PAGES — a SEPARATE trailing outbound link to the
                  cross-scholar family page (NOT the label: that stays the #819
                  filter button). Suppressed for sensitive families, which have
                  no public cross-scholar page. `z-10` lifts it above the #819
                  whole-row click overlay so it stays independently clickable. */}
              {pagesEnabled && !f.sensitive ? (
                <Link
                  href={methodFamilyPath(f.supercategory, f.familyId, f.familyLabel)}
                  aria-label={`Researchers using ${f.familyLabel}`}
                  className="text-muted-foreground relative z-10 inline-flex shrink-0 items-center pt-0.5 hover:text-[var(--color-accent-slate)]"
                >
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </TooltipProvider>
      {remaining > 0 ? (
        pagesEnabled ? (
          <Link
            href="/methods"
            className="text-muted-foreground mt-2 inline-block text-xs underline-offset-4 hover:text-[var(--color-accent-slate)] hover:underline"
          >
            + {remaining} more method {remaining === 1 ? "family" : "families"}
          </Link>
        ) : (
          <p className="text-muted-foreground mt-2 text-xs">
            + {remaining} more method {remaining === 1 ? "family" : "families"}
          </p>
        )
      ) : null}
    </section>
  );
}
