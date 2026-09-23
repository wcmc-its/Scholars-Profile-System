/**
 * OverviewIncludePicker — the three-state source picker inside the Sources drawer
 * (#742 spec §2 / Phase 2). The scholar shapes which **publications**, **funding**
 * awards, **methods**, **education**, and **titles & positions** ground their
 * generated bio. A pure controlled surface: it owns no fetch and no open state —
 * the parent ({@link "./overview-source-drawer"}) holds the
 * {@link OverviewSourceOptions} payload and the {@link OverviewSelectionDeltas},
 * and this renders them and emits the next deltas.
 *
 * #742 §2.5 — the THREE-STATE model. Every record is exactly one of:
 *   - **default** — in the recommended auto-set (the `defaultSelected` featured
 *     tier) or absent from it (the Available tier), with no scholar override;
 *   - **pinned-in** — forced in (the centrality override; "add merges into pin");
 *   - **excluded** — forced out (a persistent veto; the record STAYS in the
 *     profile, it just won't ground THIS overview).
 * The scholar's overrides are stored as DELTAS against the auto-set, not a
 * snapshot of checkboxes, so they survive every regenerate (the auto-set is
 * recomputed each run and the deltas re-applied on top).
 *
 * §4.3 — tiers / scores are BACKEND-ONLY and never render. The UI drives off the
 * `reason` line, the featured/available split, and order. Each section's controls
 * follow the §8 per-type set: publications / funding / methods get pin-to-protect
 * AND exclude on featured rows; titles & education get exclude only (their
 * auto-set is stable run-to-run); every Available-tail row gets "add and pin".
 *
 * The "led ⇄ all" toggle (publications, funding) flips which candidates the
 * Available tail reveals (middle-author papers, co-investigator grants). It is
 * carried in the deltas (`publicationPositions` / `fundingRoles`) so it is durable;
 * the auto-set re-derivation it implies is wired server-side in a later phase.
 */
"use client";

import * as React from "react";
import { ChevronDown, Info, Pin, TriangleAlert } from "lucide-react";

import { PubTitle } from "@/components/publication/pub-html";
import { fundingRoleLabel } from "@/lib/funding-roles";
import type {
  OverviewSourceEducation,
  OverviewSourceFunding,
  OverviewSourceOptions,
  OverviewSourcePublication,
  OverviewSourceTitle,
} from "@/lib/edit/overview-facts";
import {
  OVERVIEW_MIN_PUBLICATIONS,
  OVERVIEW_SELECTION_MAX_ITEMS,
  type OverviewPositionMode,
  type OverviewRecordIds,
  type OverviewRecordType,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";
import { cn } from "@/lib/utils";

type ToolOption = OverviewSourceOptions["tools"][number];

type OverviewIncludePickerProps = {
  options: OverviewSourceOptions;
  deltas: OverviewSelectionDeltas;
  onChange: (next: OverviewSelectionDeltas) => void;
  disabled?: boolean;
};

/** The minimum visible publications below which the overview reads as thin (§2.5) —
 *  shared with the server-side generator guard (§2.3) so the two never drift. */
const MIN_PUBLICATIONS = OVERVIEW_MIN_PUBLICATIONS;

// ---------------------------------------------------------------------------
// Delta bag helpers — immutable add / remove / toggle on the per-type id bags.
// ---------------------------------------------------------------------------

function bagHas(bag: OverviewRecordIds, type: OverviewRecordType, id: string): boolean {
  return (bag[type] ?? []).includes(id);
}

function bagAdd(bag: OverviewRecordIds, type: OverviewRecordType, id: string): OverviewRecordIds {
  if (bagHas(bag, type, id)) return bag;
  return { ...bag, [type]: [...(bag[type] ?? []), id] };
}

function bagRemove(bag: OverviewRecordIds, type: OverviewRecordType, id: string): OverviewRecordIds {
  if (!bagHas(bag, type, id)) return bag;
  const next = (bag[type] ?? []).filter((x) => x !== id);
  const out = { ...bag };
  if (next.length > 0) out[type] = next;
  else delete out[type];
  return out;
}

/** Pin / un-pin a record. Pinning also lifts any veto on it (a pin is an
 *  inclusion; the two states are mutually exclusive in intent). */
function togglePin(deltas: OverviewSelectionDeltas, type: OverviewRecordType, id: string): OverviewSelectionDeltas {
  if (bagHas(deltas.pinned, type, id)) {
    return { ...deltas, pinned: bagRemove(deltas.pinned, type, id) };
  }
  return {
    ...deltas,
    pinned: bagAdd(deltas.pinned, type, id),
    excluded: bagRemove(deltas.excluded, type, id),
  };
}

/** Veto a record (the X). Exclude wins over a stale pin, so we also drop it from
 *  the pinned bag — the resolved state is unambiguous. */
function exclude(deltas: OverviewSelectionDeltas, type: OverviewRecordType, id: string): OverviewSelectionDeltas {
  return {
    ...deltas,
    excluded: bagAdd(deltas.excluded, type, id),
    pinned: bagRemove(deltas.pinned, type, id),
  };
}

/** Lift a veto (the Undo) — back to the record's default tier. */
function undoExclude(deltas: OverviewSelectionDeltas, type: OverviewRecordType, id: string): OverviewSelectionDeltas {
  return { ...deltas, excluded: bagRemove(deltas.excluded, type, id) };
}

// ---------------------------------------------------------------------------
// Record view model — each section maps its options to a flat list of records
// with a tier bucket; the renderer is type-agnostic.
// ---------------------------------------------------------------------------

/** featured = the recommended auto-set; more = additional eligible records behind
 *  "+ N more"; mid = off-position records (middle author / co-I) behind the toggle. */
type Bucket = "featured" | "more" | "mid";

type RecordView = {
  id: string;
  /** The display title — a node so publications can use {@link PubTitle}. */
  title: React.ReactNode;
  meta: string[];
  /** The §7.1 human reason ("why this?") — never a score. */
  reason?: string;
  /** Methods carry usage evidence shown under "show evidence". */
  evidence?: string;
  bucket: Bucket;
  externalHref?: string;
  /** Publication-only fields backing the §5 sort control (not rendered raw). */
  impact?: number | null;
  year?: number | null;
  firstOrLast?: boolean;
};

function pubRole(p: OverviewSourcePublication): string | null {
  return p.authorPosition === "first"
    ? "first author"
    : p.authorPosition === "last"
      ? "last author"
      : p.authorPosition === "middle"
        ? "middle author"
        : null;
}

function buildPublications(options: OverviewSourceOptions): RecordView[] {
  return options.publications.map((p) => {
    // #742 Phase 2c flip — the featured tier is the §5.1 auto-set (`featured`), not
    // the v3.1 `defaultSelected` rule. A first/last pub outside the auto-set drops to
    // the "+ more" tail; middle-author work sits behind the "all positions" toggle.
    const bucket: Bucket = p.featured ? "featured" : p.isFirstOrLast ? "more" : "mid";
    return {
      id: p.pmid,
      title: <PubTitle as="span" value={p.title} />,
      // Every citation carries its PMID (the row already links to PubMed; the number is what
      // a reader can search or paste).
      meta: [
        p.venue ?? null,
        pubRole(p),
        p.year != null ? String(p.year) : null,
        `PMID ${p.pmid}`,
      ].filter((x): x is string => Boolean(x)),
      reason: p.reason,
      bucket,
      externalHref: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
      impact: p.impact,
      year: p.year,
      firstOrLast: p.isFirstOrLast,
    };
  });
}

function fundingMeta(f: OverviewSourceFunding): string[] {
  // Spelled out, not the raw InfoEd code — the scholar reading their own sources
  // should not have to know that "Co-PI" means the non-contact PD/PI of an MPI award.
  return [
    f.role ? fundingRoleLabel(f.role) : null,
    f.endYear != null ? String(f.endYear) : "active",
  ].filter((x): x is string => Boolean(x));
}

function buildFunding(options: OverviewSourceFunding[]): RecordView[] {
  return options.map((f) => ({
    id: f.id,
    title: f.title ?? f.funder,
    meta: fundingMeta(f),
    reason: f.reason,
    // Lead grants are the auto-set; co-investigator work sits behind "all roles".
    bucket: f.defaultSelected ? "featured" : "mid",
  }));
}

function buildMethods(options: ToolOption[]): RecordView[] {
  return options.map((t) => ({
    id: t.toolName,
    title: t.toolName,
    meta: [`${t.pmidCount} ${t.pmidCount === 1 ? "paper" : "papers"}`],
    evidence: t.reason,
    // Multi-paper methods are featured; single-paper long-tail sits behind "+ more".
    bucket: t.defaultSelected ? "featured" : "more",
  }));
}

function titleMeta(t: OverviewSourceTitle): string[] {
  // Organization, plus an end marker for a past role (current roles read clean).
  return [t.organization, t.isCurrent ? null : t.endYear != null ? `until ${t.endYear}` : "past"].filter(
    (x): x is string => Boolean(x),
  );
}

/** Titles & positions — the primary appointment is the always-shown scaffolding
 *  line (handled by the section), never a toggleable row, so it is filtered out
 *  here. Significant current roles feature; the secondary / interim / past tail
 *  sits behind "+ N more". */
function buildTitles(options: OverviewSourceTitle[]): RecordView[] {
  return options
    .filter((t) => !t.isPrimary)
    .map((t) => ({
      id: t.id,
      title: t.title,
      meta: titleMeta(t),
      reason: t.reason,
      bucket: t.featured ? "featured" : "more",
    }));
}

function educationTitle(e: OverviewSourceEducation): string {
  return e.field ? `${e.degree}, ${e.field}` : e.degree;
}

/** Education — terminal / professional degrees feature; minor certificates and
 *  training entries sit behind "+ N more". */
function buildEducation(options: OverviewSourceEducation[]): RecordView[] {
  return options.map((e) => ({
    id: e.id,
    title: educationTitle(e),
    meta: [e.institution, e.year != null ? String(e.year) : null].filter(
      (x): x is string => Boolean(x),
    ),
    reason: e.reason,
    bucket: e.featured ? "featured" : "more",
  }));
}

// ---------------------------------------------------------------------------
// Section descriptor — the per-type rules (§8 control set + copy).
// ---------------------------------------------------------------------------

type SectionSpec = {
  type: OverviewRecordType;
  heading: string;
  subtitle?: React.ReactNode;
  /** A leading, non-toggleable line shown above the rows (titles' "Always shown"
   *  primary appointment — it always grounds the bio, so it is never a row). */
  scaffold?: React.ReactNode;
  records: RecordView[];
  /** Featured rows offer pin-to-protect (volatile types only). */
  pinnable: boolean;
  /** The "why this?" / "show evidence" reveal label, or null for no reveal. */
  whyLabel: string | null;
  /** The led ⇄ all position toggle, or null. */
  toggle: { mode: OverviewPositionMode; onMode: (m: OverviewPositionMode) => void; ledLabel: string; allLabel: string } | null;
  /** "+ N more …" copy, given the hidden count + a few example record names. */
  moreCopy: (n: number, examples: string[]) => string;
  /** A leading empty-state line (funding's "no grants you lead are active"). */
  emptyLed?: string;
}

// ---------------------------------------------------------------------------

export function OverviewIncludePicker({
  options,
  deltas,
  onChange,
  disabled = false,
}: OverviewIncludePickerProps) {
  const showTools = options.tools.length > 0;
  const [pubSort, setPubSort] = React.useState<PubSortKey>("recommended");

  const publications = React.useMemo(() => buildPublications(options), [options]);
  const funding = React.useMemo(() => buildFunding(options.funding), [options.funding]);
  const methods = React.useMemo(() => buildMethods(options.tools), [options.tools]);
  const titles = React.useMemo(() => buildTitles(options.titles ?? []), [options.titles]);
  const education = React.useMemo(() => buildEducation(options.education ?? []), [options.education]);
  // The "Always shown" scaffold — name · primary title · department — is sourced from
  // the SAME identity strings the generator grounds on (not the appointment row), so it
  // can never drift from what actually anchors the bio (#742 §2.2).
  const identity = options.identity;
  const scaffoldText = React.useMemo(() => {
    if (!identity) return null;
    const parts = [identity.name, identity.primaryTitle, identity.primaryDepartment].filter(
      (x): x is string => Boolean(x),
    );
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [identity]);
  const hasPrimaryTitle = Boolean(identity?.primaryTitle);

  // Count visible publications for the §2.5 thin-overview warning.
  const visiblePubs = publications.filter((r) => {
    if (bagHas(deltas.excluded, "publication", r.id)) return false;
    if (bagHas(deltas.pinned, "publication", r.id)) return true;
    return r.bucket === "featured";
  }).length;

  function setPositionMode(key: "publicationPositions" | "fundingRoles", mode: OverviewPositionMode) {
    onChange({ ...deltas, [key]: mode });
  }

  const specs: SectionSpec[] = [
    {
      type: "publication",
      heading: "Publications",
      subtitle: "First- and last-author work, weighted toward recent and high-impact papers.",
      records: publications,
      pinnable: true,
      whyLabel: "Why this source",
      toggle: {
        mode: deltas.publicationPositions,
        onMode: (m) => setPositionMode("publicationPositions", m),
        ledLabel: "Led",
        allLabel: "All positions",
      },
      moreCopy: (n) => `Show ${n} more`,
    },
    {
      type: "funding",
      heading: "Funding",
      subtitle: "Grants you lead, active and recently completed.",
      records: funding,
      pinnable: true,
      whyLabel: "Why this source",
      toggle: {
        mode: deltas.fundingRoles,
        onMode: (m) => setPositionMode("fundingRoles", m),
        ledLabel: "Led",
        allLabel: "All roles",
      },
      moreCopy: (n) => `Show ${n} more`,
      emptyLed: 'No grants you lead are active. Switch to "All roles" to include co-investigator grants.',
    },
    ...(showTools
      ? [
          {
            type: "method",
            heading: "Methods & tools",
            subtitle: "Methods named across your papers, with how often they appear.",
            records: methods,
            pinnable: true,
            whyLabel: "Show evidence",
            toggle: null,
            moreCopy: (n: number, ex: string[]) =>
              `Show ${n} single-paper ${n === 1 ? "method" : "methods"}${
                ex.length ? ` (${ex.join(", ")}…)` : ""
              }, usually too thin to feature`,
          } satisfies SectionSpec,
        ]
      : []),
    ...(hasPrimaryTitle || titles.length > 0
      ? [
          {
            type: "title",
            heading: "Titles",
            subtitle: "Leadership and named roles beyond the primary appointment.",
            scaffold:
              hasPrimaryTitle && scaffoldText ? (
                <>
                  <span className="text-foreground">Always shown:</span> {scaffoldText}
                </>
              ) : undefined,
            records: titles,
            // Titles are stable run-to-run, so featured rows are exclude-only (no
            // pin-to-protect); the Available tail still offers add-and-pin.
            pinnable: false,
            whyLabel: "Why this source",
            toggle: null,
            moreCopy: (n: number) => `Show ${n} more`,
          } satisfies SectionSpec,
        ]
      : []),
    ...(education.length > 0
      ? [
          {
            type: "education",
            heading: "Education",
            subtitle: "Terminal and professional degrees.",
            records: education,
            pinnable: false,
            whyLabel: "Why this source",
            toggle: null,
            moreCopy: (n: number) => `Show ${n} more`,
          } satisfies SectionSpec,
        ]
      : []),
  ];

  const [tab, setTab] = React.useState<OverviewRecordType>("publication");
  const active = specs.find((sp) => sp.type === tab) ?? specs[0];
  // A tab's count is what grounds the draft: featured or pinned, not hidden.
  const includedCount = (sp: SectionSpec) =>
    sp.records.filter(
      (r) =>
        !bagHas(deltas.excluded, sp.type, r.id) &&
        (bagHas(deltas.pinned, sp.type, r.id) || r.bucket === "featured"),
    ).length;

  return (
    <div className="flex flex-col" data-testid="overview-include-picker">
      <p className="bg-apollo-surface-2 border-apollo-border text-muted-foreground border-b px-3.5 py-2.5 text-[13px] text-pretty">
        Unchecking a source only affects the AI draft; it stays on the profile. Pinned sources are
        always used, and pins and exclusions carry over to every new draft.
      </p>
      {visiblePubs < MIN_PUBLICATIONS && (
        <p
          className="text-apollo-amber flex items-center gap-1.5 px-3.5 pt-2 text-xs"
          data-testid="overview-source-minwarn"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          This leaves fewer than {MIN_PUBLICATIONS} papers — the overview will be brief.
        </p>
      )}
      {visiblePubs > OVERVIEW_SELECTION_MAX_ITEMS && (
        // §2.1 decision #3 — pins ride ahead of the auto-set server-side, but the
        // selection is still capped: warn when the chosen papers alone exceed the
        // budget, since the lowest-ranked won't reach the overview.
        <p
          className="text-apollo-amber flex items-center gap-1.5 px-3.5 pt-2 text-xs"
          data-testid="overview-source-maxwarn"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          That&rsquo;s more than {OVERVIEW_SELECTION_MAX_ITEMS} papers — only the top{" "}
          {OVERVIEW_SELECTION_MAX_ITEMS} will ground this overview.
        </p>
      )}

      <div
        role="tablist"
        aria-label="Source types"
        className="border-apollo-border flex flex-wrap items-end gap-1 overflow-x-auto border-b px-2.5 pt-2"
      >
        {specs.map((sp) => {
          const selected = sp.type === active.type;
          return (
            <button
              key={sp.type}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(sp.type)}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 pt-1.5 pb-2.5 text-sm whitespace-nowrap",
                selected
                  ? "text-foreground font-semibold shadow-[inset_0_-2px_0_var(--apollo-bar)]"
                  : "text-muted-foreground",
              )}
              data-testid={`overview-source-tab-${sp.type}`}
            >
              {sp.heading}
              <span className="bg-apollo-surface-2 text-muted-foreground rounded-lg px-1.5 text-[11px] font-semibold">
                {includedCount(sp)}
              </span>
            </button>
          );
        })}
      </div>

      <Section
        key={active.type}
        spec={active}
        deltas={deltas}
        onChange={onChange}
        disabled={disabled}
        sortState={active.type === "publication" ? { value: pubSort, set: setPubSort } : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section — header (toggle), subtitle, optional sort, the visible rows, the
// "+ N more" reveal, and the toggle-revealed tail.
// ---------------------------------------------------------------------------

function Section({
  spec,
  deltas,
  onChange,
  disabled,
  sortState,
}: {
  spec: SectionSpec;
  deltas: OverviewSelectionDeltas;
  onChange: (next: OverviewSelectionDeltas) => void;
  disabled: boolean;
  sortState?: { value: PubSortKey; set: (k: PubSortKey) => void };
}) {
  const [showMore, setShowMore] = React.useState(false);
  const { type, records, toggle } = spec;

  const isPinned = (id: string) => bagHas(deltas.pinned, type, id);
  const isExcluded = (id: string) => bagHas(deltas.excluded, type, id);

  const allMode = toggle?.mode === "all";

  // A record is shown when it is excluded (so its struck row + Undo stay reachable
  // regardless of tier), pinned, featured, or its hidden bucket is revealed.
  const shown = (r: RecordView): boolean => {
    if (isExcluded(r.id)) return true;
    if (isPinned(r.id)) return true;
    if (r.bucket === "featured") return true;
    if (r.bucket === "more") return showMore;
    return allMode; // "mid"
  };

  const visible = sortState
    ? sortPublications(records.filter(shown), sortState.value)
    : records.filter(shown);

  // The "+ N more" tail: more-bucket records not pinned, not vetoed, not revealed.
  const hiddenMore = records.filter(
    (r) => r.bucket === "more" && !isPinned(r.id) && !isExcluded(r.id) && !showMore,
  ).length;

  // The "no grants you lead" empty state is about CANDIDATES, not the current
  // veto state: it shows only when the scholar has zero led (featured) records,
  // never because they hid their only one (that record still renders, struck).
  const hasLedCandidate = records.some((r) => r.bucket === "featured");
  const showEmptyLed = Boolean(spec.emptyLed) && !allMode && !hasLedCandidate;

  // A few example names for the "+ N more" copy — only string titles (methods).
  const moreExamples = records
    .filter((r) => r.bucket === "more" && !isPinned(r.id) && !isExcluded(r.id) && typeof r.title === "string")
    .slice(0, 3)
    .map((r) => r.title as string);

  return (
    <section role="tabpanel" data-testid={`overview-source-section-${type}`}>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2 pb-1">
        {spec.subtitle && (
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">{spec.subtitle}</span>
        )}
        {toggle && (
          <SegmentedToggle
            mode={toggle.mode}
            onMode={toggle.onMode}
            ledLabel={toggle.ledLabel}
            allLabel={toggle.allLabel}
            disabled={disabled}
            section={type}
          />
        )}
      </div>
      {spec.scaffold && (
        <p
          className="text-muted-foreground px-3.5 py-1.5 text-[13px]"
          data-testid={`overview-source-scaffold-${type}`}
        >
          {spec.scaffold}
        </p>
      )}
      {sortState && (
        <div className="px-3.5 pb-1">
          <PublicationSort sort={sortState.value} onSort={sortState.set} disabled={disabled} />
        </div>
      )}

      {showEmptyLed && (
        <p
          className="text-muted-foreground border-apollo-border border-t px-3.5 py-2.5 text-[13px]"
          data-testid="overview-source-empty-led"
        >
          {spec.emptyLed}
        </p>
      )}

      <ul className="flex flex-col">
        {visible.map((r) => (
          <RecordRow
            key={r.id}
            record={r}
            type={type}
            pinnable={spec.pinnable}
            whyLabel={spec.whyLabel}
            pinned={isPinned(r.id)}
            excluded={isExcluded(r.id)}
            disabled={disabled}
            onPin={() => onChange(togglePin(deltas, type, r.id))}
            onExclude={() => onChange(exclude(deltas, type, r.id))}
            onUndo={() => onChange(undoExclude(deltas, type, r.id))}
          />
        ))}
      </ul>

      {hiddenMore > 0 && (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          disabled={disabled}
          className="border-apollo-border text-muted-foreground hover:text-foreground w-full border-t px-3.5 py-2.5 text-left text-[13px]"
          data-testid={`overview-source-more-${type}`}
        >
          {spec.moreCopy(hiddenMore, moreExamples)}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function RecordRow({
  record,
  type,
  pinnable,
  whyLabel,
  pinned,
  excluded,
  disabled,
  onPin,
  onExclude,
  onUndo,
}: {
  record: RecordView;
  type: OverviewRecordType;
  pinnable: boolean;
  whyLabel: string | null;
  pinned: boolean;
  excluded: boolean;
  disabled: boolean;
  onPin: () => void;
  onExclude: () => void;
  onUndo: () => void;
}) {
  const [whyOpen, setWhyOpen] = React.useState(false);
  // Included = featured or pinned (and not vetoed). The checkbox performs the one
  // action that fits the row's state — hide it, undo the hide, or add-and-pin an
  // Available row — and carries that action's testid.
  const included = !excluded && (pinned || record.bucket === "featured");
  const reveal = record.reason ?? record.evidence;
  const check = excluded
    ? { onClick: onUndo, testid: `overview-source-undo-${type}-${record.id}`, label: "Include" }
    : included
      ? { onClick: onExclude, testid: `overview-source-exclude-${type}-${record.id}`, label: "Exclude" }
      : { onClick: onPin, testid: `overview-source-add-${type}-${record.id}`, label: "Include and pin" };
  // Pin pill: included rows of pinnable types, plus a row ADDED from the Available
  // tail in an exclude-only section (so un-adding is Unpin, not a spurious hide).
  const showPin = !excluded && (pinned || (included && pinnable));

  return (
    <li
      className={cn(
        "border-apollo-border flex items-start gap-3 border-t px-3.5 py-3",
        excluded || !included ? "bg-[#fcfbfa]" : "bg-apollo-surface",
      )}
      data-testid={`overview-source-row-${type}-${record.id}`}
      data-state={excluded ? "excluded" : pinned ? "pinned" : "default"}
    >
      <input
        type="checkbox"
        checked={included}
        onChange={check.onClick}
        disabled={disabled}
        aria-label={`${check.label}: ${typeof record.title === "string" ? record.title : "source"}`}
        className="accent-foreground mt-0.5 size-[18px] shrink-0 cursor-pointer"
        data-testid={check.testid}
      />

      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "line-clamp-2 text-sm leading-snug font-medium",
            !included && "text-muted-foreground",
            excluded && "line-through",
          )}
        >
          {record.title}
          {record.externalHref && (
            <a
              href={record.externalHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View on PubMed"
              className="ml-1.5 inline-block align-[-2px] text-[#185FA5]"
            >
              <ExternalLinkIcon />
            </a>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate">{record.meta.join(" · ")}</span>
          {whyLabel && reveal && (
            <button
              type="button"
              onClick={() => setWhyOpen((v) => !v)}
              aria-label={whyLabel}
              aria-expanded={whyOpen}
              title={whyLabel}
              className="hover:text-foreground shrink-0"
              data-testid={`overview-source-why-${type}-${record.id}`}
            >
              <Info className="size-[13px]" aria-hidden="true" />
            </button>
          )}
        </div>
        {whyOpen && reveal && (
          <div className="bg-apollo-surface-2 text-muted-foreground mt-1.5 rounded-md px-2.5 py-2 text-xs leading-relaxed">
            {record.evidence ? (
              <span className="text-foreground italic">{record.evidence}</span>
            ) : (
              reveal
            )}
          </div>
        )}
      </div>

      {showPin && (
        <button
          type="button"
          onClick={onPin}
          disabled={disabled}
          aria-pressed={pinned}
          className={cn(
            "inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs disabled:opacity-50",
            pinned
              ? "bg-apollo-surface-2 text-foreground border-[#8a847c] font-medium"
              : "border-apollo-border-strong bg-apollo-surface text-muted-foreground",
          )}
          data-testid={`overview-source-pin-${type}-${record.id}`}
        >
          <Pin className={cn("size-3", pinned && "fill-current")} aria-hidden="true" />
          {pinned ? "Pinned" : "Pin"}
        </button>
      )}
    </li>
  );
}

function ExternalLinkIcon() {
  // Inline to avoid importing the lucide ExternalLink purely for a 14px glyph.
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Segmented led ⇄ all toggle (§2.3).
// ---------------------------------------------------------------------------

function SegmentedToggle({
  mode,
  onMode,
  ledLabel,
  allLabel,
  disabled,
  section,
}: {
  mode: OverviewPositionMode;
  onMode: (m: OverviewPositionMode) => void;
  ledLabel: string;
  allLabel: string;
  disabled: boolean;
  section: string;
}) {
  return (
    <span
      className="border-apollo-border bg-apollo-surface-2 ml-auto inline-flex gap-0.5 rounded-[7px] border p-0.5"
      data-testid={`overview-source-toggle-${section}`}
    >
      {(
        [
          ["led", ledLabel],
          ["all", allLabel],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          disabled={disabled}
          onClick={() => onMode(value)}
          aria-pressed={mode === value}
          className={cn(
            "rounded-[5px] px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50",
            mode === value
              ? "text-foreground bg-white font-semibold shadow-[0_1px_2px_rgba(34,30,28,0.12),0_0_0_1px_var(--apollo-border-strong)]"
              : "text-muted-foreground",
          )}
          data-testid={`overview-source-toggle-${section}-${value}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Publications sort control (§5) — reorders the visible featured rows only;
// it never re-picks or drops a record. "Recommended" is the default.
// ---------------------------------------------------------------------------

type PubSortKey = "recommended" | "most cited" | "most recent" | "your role";

const PUB_SORTS: { key: PubSortKey; subtitle: string }[] = [
  {
    key: "recommended",
    subtitle:
      "your strongest led work · spread across your areas · landmarks kept regardless of age · duplicates merged",
  },
  { key: "most cited", subtitle: "career-defining work first, any age" },
  { key: "most recent", subtitle: "newest first" },
  { key: "your role", subtitle: "senior- and first-author first" },
];

function PublicationSort({
  sort,
  onSort,
  disabled,
}: {
  sort: PubSortKey;
  onSort: (k: PubSortKey) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="border-apollo-border-strong text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]"
        aria-expanded={open}
        data-testid="overview-source-pub-sortctl"
      >
        Sorted: <span className="text-foreground">{sort}</span>
        <ChevronDown className="size-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="border-apollo-border-strong mt-2 overflow-hidden rounded-md border">
          {PUB_SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                onSort(s.key);
                setOpen(false);
              }}
              className={cn(
                "border-apollo-border block w-full border-t px-3 py-2 text-left text-[13px] first:border-t-0",
                s.key === sort && "bg-apollo-surface-2",
              )}
              data-testid={`overview-source-pub-sort-${s.key.replace(/\s+/g, "-")}`}
            >
              {s.key}
              <small className="text-muted-foreground mt-px block text-[11.5px]">{s.subtitle}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reorder shown publications per the active sort. "Recommended" preserves the
 *  server order (the auto-set is already recommendation-ranked). Sorting only
 *  reorders — membership (pins / excludes) is resolved before this runs (§5). */
function sortPublications(records: RecordView[], sort: PubSortKey): RecordView[] {
  if (sort === "recommended") return records;
  const by = (rank: (r: RecordView) => number) =>
    [...records].sort((a, b) => rank(b) - rank(a));
  switch (sort) {
    case "most cited":
      return by((r) => r.impact ?? -Infinity);
    case "most recent":
      return by((r) => r.year ?? -Infinity);
    case "your role":
      // Senior / first author first, then by recency as the tiebreak.
      return by((r) => (r.firstOrLast ? 1 : 0) * 1e6 + (r.year ?? 0));
  }
}
