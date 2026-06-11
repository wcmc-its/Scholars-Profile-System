"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, EyeOff, Square, SquareCheck, X } from "lucide-react";

import { MethodsHeading } from "@/components/profile/methods-heading";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScholarFamilyView } from "@/lib/api/profile";
import { methodFamilyPath } from "@/lib/method-url";

// Resting budget for UNSELECTED method rows in the redesign panel (#1/#2).
// Selected/pinned rows are budgeted INDEPENDENTLY (always all rendered), so a
// 4-selected scholar shows 4 + UNSELECTED_INITIAL rows, not 6 total.
const UNSELECTED_INITIAL = 6;
// Inline "+N more method families" reveals this many additional unselected rows
// per click (#3), in document flow (no nested scroll, #5).
const UNSELECTED_STEP = 10;
// Legacy (flag-off / pre-redesign #819) flat cap — unchanged behavior.
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
 * island fetches the scholar's gated families from the
 * /api/profile/[cwid]/sensitive-families route. The route returns them ONLY to an
 * internal viewer — an authenticated session or an on-WCM-network viewer (#866);
 * external viewers get [] — so a public viewer sees exactly the unmarked public
 * list. Revealed families merge into the list in rank order, each flagged with a
 * light "hidden from the public profile" marker (an eye-off icon + hover tooltip).
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
  facetRedesignEnabled = false,
  familyCounts = null,
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
  /** PROFILE_FACET_REDESIGN — when off (default), this section renders EXACTLY
   *  as today (the #829 selected pill, #801 EyeOff reveal, #824 ArrowUpRight
   *  browse-out link, whole-row overlay). When on, rows become explicit checkbox
   *  rows with contextual "{in} of {total}" counts and zero-count dimming.
   *  Additive: all new UI lives under this flag. */
  facetRedesignEnabled?: boolean;
  /** Contextual ("exclude-own-facet") per-family counts keyed by `familyId`,
   *  supplied by the cluster only when the redesign is on AND a filter is active.
   *  null = no active filter (or flag off) → render plain `pubCount`. */
  familyCounts?: Map<string, number> | null;
}) {
  const [revealed, setRevealed] = useState<ScholarFamilyView[]>([]);
  // #3 — how many UNSELECTED method rows are currently revealed in the resting
  // panel. Grows by UNSELECTED_STEP on each "+N more" click; never navigates.
  const [unselectedVisible, setUnselectedVisible] = useState(UNSELECTED_INITIAL);

  useEffect(() => {
    if (!sensitiveGateActive || !scholarCwid) return;
    let cancelled = false;
    fetch(`/api/profile/${encodeURIComponent(scholarCwid)}/sensitive-families`, {
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

  // #1/#2 — budget UNSELECTED rows independently of selected ones (redesign
  // only). Selected/pinned families ALWAYS render, in rank order and in place;
  // unselected families fill up to `unselectedVisible`. Order is preserved from
  // the rank-sorted `rows` so nothing reflows on toggle (#14). The legacy path
  // keeps its flat INITIAL_VISIBLE cap, byte-identical.
  let visible: Row[];
  let hiddenUnselected: number; // #3 — N = unselected-AND-hidden families only
  if (facetRedesignEnabled) {
    let shownUnselected = 0;
    visible = rows.filter((f) => {
      if (selectedSet.has(f.familyId)) return true; // selected never budgeted out (#2)
      if (shownUnselected < unselectedVisible) {
        shownUnselected += 1;
        return true;
      }
      return false;
    });
    const totalUnselected = rows.reduce((n, f) => n + (selectedSet.has(f.familyId) ? 0 : 1), 0);
    hiddenUnselected = Math.max(0, totalUnselected - shownUnselected);
  } else {
    visible = rows.slice(0, INITIAL_VISIBLE);
    hiddenUnselected = rows.length - visible.length;
  }
  const remaining = hiddenUnselected;

  return (
    <section className="mb-6">
      <MethodsHeading pagesEnabled={pagesEnabled} />
      <p className="text-muted-foreground mb-3 text-sm">
        {facetRedesignEnabled && familyCounts
          ? "Counts shown within current filter"
          : facetRedesignEnabled
            ? "Inferred from the datasets, models & methods named in this scholar's publications · select to filter"
            : `Inferred from the datasets, models & methods named in this scholar's publications${filterable ? " · click to filter publications" : ""}`}
      </p>
      <TooltipProvider>
        <ul
          className={
            facetRedesignEnabled
              ? "border-border-strong divide-border-strong divide-y overflow-hidden rounded-lg border bg-background"
              : "divide-border border-border divide-y border-t"
          }
        >
          {visible.map((f) => {
            // PROFILE_FACET_REDESIGN — explicit checkbox rows (translated from the
            // signed-off mockups: Tabler ti-square/ti-square-check → lucide
            // Square/SquareCheck, literal hex → the --color-facet-method-* tokens).
            // The WHOLE row toggles the family (mirrors today's whole-row overlay);
            // the #801 EyeOff tooltip and #824 ArrowUpRight browse-out link stay
            // independently clickable via z-10. Flag-off path below is byte-identical.
            if (facetRedesignEnabled) {
              const isSelected = selectedSet.has(f.familyId);
              const inFilter = familyCounts ? (familyCounts.get(f.familyId) ?? 0) : undefined;
              const zeroCount = inFilter === 0;
              // #7 — a SELECTED family with a 0 contextual count contributes
              // nothing under the OTHER active filters. Deliberate, NOT an error:
              // keep full opacity (filled + checked + remove-X) and a quiet inset
              // ring, and mute the count. #14 — an UNSELECTED zero-count row is
              // the dim/inert state (opacity-45), a different signal.
              const selectedZero = isSelected && zeroCount;
              const dimZero = zeroCount && !isSelected; // the only opacity-45 case
              return (
                <li
                  key={f.familyId}
                  className={
                    selectedZero
                      ? "facet-chip-transition relative flex items-center gap-3 bg-[var(--color-facet-method-fill)] px-3.5 py-3 ring-1 ring-inset ring-[var(--color-facet-method-border)]"
                      : isSelected
                        ? "facet-chip-transition relative flex items-center gap-3 bg-[var(--color-facet-method-fill)] px-3.5 py-3 dark:ring-1 dark:ring-inset dark:ring-[var(--color-facet-method-border)]"
                        : "facet-chip-transition relative flex items-center gap-3 px-3.5 py-3"
                  }
                  data-selected-zero={selectedZero ? "true" : undefined}
                >
                  {/* Whole-row toggle: a full-bleed transparent button so any click
                      on the row toggles the family. Interactive children (EyeOff,
                      ArrowUpRight) sit above it via z-10. */}
                  {filterable ? (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={f.familyLabel}
                      onClick={() => onFamilyToggle?.(f.familyId)}
                      className="absolute inset-0"
                    />
                  ) : null}
                  {isSelected ? (
                    <SquareCheck
                      className="size-[18px] shrink-0 text-[var(--color-facet-method-count)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <Square
                      className={
                        dimZero
                          ? "text-muted-foreground size-[18px] shrink-0 opacity-45"
                          : "text-muted-foreground size-[18px] shrink-0"
                      }
                      aria-hidden="true"
                    />
                  )}
                  <div className={dimZero ? "min-w-0 flex-1 opacity-45" : "min-w-0 flex-1"}>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={
                          isSelected
                            ? "text-sm font-medium text-[var(--color-facet-method-text)]"
                            : "text-foreground text-sm font-medium"
                        }
                      >
                        {f.familyLabel}
                      </span>
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
                            Hidden from the public profile — shown to Weill Cornell viewers
                            (audience-gated family).
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                    {f.exemplarTools.length > 0 ? (
                      <div
                        className={
                          isSelected
                            ? "mt-0.5 truncate font-mono text-xs text-[var(--color-facet-method-count)]"
                            : "text-muted-foreground mt-0.5 truncate font-mono text-xs"
                        }
                      >
                        {f.exemplarTools.join(" · ")}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className={
                      selectedZero
                        ? "shrink-0 text-sm font-medium tabular-nums text-[var(--color-facet-method-count)]"
                        : dimZero
                          ? "shrink-0 text-sm font-medium tabular-nums opacity-45"
                          : isSelected
                            ? "shrink-0 text-sm font-medium tabular-nums text-[var(--color-facet-method-text)]"
                            : "text-foreground shrink-0 text-sm font-medium tabular-nums"
                    }
                  >
                    {inFilter !== undefined ? (
                      selectedZero ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="relative z-10 inline-flex items-center gap-1"
                              aria-label={`No publications match ${f.familyLabel} under the current filters`}
                            >
                              0{" "}
                              <span className="font-normal text-[var(--color-facet-method-count)]">
                                of {f.pubCount}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm leading-relaxed">
                            No publications match this method under the current filters. Remove
                            another filter (or this method) to see its publications.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <>
                          {inFilter}{" "}
                          <span
                            className={
                              isSelected ? "font-normal text-[var(--color-facet-method-count)]" : ""
                            }
                          >
                            of {f.pubCount}
                          </span>
                        </>
                      )
                    ) : (
                      f.pubCount
                    )}
                  </span>
                  {/* Selected: a trailing remove (X) target. z-10 so it stays
                      clickable above the whole-row toggle overlay. */}
                  {isSelected && filterable ? (
                    <button
                      type="button"
                      aria-label={`Remove ${f.familyLabel} filter`}
                      onClick={() => onFamilyToggle?.(f.familyId)}
                      className="relative z-10 inline-flex shrink-0 items-center text-[var(--color-facet-method-count)]"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {/* METHODS_LENS_PAGES — SEPARATE trailing browse-out link (#824),
                      independently clickable above the row toggle via z-10. */}
                  {pagesEnabled && !f.sensitive ? (
                    <Link
                      href={methodFamilyPath(f.supercategory, f.familyId, f.familyLabel)}
                      aria-label={`Researchers using ${f.familyLabel}`}
                      className="text-muted-foreground relative z-10 inline-flex shrink-0 items-center hover:text-[var(--color-accent-slate)]"
                    >
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </Link>
                  ) : null}
                </li>
              );
            }

            return (
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
                        Hidden from the public profile — shown to Weill Cornell viewers
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
            );
          })}
        </ul>
      </TooltipProvider>
      {facetRedesignEnabled ? (
        // #3 — inline EXPAND (never navigates); #4 — the only navigate-away
        // control is MethodsHeading's "Browse all methods ->", so the row footer
        // here is purely an in-flow disclosure (#5 — no nested scroll).
        <div className="mt-2 flex items-center gap-4">
          {remaining > 0 ? (
            <button
              type="button"
              onClick={() => setUnselectedVisible((n) => n + UNSELECTED_STEP)}
              className="text-muted-foreground inline-flex items-center text-xs underline-offset-4 hover:text-[var(--color-facet-method-count)] hover:underline"
            >
              + {remaining} more method {remaining === 1 ? "family" : "families"}
            </button>
          ) : null}
          {unselectedVisible > UNSELECTED_INITIAL ? (
            <button
              type="button"
              onClick={() => setUnselectedVisible(UNSELECTED_INITIAL)}
              className="text-muted-foreground inline-flex items-center text-xs underline-offset-4 hover:text-[var(--color-facet-method-count)] hover:underline"
            >
              Show fewer
            </button>
          ) : null}
        </div>
      ) : remaining > 0 ? (
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
