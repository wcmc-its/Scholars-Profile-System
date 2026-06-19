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
import { ChevronDown, Pin, Plus, TriangleAlert, Undo2, X } from "lucide-react";

import { PubTitle } from "@/components/publication/pub-html";
import type {
  OverviewSourceEducation,
  OverviewSourceFunding,
  OverviewSourceOptions,
  OverviewSourcePublication,
  OverviewSourceTitle,
} from "@/lib/edit/overview-facts";
import {
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

/** The minimum visible publications below which the overview reads as thin (§2.5). */
const MIN_PUBLICATIONS = 3;

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
    const bucket: Bucket = p.defaultSelected ? "featured" : p.isFirstOrLast ? "more" : "mid";
    return {
      id: p.pmid,
      title: <PubTitle as="span" value={p.title} />,
      meta: [p.venue ?? null, pubRole(p), p.year != null ? String(p.year) : null].filter(
        (x): x is string => Boolean(x),
      ),
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
  return [f.role, f.endYear != null ? String(f.endYear) : "active"].filter(
    (x): x is string => Boolean(x),
  );
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

  return (
    <div className="flex flex-col gap-1" data-testid="overview-include-picker">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Hiding a record affects only this overview — it stays in your profile. Pins and hides survive
        every regenerate.
      </p>
      {visiblePubs < MIN_PUBLICATIONS && (
        <p
          className="text-apollo-amber mt-1 flex items-center gap-1.5 text-xs"
          data-testid="overview-source-minwarn"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          This leaves fewer than {MIN_PUBLICATIONS} papers — the overview will be brief.
        </p>
      )}

      <Section
        spec={{
          type: "publication",
          heading: "Publications",
          subtitle: "Senior- and first-author work, weighted toward recent and landmark.",
          records: publications,
          pinnable: true,
          whyLabel: "why this?",
          toggle: {
            mode: deltas.publicationPositions,
            onMode: (m) => setPositionMode("publicationPositions", m),
            ledLabel: "Led",
            allLabel: "All positions",
          },
          moreCopy: (n) => `+ ${n} more featured ${n === 1 ? "paper" : "papers"} — `,
        }}
        deltas={deltas}
        onChange={onChange}
        disabled={disabled}
        sortState={{ value: pubSort, set: setPubSort }}
      />

      <Section
        spec={{
          type: "funding",
          heading: "Funding",
          subtitle: "Grants you lead, active and recently completed.",
          records: funding,
          pinnable: true,
          whyLabel: "why this?",
          toggle: {
            mode: deltas.fundingRoles,
            onMode: (m) => setPositionMode("fundingRoles", m),
            ledLabel: "Led",
            allLabel: "All roles",
          },
          moreCopy: (n) => `+ ${n} more — `,
          emptyLed: 'No grants you lead are active. Switch to "all roles" to include co-investigator grants.',
        }}
        deltas={deltas}
        onChange={onChange}
        disabled={disabled}
      />

      {showTools && (
        <Section
          spec={{
            type: "method",
            heading: "Methods & tools",
            subtitle: "Methods named across your papers, shown with how you used them.",
            records: methods,
            pinnable: true,
            whyLabel: "show evidence",
            toggle: null,
            moreCopy: (n, ex) =>
              `+ ${n} single-paper ${n === 1 ? "method" : "methods"}${
                ex.length ? ` (${ex.join(", ")}…)` : ""
              } — usually too thin to feature. `,
          }}
          deltas={deltas}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {(hasPrimaryTitle || titles.length > 0) && (
        <Section
          spec={{
            type: "title",
            heading: "Titles & positions",
            subtitle:
              titles.length > 0
                ? "Leadership and named roles beyond your primary appointment. Hiding one keeps it out of this overview only."
                : "Leadership and named roles beyond your primary appointment.",
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
            whyLabel: "why this?",
            toggle: null,
            moreCopy: (n) => `+ ${n} more ${n === 1 ? "title" : "titles"} — `,
          }}
          deltas={deltas}
          onChange={onChange}
          disabled={disabled}
        />
      )}

      {education.length > 0 && (
        <Section
          spec={{
            type: "education",
            heading: "Education",
            subtitle:
              "Terminal and professional degrees. Hiding one keeps it out of this overview only.",
            records: education,
            pinnable: false,
            whyLabel: "why this?",
            toggle: null,
            moreCopy: (n) => `+ ${n} more — `,
          }}
          deltas={deltas}
          onChange={onChange}
          disabled={disabled}
        />
      )}
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
    <section className="mt-4" data-testid={`overview-source-section-${type}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-foreground text-sm font-medium">{spec.heading}</span>
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
      {spec.subtitle && (
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{spec.subtitle}</div>
      )}
      {spec.scaffold && (
        <p
          className="text-muted-foreground border-apollo-border mt-1 border-t pt-2.5 text-[13px]"
          data-testid={`overview-source-scaffold-${type}`}
        >
          {spec.scaffold}
        </p>
      )}
      {sortState && (
        <PublicationSort sort={sortState.value} onSort={sortState.set} disabled={disabled} />
      )}

      {showEmptyLed && (
        <p
          className="text-muted-foreground border-apollo-border mt-1 border-t pt-2.5 text-[13px]"
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
        <p className="text-muted-foreground border-apollo-border border-t pt-2.5 text-[13px]">
          {spec.moreCopy(hiddenMore, moreExamples)}
          <button
            type="button"
            onClick={() => setShowMore(true)}
            disabled={disabled}
            className="text-apollo-maroon hover:underline"
            data-testid={`overview-source-more-${type}`}
          >
            show
          </button>
        </p>
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
  // "Included" rows (featured or pinned) get the pin/exclude controls; Available
  // rows get a single "add and pin". Titles & education never pin a featured row.
  const included = pinned || record.bucket === "featured";
  const reveal = record.reason ?? record.evidence;

  return (
    <li
      className={cn(
        "border-apollo-border flex items-start gap-2.5 border-t py-2.5",
        excluded && "[&_.recmain]:opacity-40",
      )}
      data-testid={`overview-source-row-${type}-${record.id}`}
      data-state={excluded ? "excluded" : pinned ? "pinned" : "default"}
    >
      {/* Leading control */}
      {excluded ? (
        <span className="w-[21px] shrink-0" aria-hidden="true" />
      ) : included ? (
        pinnable ? (
          <IconButton
            label={pinned ? "Unpin" : "Pin"}
            active={pinned}
            disabled={disabled}
            onClick={onPin}
            testid={`overview-source-pin-${type}-${record.id}`}
          >
            <Pin className="size-[17px]" />
          </IconButton>
        ) : pinned && record.bucket !== "featured" ? (
          // A row ADDED from the Available tail in an exclude-only (non-pinnable)
          // section: offer an Unpin so removing it returns to the default tier, rather
          // than forcing the trailing X — which would mint a spurious exclude and
          // inflate the "N hidden" count for a row the scholar only meant to un-add.
          <IconButton
            label="Unpin"
            active
            disabled={disabled}
            onClick={onPin}
            testid={`overview-source-pin-${type}-${record.id}`}
          >
            <Pin className="size-[17px]" />
          </IconButton>
        ) : (
          <span className="w-[21px] shrink-0" aria-hidden="true" />
        )
      ) : (
        <IconButton
          label="Add and pin"
          active
          disabled={disabled}
          onClick={onPin}
          testid={`overview-source-add-${type}-${record.id}`}
        >
          <Plus className="size-[17px]" />
        </IconButton>
      )}

      <div className="recmain min-w-0 flex-1">
        <div className={cn("text-[13.5px] leading-snug", excluded && "line-through")}>
          {record.externalHref ? (
            <span className="flex items-center gap-1.5">
              {record.title}
              <a
                href={record.externalHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on PubMed"
                className="text-[#185FA5]"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLinkIcon />
              </a>
            </span>
          ) : (
            record.title
          )}
        </div>
        {(record.meta.length > 0 || pinned) && (
          <div className="text-muted-foreground mt-0.5 text-xs">
            {record.meta.join(" · ")}
            {pinned && (
              <>
                {record.meta.length > 0 ? " · " : ""}
                <span className="text-apollo-maroon">pinned</span>
              </>
            )}
          </div>
        )}
        {!excluded && whyLabel && reveal && (
          <>
            <button
              type="button"
              onClick={() => setWhyOpen((v) => !v)}
              className="text-muted-foreground mt-1.5 inline-flex items-center gap-1 text-xs hover:underline"
              aria-expanded={whyOpen}
              data-testid={`overview-source-why-${type}-${record.id}`}
            >
              {whyLabel}
              <ChevronDown
                className={cn("size-3 transition-transform", whyOpen && "rotate-180")}
                aria-hidden="true"
              />
            </button>
            {whyOpen && (
              <div className="bg-apollo-surface-2 text-muted-foreground mt-1.5 rounded-md px-2.5 py-2 text-xs leading-relaxed">
                {record.evidence ? (
                  <span className="text-foreground italic">{record.evidence}</span>
                ) : (
                  reveal
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Trailing control */}
      {excluded ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={disabled}
          className="text-apollo-maroon inline-flex shrink-0 items-center gap-1 text-[12.5px]"
          data-testid={`overview-source-undo-${type}-${record.id}`}
        >
          <Undo2 className="size-3.5" aria-hidden="true" /> Undo
        </button>
      ) : included ? (
        <IconButton
          label="Hide"
          disabled={disabled}
          onClick={onExclude}
          testid={`overview-source-exclude-${type}-${record.id}`}
        >
          <X className="size-[17px]" />
        </IconButton>
      ) : null}
    </li>
  );
}

function IconButton({
  label,
  active = false,
  disabled,
  onClick,
  testid,
  children,
}: {
  label: string;
  active?: boolean;
  disabled: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "shrink-0 p-0.5 leading-none transition-colors disabled:opacity-40",
        active ? "text-apollo-maroon" : "text-muted-foreground hover:text-foreground",
      )}
      data-testid={testid}
    >
      {children}
    </button>
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
      className="border-apollo-border-strong ml-auto inline-flex overflow-hidden rounded-full border"
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
            "px-3 py-1 text-xs transition-colors disabled:opacity-50",
            mode === value ? "bg-apollo-maroon text-white" : "text-muted-foreground",
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
