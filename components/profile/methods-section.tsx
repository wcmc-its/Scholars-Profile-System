"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, EyeOff, Info, Square, SquareCheck, X } from "lucide-react";

import { MethodsHeading } from "@/components/profile/methods-heading";
import { ProvenanceRail, type ProvenanceRailItem } from "@/components/method/provenance-rail";
import { usePublicationModal } from "@/components/publication/publication-modal";
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

/** Surface A eyebrow — the verbatim sentence is sourced from THIS scholar's own
 *  papers (spec §4.2-A6 / panel mockup). Differs from the modal / Surface B
 *  eyebrow ("Verbatim, from a paper using it"); the per-surface eyebrow is the
 *  only documented difference. */
const SURFACE_A_EYEBROW = "Verbatim, from this scholar's papers";

/**
 * #1119 / #1167 (Surface A, PROFILE_FACET_REDESIGN on) — the exemplar member-tool
 * line ("CheXpert · MIMIC-CXR"). When a tool has a usage snippet
 * (`exemplarContexts[name]`, populated only under METHODS_LENS_TOOL_CONTEXT — the
 * server empties it otherwise, so the off-path renders byte-identically to the
 * prior `join(" · ")`), its name becomes a dotted-underline button that, on hover
 * AND focus, hands a {@link ProvenanceRailItem} up to the section host via
 * `onHover`. The host owns the current rail item and retains the last-hovered one
 * (it never blanks on mouse-leave — spec §4.2-A1). Tools WITHOUT a snippet stay
 * plain muted text (is_evidenced drives the affordance — spec A2). The first
 * non-evidenced token reads as a plain descriptive parent label.
 *
 * Snippet text is rendered ONLY in the rail (never re-fed to a model); React
 * escapes it there. The source link is built only when a per-tool source pmid is
 * carried (`pmids[name]`); otherwise the rail item's `source` is null.
 */
function ExemplarToolsLine({
  tools,
  contexts,
  pmids,
  className,
  onHover,
  onSource,
}: {
  tools: string[];
  contexts: Record<string, string> | undefined;
  /** #1158 — per-exemplar-tool source pmid map, keyed by the SAME display name. */
  pmids: Record<string, string> | undefined;
  className: string;
  /** Set the host's current rail item on hover/focus of an evidenced tool. */
  onHover: (item: ProvenanceRailItem) => void;
  /** Build the rail `source` for a tool's source pmid (null when none). */
  onSource: (pmid: string | undefined) => ProvenanceRailItem["source"];
}) {
  // Defensive: a client payload built before #1119/#1158 (e.g. the #801
  // sensitive-reveal route) may omit either field. Flag-off (and any family with
  // no resolved snippets) renders the plain dotted join exactly as before — one
  // text node, no triggers, no rail interaction.
  const ctx = contexts ?? {};
  const pmidMap = pmids ?? {};
  const hasAnyContext = tools.some((t) => ctx[t]);
  if (!hasAnyContext) {
    return <div className={className}>{tools.join(" · ")}</div>;
  }
  return (
    <div className={className}>
      {tools.map((tool, i) => {
        const context = ctx[tool];
        const makeItem = (): ProvenanceRailItem => ({
          eyebrow: SURFACE_A_EYEBROW,
          term: tool,
          sentence: context ?? "",
          source: onSource(pmidMap[tool]),
        });
        return (
          <span key={tool}>
            {i > 0 ? " · " : null}
            {context ? (
              <button
                type="button"
                className="hover:text-foreground focus-visible:text-foreground relative z-10 underline decoration-dotted underline-offset-2"
                aria-label={`Usage example for ${tool}`}
                onMouseEnter={() => onHover(makeItem())}
                onFocus={() => onHover(makeItem())}
              >
                {tool}
              </button>
            ) : (
              // Descriptive (non-evidenced) parent token — plain muted label, no
              // underline, not interactive (spec A2).
              tool
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * #1119 (legacy / PROFILE_FACET_REDESIGN off) — the exemplar member-tool line with
 * the prior Radix hover Tooltip ("How <tool> was used: …"). Kept byte-identical to
 * the pre-redesign render so the flag-off path is unchanged; the redesign path uses
 * {@link ExemplarToolsLine} (the persistent provenance rail) instead.
 */
function LegacyExemplarToolsLine({
  tools,
  contexts,
  className,
}: {
  tools: string[];
  contexts: Record<string, string> | undefined;
  className: string;
}) {
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
 * lens. Behind PROFILE_FACET_REDESIGN (`facetRedesignEnabled`):
 *
 *  - OFF (default, current prod): renders EXACTLY as today — the #819 filter pill,
 *    #801 EyeOff reveal, #824 ArrowUpRight browse-out link, whole-row overlay, and
 *    the #1119 "How <tool> was used" Radix tooltip. Byte-identical to the
 *    pre-redesign output (the cdk env var documents this invariant).
 *  - ON: the #1167 two-column redesign — explicit checkbox rows on the left and a
 *    persistent provenance rail on the right that shows the verbatim usage sentence
 *    behind a hovered/focused tool (spec §4 — A1/A2/A4/A5). The rail retains the
 *    last-hovered item and never overlays the rows; its source link opens the
 *    in-app publication modal (Q-7).
 *
 * The public `families` prop already excludes #800-suppressed and #801-sensitive
 * families. #801 reveal: when the audience gate is active, this island fetches the
 * scholar's gated families from /api/profile/[cwid]/sensitive-families (internal
 * viewers only; external viewers get []) and merges them in rank order with a
 * light "hidden from the public profile" marker.
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
  /** #819 — when on, the row checkbox/label toggles the publication filter
   *  (mirrors Topics). When off, the lens is display-only (default). */
  filterEnabled?: boolean;
  /** METHODS_LENS_PAGES — when on, the redesign's count+arrow pill NAVIGATES to
   *  the cross-scholar `/methods/**` family page (and the legacy path gets a
   *  separate trailing browse-out link + a `/methods` hub "+ N more"). When off,
   *  the pill is a non-navigating count chip. */
  pagesEnabled?: boolean;
  /** #819 — familyIds currently selected (drives the row's checked state). */
  selectedFamilyIds?: string[];
  /** #819 — toggle a family in the filter. */
  onFamilyToggle?: (familyId: string) => void;
  /** #819 — hands the revealed (#801) families back up to the owner so the family
   *  filter can resolve their PMIDs; fired once when the reveal fetch resolves. */
  onRevealedFamilies?: (families: ScholarFamilyView[]) => void;
  /** PROFILE_FACET_REDESIGN — when off (default), this section renders EXACTLY
   *  as today (the #829 selected pill, #801 EyeOff reveal, #824 ArrowUpRight
   *  browse-out link, whole-row overlay, #1119 Radix tooltip). When on, rows
   *  become the #1167 two-column checkbox + provenance-rail redesign.
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
  // #1167 / A1 — the current rail item. Set on tool hover AND focus; deliberately
  // NEVER cleared on mouse-leave/blur — the rail retains the last-hovered content
  // (spec §4.2-A1 "never blanks"). null only before any interaction. Used only by
  // the redesign branch (harmless when the flag is off).
  const [hovered, setHovered] = useState<ProvenanceRailItem | null>(null);

  // Q-7 — the source-publication click-through opens the in-app publication modal.
  // The profile path is always under <PublicationModalProvider> (mounted in
  // app/(public)/layout.tsx, the sole layout for every surface that renders this
  // panel), so the hook never throws here. Called unconditionally per the rules of
  // hooks; it has no effect on the flag-off render.
  const { open } = usePublicationModal();
  // Build a rail `source` for a tool's source pmid: an in-app modal opener when a
  // VALID (digit) pmid is carried, else null (omit-when-absent — pre-#1158 rows
  // carry no pmid; mirrors the digit guard in lib/api/method-exemplar.ts).
  const makeSource = (pmid: string | undefined): ProvenanceRailItem["source"] =>
    pmid && /^\d+$/.test(pmid)
      ? { label: "View source publication", onSelect: () => open(pmid) }
      : null;

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

  // ──────────────────────────────────────────────────────────────────────────
  // LEGACY (PROFILE_FACET_REDESIGN off) — byte-identical to the pre-redesign
  // render: flat INITIAL_VISIBLE cap, #819 filter pill, #1119 Radix tooltip.
  // ──────────────────────────────────────────────────────────────────────────
  if (!facetRedesignEnabled) {
    const visible = rows.slice(0, INITIAL_VISIBLE);
    const remaining = rows.length - visible.length;
    return (
      <section className="mb-6">
        <MethodsHeading pagesEnabled={pagesEnabled} />
        <p className="text-muted-foreground mb-3 text-sm">
          {`Inferred from the datasets, models & methods named in this scholar's publications${filterable ? " · click to filter publications" : ""}`}
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
                    <LegacyExemplarToolsLine
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

  // ──────────────────────────────────────────────────────────────────────────
  // REDESIGN (PROFILE_FACET_REDESIGN on) — #1167 two-column checkbox + rail.
  // ──────────────────────────────────────────────────────────────────────────
  // #1/#2 — budget UNSELECTED rows independently of selected ones.
  // Selected/pinned families ALWAYS render, in rank order and in place;
  // unselected families fill up to `unselectedVisible`. Order is preserved from
  // the rank-sorted `rows` so nothing reflows on toggle (#14).
  let shownUnselected = 0;
  const visible = rows.filter((f) => {
    if (selectedSet.has(f.familyId)) return true; // selected never budgeted out (#2)
    if (shownUnselected < unselectedVisible) {
      shownUnselected += 1;
      return true;
    }
    return false;
  });
  const totalUnselected = rows.reduce((n, f) => n + (selectedSet.has(f.familyId) ? 0 : 1), 0);
  const remaining = Math.max(0, totalUnselected - shownUnselected);

  // A2 — only claim affordances that are actually live. The "Tick the box" clause
  // needs the filter to be wired; the "pill opens publications" clause needs the
  // cross-scholar pages; the "underlined terms" clause needs at least one tool
  // with a usage snippet (METHODS_LENS_TOOL_CONTEXT on). Avoids instructing users
  // to use controls that do nothing in a partially-flagged env.
  const hasAnyEvidencedTool = visible.some((f) => {
    const ctx = f.exemplarContexts ?? {};
    return f.exemplarTools.some((t) => ctx[t]);
  });
  const captionParts: string[] = [];
  if (filterable) captionParts.push("Tick the box to filter this profile in place.");
  if (hasAnyEvidencedTool)
    captionParts.push("Underlined terms have a usage example — hover or focus to preview.");
  if (pagesEnabled) captionParts.push("The pill opens that method's publications.");
  const caption = captionParts.join(" ");

  return (
    <section className="mb-6">
      <MethodsHeading pagesEnabled={pagesEnabled} />
      <p className="text-muted-foreground mb-3 text-sm">
        {familyCounts
          ? "Counts shown within current filter"
          : `Inferred from the datasets, models & methods named in this scholar's publications${filterable ? " · select to filter" : ""}`}
      </p>
      <TooltipProvider>
        {/* A1 — persistent two-column layout: family/tool list (left) + the
            provenance rail (right) on ≥sm; the rail stacks below the list on
            mobile (never display:none, so the snippet + source action + aria-live
            announcement stay reachable on every viewport). The rail never
            overlays the rows. */}
        <div className="grid items-start gap-[18px] sm:grid-cols-[minmax(0,1fr)_236px]">
          <div>
            <ul className="border-border-strong divide-border-strong divide-y overflow-hidden rounded-lg border bg-background">
              {visible.map((f) => {
                // Explicit checkbox rows (Tabler ti-square/ti-square-check →
                // lucide Square/SquareCheck; literal hex → the
                // --color-facet-method-* tokens). The WHOLE row toggles the
                // family filter (the left checkbox is the visual selection
                // control); the count+arrow PILL on the right NAVIGATES, and the
                // #801 EyeOff / #879 definition triggers stay independently
                // clickable via z-10.
                const isSelected = selectedSet.has(f.familyId);
                const inFilter = familyCounts ? (familyCounts.get(f.familyId) ?? 0) : undefined;
                const zeroCount = inFilter === 0;
                // #7 — a SELECTED family with a 0 contextual count contributes
                // nothing under the OTHER active filters. Deliberate, NOT an
                // error: keep full opacity (filled + checked + remove-X) and a
                // quiet inset ring, and mute the count. #14 — an UNSELECTED
                // zero-count row is the dim/inert state (opacity-45), a
                // different signal.
                const selectedZero = isSelected && zeroCount;
                const dimZero = zeroCount && !isSelected; // the only opacity-45 case
                return (
                  <li
                    key={f.familyId}
                    className={
                      selectedZero
                        ? "facet-chip-transition relative flex items-center gap-3 bg-[var(--color-facet-method-fill)] px-3.5 py-3.5 ring-1 ring-inset ring-[var(--color-facet-method-border)]"
                        : isSelected
                          ? "facet-chip-transition relative flex items-center gap-3 bg-[var(--color-facet-method-fill)] px-3.5 py-3.5 dark:ring-1 dark:ring-inset dark:ring-[var(--color-facet-method-border)]"
                          : "facet-chip-transition relative flex items-center gap-3 px-3.5 py-3.5"
                    }
                    data-selected-zero={selectedZero ? "true" : undefined}
                  >
                    {/* Whole-row toggle: a full-bleed transparent button so any
                        click on the row toggles the family filter. The navigate
                        pill + EyeOff + definition triggers sit above it via
                        z-10. Only rendered when the filter is wired (#819);
                        otherwise the redesign is a display-only lens. */}
                    {filterable ? (
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={f.familyLabel}
                        onClick={() => onFamilyToggle?.(f.familyId)}
                        className="absolute inset-0"
                      />
                    ) : null}
                    {/* A4 — the left checkbox = the selection (filter) control.
                        Suppressed when the filter is not wired (display-only). */}
                    {filterable ? (
                      isSelected ? (
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
                      )
                    ) : null}
                    <div className={dimZero ? "min-w-0 flex-1 opacity-45" : "min-w-0 flex-1"}>
                      <div className="flex items-center gap-1.5">
                        {/* A5 — the family title is the prominent, scannable
                            unit (15px / medium). */}
                        <span
                          className={
                            isSelected
                              ? "text-[15px] font-medium text-[var(--color-facet-method-text)]"
                              : "text-foreground text-[15px] font-medium"
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
                        {f.definition ? (
                          <FamilyDefinitionTip
                            definition={f.definition}
                            familyLabel={f.familyLabel}
                            generated={f.definitionSource === "generated"}
                          />
                        ) : null}
                      </div>
                      {/* A5 — the monospace verbatim tool row recedes: smaller +
                          muted + more vertical air (mt-1, looser leading). */}
                      {f.exemplarTools.length > 0 ? (
                        <ExemplarToolsLine
                          tools={f.exemplarTools}
                          contexts={f.exemplarContexts}
                          pmids={f.exemplarContextPmids}
                          onHover={setHovered}
                          onSource={makeSource}
                          className={
                            isSelected
                              ? "mt-1 font-mono text-xs leading-relaxed text-[var(--color-facet-method-count)]"
                              : "text-muted-foreground mt-1 font-mono text-xs leading-relaxed"
                          }
                        />
                      ) : null}
                    </div>
                    {/* A4 — the count+arrow PILL on the right NAVIGATES to the
                        family's publications (z-10 lifts it above the whole-row
                        filter toggle). Selected: a remove (X) replaces the
                        arrow. When METHODS_LENS_PAGES is off there is no
                        cross-scholar page, so the pill is a non-navigating count
                        chip. */}
                    {isSelected && filterable ? (
                      <button
                        type="button"
                        aria-label={`Remove ${f.familyLabel} filter`}
                        onClick={() => onFamilyToggle?.(f.familyId)}
                        className={
                          "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium tabular-nums " +
                          (selectedZero
                            ? "text-[var(--color-facet-method-count)]"
                            : "text-[var(--color-facet-method-text)]")
                        }
                      >
                        {inFilter !== undefined ? (
                          selectedZero ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex items-center gap-1"
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
                            <span className="inline-flex items-center gap-1">
                              {inFilter}{" "}
                              <span className="font-normal text-[var(--color-facet-method-count)]">
                                of {f.pubCount}
                              </span>
                            </span>
                          )
                        ) : (
                          f.pubCount
                        )}
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : pagesEnabled && !f.sensitive ? (
                      <Link
                        href={methodFamilyPath(f.supercategory, f.familyId, f.familyLabel)}
                        aria-label={`${f.pubCount} publications · ${f.familyLabel}`}
                        className={
                          "border-border-strong relative z-10 inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-medium tabular-nums hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] " +
                          (dimZero ? "opacity-45 " : "") +
                          (isSelected
                            ? "text-[var(--color-facet-method-text)]"
                            : "text-foreground")
                        }
                      >
                        {inFilter !== undefined ? (
                          <span className="inline-flex items-center gap-1">
                            {inFilter}{" "}
                            <span className="text-muted-foreground font-normal">
                              of {f.pubCount}
                            </span>
                          </span>
                        ) : (
                          f.pubCount
                        )}
                        <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    ) : (
                      // METHODS_LENS_PAGES off — no cross-scholar page; the pill
                      // is a non-navigating count chip.
                      <span
                        className={
                          "shrink-0 text-sm font-medium tabular-nums " +
                          (dimZero
                            ? "opacity-45 "
                            : isSelected
                              ? "text-[var(--color-facet-method-text)] "
                              : "text-foreground ")
                        }
                      >
                        {inFilter !== undefined ? (
                          <span className="inline-flex items-center gap-1">
                            {inFilter}{" "}
                            <span className="text-muted-foreground font-normal">
                              of {f.pubCount}
                            </span>
                          </span>
                        ) : (
                          f.pubCount
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* A2 — the one-line caption disambiguating the row controls. Only the
                clauses for live affordances are shown. */}
            {caption ? (
              <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{caption}</span>
              </p>
            ) : null}
            {/* #3 — inline EXPAND (never navigates); #4 — the only navigate-away
                control is MethodsHeading's "Browse all methods ->", so the row
                footer here is purely an in-flow disclosure (#5 — no nested
                scroll). */}
            {remaining > 0 || unselectedVisible > UNSELECTED_INITIAL ? (
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
            ) : null}
          </div>
          {/* A1 — the persistent provenance rail. Retains the last-hovered item;
              shows a quiet placeholder before any interaction (and a neutral hint
              when no tool carries a usage snippet — METHODS_LENS_TOOL_CONTEXT
              off). Kept in the DOM + a11y tree at all widths (stacks below the
              list on mobile). */}
          <ProvenanceRail
            item={hovered}
            placeholder={
              hasAnyEvidencedTool
                ? "Hover an underlined tool to see the verbatim sentence it came from."
                : "Usage examples appear here as they become available."
            }
            className="self-start"
          />
        </div>
      </TooltipProvider>
    </section>
  );
}
