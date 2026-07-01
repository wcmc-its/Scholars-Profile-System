"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, EyeOff, Info, X } from "lucide-react";

import { MethodsHeading } from "@/components/profile/methods-heading";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScholarFamilyView } from "@/lib/api/profile";
import { methodFamilyPath } from "@/lib/method-url";

/**
 * #879 — the generated family definition as a hover (the prevailing in-file radix
 * Tooltip style, matching the #801 EyeOff marker). An (i) trigger sits inline next
 * to the family label; `relative z-10` keeps it independently hoverable/focusable
 * ABOVE the #819 whole-row filter overlay (and a `type="button"` with no onClick
 * never toggles the filter). Rendered only when a definition is present — the
 * server data layer already nulls it unless METHODS_LENS_FAMILY_DEFINITIONS is on,
 * so this component needs no flag of its own. The "AI-generated" disclaimer is
 * gated on `definitionSource === "generated"`. RENDER-ONLY (display, never re-fed
 * to any model).
 */
function FamilyDefinitionTip({
  definition,
  familyLabel,
  generated,
}: {
  definition: string;
  familyLabel: string;
  generated: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground relative z-10 inline-flex items-center"
          aria-label={`About ${familyLabel}`}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm leading-relaxed">
        {definition}
        {generated ? (
          <span className="mt-1 block text-xs italic opacity-80">AI-generated definition</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * #1119 — the exemplar member-tool line ("CheXpert · MIMIC-CXR"). When a tool has
 * a usage snippet (`exemplarContexts[name]`, populated only under
 * METHODS_LENS_TOOL_CONTEXT — the server empties it otherwise, so the off-path
 * renders byte-identically to the prior `join(" · ")`), its name becomes a Radix
 * hover trigger showing "How <tool> was used: …". `relative z-10` + `type="button"`
 * with no onClick keeps it independently hoverable ABOVE the #819 whole-row filter
 * overlay, exactly like FamilyDefinitionTip. Snippet renders as PLAIN TEXT (React
 * escapes it — no markup injection).
 */
function ExemplarToolsLine({
  tools,
  contexts,
  className,
}: {
  tools: string[];
  contexts: Record<string, string> | undefined;
  className: string;
}) {
  // Defensive: a client payload built before #1119 (e.g. the #801 sensitive-reveal
  // route) may omit the field. Flag-off (and any family with no resolved snippets)
  // renders the plain dotted join exactly as before — one text node, no triggers.
  const ctx = contexts ?? {};
  const hasAnyContext = tools.some((t) => ctx[t]);
  if (!hasAnyContext) {
    return <div className={className}>{tools.join(" · ")}</div>;
  }
  return (
    <div className={className}>
      {tools.map((tool, i) => {
        const context = ctx[tool];
        return (
          <span key={tool}>
            {i > 0 ? " · " : null}
            {context ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="hover:text-foreground relative z-10 underline decoration-dotted underline-offset-2"
                    aria-label={`How ${tool} was used`}
                  >
                    {tool}
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs font-sans text-sm leading-relaxed">
                  <span className="font-medium">How {tool} was used</span>
                  <span className="mt-1 block">{context}</span>
                </TooltipContent>
              </Tooltip>
            ) : (
              tool
            )}
          </span>
        );
      })}
    </div>
  );
}

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
            facetRedesignEnabled ? "flex flex-wrap gap-2" : "divide-border border-border divide-y border-t"
          }
        >
          {visible.map((f) => {
            // PROFILE_FACET_REDESIGN — #1377 Topics-style pills. Each family is a
            // rounded-full facet pill (mirrors the Subjects/Topics chips so the
            // methods read as obviously-clickable facets): selected = a filled
            // accent-slate pill + remove (X); unselected = a bordered pill that
            // hovers to accent-slate; an UNSELECTED zero-count pill dims (#14).
            // The whole pill is a full-bleed toggle button; the #801 EyeOff marker,
            // #879 definition (i), and #824 browse-out link stay independently
            // clickable above it via z-10. The exemplar member-tools move OFF the
            // face into a non-interactive hover preview (HoverTooltip). Flag-off
            // path below is byte-identical to today's display-only rows.
            if (facetRedesignEnabled) {
              const isSelected = selectedSet.has(f.familyId);
              const inFilter = familyCounts ? (familyCounts.get(f.familyId) ?? 0) : undefined;
              const zeroCount = inFilter === 0;
              // #7 — a SELECTED family with a 0 contextual count contributes
              // nothing under the OTHER active filters. Deliberate, NOT an error:
              // keep the full-opacity filled pill + remove-X and mute the count.
              // #14 — an UNSELECTED zero-count pill is the dim/inert state.
              const selectedZero = isSelected && zeroCount;
              const dimZero = zeroCount && !isSelected; // the only opacity-45 case
              // The count face: "{in} of {total}" when a contextual familyCount is
              // present (a filter is active), else the plain profile-wide pubCount —
              // the number stays a direct text node so the total nests beside it.
              const countNode =
                inFilter !== undefined ? (
                  <>
                    {inFilter}{" "}
                    <span className={isSelected ? "font-normal" : "opacity-80"}>
                      of {f.pubCount}
                    </span>
                  </>
                ) : (
                  f.pubCount
                );
              const pill = (
                <span
                  className={
                    "facet-chip-transition relative inline-flex h-[26px] items-center gap-1.5 rounded-full px-3 text-sm " +
                    (isSelected
                      ? "bg-[var(--color-accent-slate)] text-white"
                      : dimZero
                        ? "border-border-strong border bg-background text-zinc-700 opacity-45 dark:text-zinc-200"
                        : "border-border-strong border bg-background text-zinc-700 hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] dark:text-zinc-200")
                  }
                >
                  {/* Whole-pill toggle: a full-bleed transparent button so any click
                      on the pill toggles the family. Interactive children (EyeOff,
                      (i), remove, browse-out) sit above it via z-10. */}
                  {filterable ? (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={f.familyLabel}
                      disabled={dimZero}
                      onClick={() => onFamilyToggle?.(f.familyId)}
                      className="absolute inset-0 rounded-full"
                    />
                  ) : null}
                  {/* No z-10: the label stays BELOW the transparent inset-0 toggle
                      so clicking the family name toggles the facet (only the
                      separately-interactive icons below are lifted above it). */}
                  <span>{f.familyLabel}</span>
                  {f.sensitive ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={
                            isSelected
                              ? "relative z-10 inline-flex items-center text-white/80"
                              : "text-muted-foreground relative z-10 inline-flex items-center"
                          }
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
                  {f.definition ? (
                    <FamilyDefinitionTip
                      definition={f.definition}
                      familyLabel={f.familyLabel}
                      generated={f.definitionSource === "generated"}
                    />
                  ) : null}
                  {selectedZero ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="relative z-10 inline-flex items-center rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums"
                          aria-label={`No publications match ${f.familyLabel} under the current filters`}
                        >
                          {countNode}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-sm leading-relaxed">
                        No publications match this method under the current filters. Remove another
                        filter (or this method) to see its publications.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span
                      className={
                        isSelected
                          ? "rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums"
                          : "text-[11px] tabular-nums opacity-55"
                      }
                    >
                      {countNode}
                    </span>
                  )}
                  {/* Selected: a trailing remove (X) target, clickable above the
                      whole-pill toggle via z-10. */}
                  {isSelected && filterable ? (
                    <button
                      type="button"
                      aria-label={`Remove ${f.familyLabel} filter`}
                      onClick={() => onFamilyToggle?.(f.familyId)}
                      className="relative z-10 -mr-1 inline-flex shrink-0 items-center text-white"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {/* METHODS_LENS_PAGES — SEPARATE trailing browse-out link (#824),
                      independently clickable above the pill toggle via z-10. */}
                  {pagesEnabled && !f.sensitive ? (
                    <Link
                      href={methodFamilyPath(f.supercategory, f.familyId, f.familyLabel)}
                      aria-label={`Researchers using ${f.familyLabel}`}
                      className={
                        isSelected
                          ? "relative z-10 -mr-1 inline-flex shrink-0 items-center text-white/80 hover:text-white"
                          : "text-muted-foreground relative z-10 -mr-1 inline-flex shrink-0 items-center hover:text-[var(--color-accent-slate)]"
                      }
                    >
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </Link>
                  ) : null}
                </span>
              );
              return (
                <li
                  key={f.familyId}
                  className="facet-chip-transition"
                  data-selected-zero={selectedZero ? "true" : undefined}
                >
                  {/* #1377 — the exemplar member-tools surface as a non-interactive
                      hover preview on the pill: a titled bulleted list (the plain
                      dotted `text` stays as the accessible fallback). Tool NAMES
                      only; no per-tool click target — the pill carries the
                      filter/link. */}
                  {f.exemplarTools.length > 0 ? (
                    <HoverTooltip
                      wide
                      text={f.exemplarTools.join(" · ")}
                      body={
                        <div>
                          <p className="mb-1 font-semibold">
                            Methods &amp; tools used by this scholar
                          </p>
                          <ul className="list-disc space-y-0.5 pl-4">
                            {f.exemplarTools.map((tool) => (
                              <li key={tool}>{tool}</li>
                            ))}
                          </ul>
                        </div>
                      }
                    >
                      {pill}
                    </HoverTooltip>
                  ) : (
                    pill
                  )}
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
                  {f.definition ? (
                    <FamilyDefinitionTip
                      definition={f.definition}
                      familyLabel={f.familyLabel}
                      generated={f.definitionSource === "generated"}
                    />
                  ) : null}
                </div>
                {f.exemplarTools.length > 0 ? (
                  <ExemplarToolsLine
                    tools={f.exemplarTools}
                    contexts={f.exemplarContexts}
                    className="text-muted-foreground mt-0.5 font-mono text-xs"
                  />
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
