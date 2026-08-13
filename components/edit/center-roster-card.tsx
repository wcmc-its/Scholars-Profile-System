/**
 * CenterRosterCard — the rich center roster table (#552 §6.1; the deferred
 * #540 PR-7b-roster). Columns: Member | [Type | Program] | [Diseases] |
 * Status | Remove. Start/End are NOT their own columns — see "Dates" below.
 *
 * Type + Program are surfaced **only when the center has a program taxonomy**
 * (`programs.length > 0`) — the data-driven "Cancer-Center-only" gate. Every
 * other center shows just Member / Status. Start/End still drive the derived
 * Active / Pending / Inactive status (the #552 §3.3 active filter, inclusive
 * boundaries, nulls open).
 *
 * Dates: a compact "Start → End" range (`MemberDateRange`) sits under the
 * Program name (or under the Member name/title when the center has no
 * programs, so the range is never dropped) instead of two always-visible
 * date-input columns — the 2026-08-12 mockup redesign reclaims that width for
 * the Diseases column + filter bar. Clicking the range opens a small popover
 * with the same two `<input type=date>` fields as before, same
 * `onStartChange`/`onEndChange` validation (End < Start blocked client-side).
 *
 * ONE mutually-exclusive filter — All members (default) / Inactive / Departed
 * — rendered as a 3-button segmented control, so the roster opens on the
 * whole thing and nothing is ever silently hidden. Two independent "X only"
 * checkboxes could not say this honestly: both unchecked reads as no
 * restriction, both checked as an impossible intersection.
 *
 * A row whose person has left WCM while the membership is still open is
 * tinted amber and its date-range trigger colored to match, because that is
 * the combination this card exists to surface. The count of those rows
 * drives the nudge above the table — outstanding work, not hidden rows.
 *
 * Inline edits POST `/api/edit/roster` `action:"set"` one field at a time
 * (a field present as `null` clears it). Add → `action:"add"`, Remove →
 * `action:"remove"`. The list updates optimistically; a failed write reverts
 * and surfaces an error.
 *
 * Diseases (`2026-08-12-cancer-center-disease-assignment-edit-ui-plan.md`
 * §5, mockup-fidelity pass): a "Diseases" column renders only for a center
 * that actually has assignment data at all (`hasDiseases` below). Each
 * member's LIVE (non-rejected) assignments render as confidence-tinted
 * chips, capped at `MAX_DISEASE_CHIPS` with a "+N more" overflow chip, plus
 * an amber "N to review" pill for any undecided rows. Clicking ANY chip/pill
 * in a row toggles an inline expanded region directly under that row
 * (`DiseaseExpandedPanel`) — a card GRID (2-up on `md`+), each card's
 * evidence broken into three labeled columns (Publications / Grants /
 * Trials) rather than one run-on line, Confirm rendered as the primary
 * (solid green) action against an outlined Reject, and a dashed "+ Add a
 * disease" card at the end for the manual-add path: a curator attaching a
 * disease code the generator never suggested, POSTing `"confirmed"` with no
 * backing assignment row (the API route's own contract — `scoreAtDecision`/
 * `confidenceAtDecision` land `null`, not a fake sentinel). Confirm/Reject/
 * Undo/Add all POST the same `/api/edit/center/[code]/disease-assignments`
 * route via `decideDisease`, serialized per (cwid, diseaseCode) pair.
 *
 * A second filter-bar row narrows the visible member list — client-side, over
 * the already-loaded roster, AND-composed with each other and with the
 * existing All/Inactive/Departed control: a free-text search (name or CWID),
 * a disease multi-select, a confidence tier, and a "needs review" toggle
 * whose count is the total pending assignments across the WHOLE roster
 * (unaffected by the other filters). "Clear all filters" resets all four.
 */
"use client";

import Link from "next/link";
import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DiseaseCodeOption, RosterDiseaseRow } from "@/lib/api/unit-edit-context";

export type RosterMember = {
  cwid: string;
  name: string;
  title: string | null;
  membershipType: "research" | "clinical" | null;
  programCode: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Whether the PERSON is still at WCM. Orthogonal to the membership dates:
   *  a row can be membership-Active AND scholarState "departed" — someone who
   *  left WCM with nobody having closed out their center membership. That
   *  combination is the whole point of surfacing this. Optional so existing
   *  fixtures/callers that predate #2324 still type-check; absent → "active". */
  scholarState?: "active" | "departed" | "unknown";
  /** Disease-assignment plan §5/§6 — this member's ranked disease-expertise
   *  picture, `[]`/absent for a non-center roster or a member with none.
   *  Optional for the same reason `scholarState` is: existing fixtures/callers
   *  that predate this feature still type-check. Already server-sorted by
   *  rank (drift-only decision rows trailing by code) — see
   *  `loadUnitEditContext`. */
  diseases?: ReadonlyArray<RosterDiseaseRow>;
};

export type CenterProgramOption = { code: string; label: string; sortOrder: number };

export type CenterRosterCardProps = {
  unitCode: string;
  members: ReadonlyArray<RosterMember>;
  programs: ReadonlyArray<CenterProgramOption>;
  /** Injectable for tests; defaults to today (YYYY-MM-DD). */
  today?: string;
  /** #1102 — when true, render the "Export CSV" roster-download affordance
   *  (the `EDIT_UNIT_ROSTER_EXPORT` flag, resolved server-side). */
  exportEnabled?: boolean;
  /** The canonical disease-code list for the "+ Add a disease" manual-add
   *  picker (`ctx.diseaseOptions`, `lib/api/unit-edit-context.ts`) — every
   *  code the taxonomy knows about, not just the ones already assigned on
   *  this roster. Defaults to `[]` (a non-Cancer-Center roster, or the
   *  context loader's own catch-and-degrade path). */
  diseaseOptions?: ReadonlyArray<DiseaseCodeOption>;
};

type Status = "active" | "pending" | "inactive";

/** The three mutually-exclusive roster views. `all` is the default. */
type RosterFilter = "all" | "inactive" | "departed";

type ConfidenceFilter = "any" | "high" | "medium" | "low";

/** Chips shown before the "+N more" overflow chip kicks in. */
const MAX_DISEASE_CHIPS = 3;

/** #552 §3.3 active filter, inclusive boundaries, nulls open. */
function statusOf(member: RosterMember, today: string): Status {
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ISO `YYYY-MM-DD` -> `MM/DD/YYYY` for the compact date-range display;
 *  `null` -> an em dash, matching the mockup's open-start/open-end rows. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * `person_code` -> `display_label`, from `docs/cancer-center-person-rollup.csv`
 * (the same map `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`
 * builds at ETL time). Hardcoded rather than read here at request time:
 * unlike `CancerTaxonomyDescriptor`, the rollup has no DB-backed lookup, and
 * the app's runtime image never ships `docs/` at all (`Dockerfile`'s runtime
 * stage copies only `.next/standalone` + `.next/static` + `prisma/`) — a
 * `readFileSync` here would ENOENT in every deployed environment. Same
 * reasoning `TOPIC_LABELS` in `cancer-center-collab-report-card.tsx` documents
 * for its own (unrelated) axis, including the fallback below for a rollup
 * code added after this map was last synced. The `diseaseOptions` prop (the
 * server's `loadDiseaseCodeOptions`) carries the authoritative label for the
 * "+ Add a disease" picker; this map is only a display fallback.
 */
const DISEASE_LABELS: Record<string, string> = {
  BREAST: "Breast Cancer",
  LUNG: "Lung & Thoracic Cancer",
  GI_COLORECTAL: "Colorectal & Anal Cancer",
  GI_PANCREAS: "Pancreatic Cancer",
  GI_LIVER: "Liver & Bile Duct Cancer",
  GI_UPPER: "Esophageal & Stomach Cancer",
  GU_PROSTATE: "Prostate Cancer",
  GU_OTHER: "Kidney, Bladder & Testicular Cancer",
  GYN: "Gynecologic Cancer",
  HEME_LEUK: "Leukemia",
  HEME_LYMPH: "Lymphoma",
  HEME_MYELOMA: "Multiple Myeloma",
  HEME_MDS_MPN: "Blood Cancers (MDS, MPN & Other)",
  NEURO: "Brain & Nervous System Cancer",
  HEAD_NECK: "Head & Neck Cancer",
  SKIN: "Melanoma & Skin Cancer",
  SARCOMA: "Sarcoma & Bone Cancer",
  ENDO: "Thyroid & Endocrine Cancer",
  HEREDITARY: "Hereditary Cancer & Genetics",
};

function diseaseLabel(code: string): string {
  const known = DISEASE_LABELS[code];
  if (known) return known;
  const spaced = code.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const FOCUS_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  peripheral: "Peripheral",
};

/** Same tint convention as the roster Active/Inactive badge below. */
const CONFIDENCE_BADGE_CLASS: Record<string, string> = {
  high: "bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border",
  medium: "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border",
  low: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
};

/** Solid dot matching each confidence tier — the chip legend's color key. */
const CONFIDENCE_DOT_CLASS: Record<string, string> = {
  high: "bg-apollo-green-foreground",
  medium: "bg-apollo-amber",
  low: "bg-apollo-slate",
};

/** A row's confidence for tinting/filtering purposes — the current assignment's
 *  if one still exists, else the snapshot the decision was made against. */
function confidenceOf(row: RosterDiseaseRow): string | null {
  return row.assignment?.confidence ?? row.decision?.confidenceAtDecision ?? null;
}

/** Non-rejected rows for a member — what the collapsed chips show, in the
 *  server-sent (rank) order. */
function liveDiseaseRows(member: RosterMember): RosterDiseaseRow[] {
  return (member.diseases ?? []).filter((d) => d.decision?.decision !== "rejected");
}

/** Assignment rows with no curator decision yet — the "N to review" count. */
function pendingDiseaseRows(member: RosterMember): RosterDiseaseRow[] {
  return (member.diseases ?? []).filter((d) => d.assignment !== null && d.decision === null);
}

type DiseaseDecisionKind = "confirmed" | "rejected" | "clear";

/**
 * The collapsed-row summary (plan §5) — up to `MAX_DISEASE_CHIPS`
 * confidence-tinted chips (confirmed ones prefixed "✓ "), a "+N more"
 * overflow chip, and an amber "N to review" pill for undecided rows. Every
 * chip/pill shares one click handler: toggle the row's inline expand.
 */
function DiseaseChips({
  member,
  onToggleExpand,
}: {
  member: RosterMember;
  onToggleExpand: (cwid: string) => void;
}) {
  const diseases = member.diseases ?? [];
  if (diseases.length === 0) return null;

  const live = liveDiseaseRows(member);
  const pending = pendingDiseaseRows(member);

  if (live.length === 0 && pending.length === 0) {
    return (
      <span
        className="text-muted-foreground text-xs italic"
        data-testid={`roster-disease-empty-${member.cwid}`}
      >
        No disease assignments
      </span>
    );
  }

  const shown = live.slice(0, MAX_DISEASE_CHIPS);
  const overflow = live.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`roster-disease-chips-${member.cwid}`}>
      {shown.map((d) => {
        const confidence = confidenceOf(d) ?? "low";
        const confirmed = d.decision?.decision === "confirmed";
        return (
          <button
            key={d.diseaseCode}
            type="button"
            onClick={() => onToggleExpand(member.cwid)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
              CONFIDENCE_BADGE_CLASS[confidence] ?? ""
            }`}
            data-testid={`roster-disease-chip-${member.cwid}-${d.diseaseCode}`}
          >
            <span className={`size-1.5 rounded-full ${CONFIDENCE_DOT_CLASS[confidence] ?? ""}`} aria-hidden />
            {confirmed ? "✓ " : ""}
            {diseaseLabel(d.diseaseCode)}
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => onToggleExpand(member.cwid)}
          className="border-apollo-border text-apollo-slate rounded-full border px-2 py-0.5 text-xs font-medium"
          data-testid={`roster-disease-chip-more-${member.cwid}`}
        >
          +{overflow} more
        </button>
      )}
      {pending.length > 0 && (
        <button
          type="button"
          onClick={() => onToggleExpand(member.cwid)}
          className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full border px-2 py-0.5 text-xs font-medium"
          data-testid={`roster-disease-pending-${member.cwid}`}
        >
          {pending.length} to review
        </button>
      )}
    </div>
  );
}

/** The mockup's three-column evidence block (Publications / Grants / Trials)
 *  — replaces the old single run-on line. "Authored" totals lead+second+
 *  middle; Grants/Trials show "N led" (the "supported" count, if any, as a
 *  secondary line — the mockup's examples never had one > 0, so this is the
 *  conservative choice that doesn't silently drop data). */
function EvidenceColumns({ a }: { a: NonNullable<RosterDiseaseRow["assignment"]> }) {
  const authored = a.leadPubs + a.secondPubs + a.middlePubs;
  const years = a.firstYear && a.lastYear ? ` (${a.firstYear}–${a.lastYear})` : "";
  const grantsTotal = a.grantsLed + a.grantsSupport;
  const trialsTotal = a.trialsLed + a.trialsSupport;
  return (
    <div className="divide-apollo-border grid grid-cols-3 divide-x text-xs">
      <div className="pr-3">
        <p className="text-muted-foreground font-medium tracking-wide uppercase">Publications</p>
        <p className="text-foreground text-sm font-semibold">{authored} authored</p>
        <p className="text-muted-foreground">
          {a.leadPubs} lead · {a.secondPubs} second · {a.middlePubs} middle
        </p>
        <p className="text-muted-foreground">
          {a.recentPubs} recent{years}
        </p>
      </div>
      <div className="px-3">
        <p className="text-muted-foreground font-medium tracking-wide uppercase">Grants</p>
        {grantsTotal === 0 ? (
          <p className="text-muted-foreground text-sm font-semibold">None</p>
        ) : (
          <>
            <p className="text-foreground text-sm font-semibold">{a.grantsLed} led</p>
            {a.grantsSupport > 0 && (
              <p className="text-muted-foreground">{a.grantsSupport} supported</p>
            )}
          </>
        )}
      </div>
      <div className="pl-3">
        <p className="text-muted-foreground font-medium tracking-wide uppercase">Trials</p>
        {trialsTotal === 0 ? (
          <p className="text-muted-foreground text-sm font-semibold">None</p>
        ) : (
          <>
            <p className="text-foreground text-sm font-semibold">{a.trialsLed} led</p>
            {a.trialsSupport > 0 && (
              <p className="text-muted-foreground">{a.trialsSupport} supported</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Flat text treatment for a decided card's footer — the mockup's "✓
 *  Confirmed  Undo" is plain colored text, not a bordered pill (that's the
 *  collapsed chip's job). */
function DecisionLine({
  decision,
  busy,
  onUndo,
}: {
  decision: "confirmed" | "rejected";
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1 text-sm font-medium ${
          decision === "confirmed" ? "text-apollo-green" : "text-apollo-maroon"
        }`}
      >
        {decision === "confirmed" ? "✓ Confirmed" : "✕ Rejected"}
      </span>
      <button
        type="button"
        disabled={busy}
        className="text-apollo-slate text-xs underline hover:no-underline disabled:opacity-50"
        onClick={onUndo}
      >
        Undo
      </button>
    </div>
  );
}

/** The dashed "+ Add a disease" card (manual-add extension) — a curator
 *  attaching a code the generator never suggested for this member. Offers
 *  only codes not already on the member's list; picking one POSTs
 *  `"confirmed"` with no backing assignment row via the same `onAdd` ->
 *  `decideDisease` path everything else here uses. */
function AddDiseaseCard({
  member,
  diseaseOptions,
  onAdd,
}: {
  member: RosterMember;
  diseaseOptions: ReadonlyArray<DiseaseCodeOption>;
  onAdd: (diseaseCode: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const already = new Set((member.diseases ?? []).map((d) => d.diseaseCode));
  const available = diseaseOptions.filter((o) => !already.has(o.code));
  const q = search.trim().toLowerCase();
  const shown = available.filter(
    (o) => !q || o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-apollo-border text-apollo-maroon hover:bg-accent flex min-h-24 items-center justify-center rounded-md border border-dashed p-3 text-sm font-medium"
          data-testid={`disease-add-trigger-${member.cwid}`}
        >
          + Add a disease
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" data-testid={`disease-add-menu-${member.cwid}`}>
        <Input
          type="text"
          placeholder="Search diseases…"
          className="mb-2 h-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid={`disease-add-search-${member.cwid}`}
        />
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-muted-foreground px-1.5 py-1 text-xs">
              {available.length === 0 ? "Every disease is already listed for this member." : "No diseases match."}
            </p>
          ) : (
            shown.map((o) => (
              <button
                key={o.code}
                type="button"
                className="hover:bg-accent rounded px-1.5 py-1.5 text-left text-sm"
                onClick={() => {
                  onAdd(o.code);
                  setOpen(false);
                }}
                data-testid={`disease-add-option-${member.cwid}-${o.code}`}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The inline expanded region (plan §5) — replaces the original per-member
 * Dialog, then this mockup-fidelity pass replaces the first cut's vertical
 * list with a 2-up card grid. Renders ALL of a member's disease rows (not
 * just the live ones), ranked by evidence, so a curator can Undo a rejection
 * the collapsed chips hide. Rejected cards are de-emphasized (dimmed), not
 * hidden.
 */
function DiseaseExpandedPanel({
  member,
  diseaseOptions,
  onDecide,
  onCollapse,
}: {
  member: RosterMember;
  diseaseOptions: ReadonlyArray<DiseaseCodeOption>;
  onDecide: (cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) => Promise<void>;
  onCollapse: () => void;
}) {
  const diseases = member.diseases ?? [];
  const [busyCode, setBusyCode] = React.useState<string | null>(null);

  async function act(diseaseCode: string, decision: DiseaseDecisionKind) {
    setBusyCode(diseaseCode);
    try {
      await onDecide(member.cwid, diseaseCode, decision);
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`disease-expand-${member.cwid}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold">Disease assignments — ranked by evidence</p>
          <p className="text-muted-foreground text-xs">
            Confirming or rejecting records your call; a later reseed of the evidence never
            silently erases it.
          </p>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          className="text-apollo-maroon inline-flex shrink-0 items-center gap-1 text-sm font-semibold hover:underline"
          data-testid={`disease-expand-collapse-${member.cwid}`}
        >
          Collapse
          <ChevronUp className="size-4" aria-hidden />
        </button>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {diseases.map((d) => {
          const busy = busyCode === d.diseaseCode;
          const rejected = d.decision?.decision === "rejected";
          // A manual add never had a suggestion to lose — distinct from a
          // decision whose backing assignment later disappeared (real drift).
          const isManualAdd = !d.assignment && d.decision !== null && d.decision.scoreAtDecision === null;
          return (
            <li
              key={d.diseaseCode}
              className={`border-apollo-border rounded-md border p-4 ${rejected ? "opacity-50" : ""}`}
              data-testid={`disease-card-${member.cwid}-${d.diseaseCode}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-base font-bold">{diseaseLabel(d.diseaseCode)}</span>
                <span className="text-muted-foreground text-xs uppercase">{d.diseaseCode}</span>
                {d.assignment && (
                  <>
                    <Badge variant="outline" className="rounded-full">
                      Rank {d.assignment.rank}
                    </Badge>
                    <Badge variant="outline" className="rounded-full">
                      {FOCUS_LABEL[d.assignment.focus] ?? d.assignment.focus}
                    </Badge>
                  </>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {d.assignment ? (
                  <Badge
                    variant="outline"
                    className={`rounded-full ${CONFIDENCE_BADGE_CLASS[d.assignment.confidence] ?? ""}`}
                  >
                    {d.assignment.confidence} confidence
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                  >
                    {isManualAdd ? "Manually added" : "No longer suggested"}
                  </Badge>
                )}
                {d.drifted && (
                  <Badge
                    variant="outline"
                    className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                    title="The evidence behind this decision has changed since it was made."
                    data-testid={`disease-drift-${member.cwid}-${d.diseaseCode}`}
                  >
                    Review — evidence changed
                  </Badge>
                )}
              </div>
              {d.assignment && (
                <div className="border-apollo-border mt-3 border-t pt-3">
                  <EvidenceColumns a={d.assignment} />
                </div>
              )}
              {!d.decision ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    className="bg-apollo-green text-white hover:bg-apollo-green/90"
                    onClick={() => act(d.diseaseCode, "confirmed")}
                    data-testid={`disease-confirm-${member.cwid}-${d.diseaseCode}`}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act(d.diseaseCode, "rejected")}
                    data-testid={`disease-reject-${member.cwid}-${d.diseaseCode}`}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <DecisionLine
                  decision={d.decision.decision as "confirmed" | "rejected"}
                  busy={busy}
                  onUndo={() => act(d.diseaseCode, "clear")}
                />
              )}
            </li>
          );
        })}
        <li>
          <AddDiseaseCard
            member={member}
            diseaseOptions={diseaseOptions}
            onAdd={(code) => act(code, "confirmed")}
          />
        </li>
      </ul>
    </div>
  );
}

/** The folded date range (mockup redesign) — a compact "Start → End" trigger
 *  that opens a popover with the two original date inputs. Same testids
 *  (`roster-start-*` / `roster-end-*`) as the pre-redesign always-visible
 *  inputs so the write path (`onStartChange`/`onEndChange`) is untouched. */
function MemberDateRange({
  member,
  onStartChange,
  onEndChange,
  needsCloseOut,
}: {
  member: RosterMember;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  needsCloseOut: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`text-xs hover:underline ${
            needsCloseOut ? "text-apollo-amber font-semibold" : "text-muted-foreground"
          }`}
          data-testid={`roster-dates-trigger-${member.cwid}`}
        >
          {formatDate(member.startDate)} → {formatDate(member.endDate)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-64 flex-col gap-3 p-3"
        data-testid={`roster-dates-menu-${member.cwid}`}
      >
        {needsCloseOut && (
          <p className="text-apollo-amber text-xs">
            This person has left WCM. Set an end date to close out their membership.
          </p>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`roster-start-${member.cwid}`} className="text-muted-foreground text-xs font-medium">
            Start
          </label>
          <Input
            id={`roster-start-${member.cwid}`}
            type="date"
            className="h-8"
            value={member.startDate ?? ""}
            onChange={(e) => onStartChange(e.target.value)}
            data-testid={`roster-start-${member.cwid}`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`roster-end-${member.cwid}`} className="text-muted-foreground text-xs font-medium">
            End
          </label>
          <Input
            id={`roster-end-${member.cwid}`}
            type="date"
            className={`h-8 ${needsCloseOut ? "border-apollo-amber focus-visible:ring-apollo-amber" : ""}`}
            value={member.endDate ?? ""}
            onChange={(e) => onEndChange(e.target.value)}
            data-testid={`roster-end-${member.cwid}`}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function CenterRosterCard({
  unitCode,
  members: initial,
  programs,
  today,
  exportEnabled = false,
  diseaseOptions = [],
}: CenterRosterCardProps) {
  const now = today ?? todayIso();
  const hasPrograms = programs.length > 0;

  const [members, setMembers] = React.useState<RosterMember[]>(() => [...initial]);
  // One mutually-exclusive filter, defaulting to the WHOLE roster. Two
  // checkboxes could not express "only" honestly: two independent "X only"
  // boxes both unchecked means no restriction, and both checked means an
  // impossible intersection. A segmented control makes the three states the
  // curator actually wants explicit, and nothing is ever silently hidden.
  const [filter, setFilter] = React.useState<RosterFilter>("all");
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<RosterMember | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Disease-column state: which rows are expanded, plus the new filter bar.
  const [expandedCwids, setExpandedCwids] = React.useState<Set<string>>(() => new Set());
  const [selectedDiseaseCodes, setSelectedDiseaseCodes] = React.useState<Set<string>>(() => new Set());
  const [diseaseSearch, setDiseaseSearch] = React.useState("");
  const [confidenceFilter, setConfidenceFilter] = React.useState<ConfidenceFilter>("any");
  const [needsReviewOnly, setNeedsReviewOnly] = React.useState(false);
  // Free-text search — case-insensitive substring match against name OR cwid.
  const [freeText, setFreeText] = React.useState("");

  function toggleExpand(cwid: string) {
    setExpandedCwids((prev) => {
      const next = new Set(prev);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });
  }

  function toggleDiseaseCode(code: string) {
    setSelectedDiseaseCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function clearAllFilters() {
    setSelectedDiseaseCodes(new Set());
    setDiseaseSearch("");
    setConfidenceFilter("any");
    setNeedsReviewOnly(false);
    setFreeText("");
  }

  async function post(body: Record<string, unknown>): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch("/api/edit/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitType: "center", unitCode, ...body }),
      });
    } catch {
      // Network failure — surface it and let callers roll back the optimistic write.
      setError(mapErrorToMessage(""));
      return false;
    }
    // A failed response may carry no JSON body (e.g. a bodyless 401 from auth
    // middleware); check res.ok and parse defensively so a phantom row can't
    // linger with no error shown.
    const data = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
    if (!res.ok || data?.ok !== true) {
      setError(mapErrorToMessage(data?.error ?? ""));
      return false;
    }
    return true;
  }

  /** Per-cwid write chain so two quick edits to the SAME row don't race. The
   *  API guards against concurrent modification ("record has changed since last
   *  read"); a second field edit fired before the first POST returns would 500
   *  and revert (e.g. setting Start then End in quick succession). */
  const writeQueue = React.useRef<Map<string, Promise<unknown>>>(new Map());

  /** Inline one-field set; optimistic with revert on failure, serialized per row. */
  async function patch(cwid: string, field: Partial<RosterMember>) {
    setError(null);
    const prev = members.find((m) => m.cwid === cwid);
    if (!prev) return;
    const next = { ...prev, ...field };
    setMembers((ms) => ms.map((m) => (m.cwid === cwid ? next : m)));
    const prior = writeQueue.current.get(cwid) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        const ok = await post({ cwid, action: "set", ...field });
        if (!ok) setMembers((ms) => ms.map((m) => (m.cwid === cwid ? prev : m)));
      });
    writeQueue.current.set(cwid, run);
    await run;
  }

  /** Per-(cwid, diseaseCode) write chain — same reason `writeQueue` above
   *  exists: two quick decisions on the SAME pair (e.g. Reject then Clear)
   *  shouldn't race. */
  const diseaseWriteQueue = React.useRef<Map<string, Promise<unknown>>>(new Map());

  /** Replace, insert, or (passing `null`) remove one member's disease row. A
   *  manual add has no row to replace (insert); clearing a manual add's
   *  decision leaves nothing to show, so it removes the row entirely rather
   *  than nulling `decision` on an assignment-less row. */
  function setDiseaseRow(cwid: string, diseaseCode: string, next: RosterDiseaseRow | null) {
    setMembers((ms) =>
      ms.map((m) => {
        if (m.cwid !== cwid) return m;
        const diseases = m.diseases ?? [];
        const idx = diseases.findIndex((d) => d.diseaseCode === diseaseCode);
        if (next === null) {
          return idx === -1 ? m : { ...m, diseases: diseases.filter((d) => d.diseaseCode !== diseaseCode) };
        }
        return idx === -1
          ? { ...m, diseases: [...diseases, next] }
          : { ...m, diseases: diseases.map((d, i) => (i === idx ? next : d)) };
      }),
    );
  }

  /** Confirm / Reject / Clear one (cwid, diseaseCode) decision — optimistic
   *  with revert on failure, serialized per pair, mirroring `patch()` above.
   *  "confirmed" with no existing row is the manual-add path (a curator
   *  attaching a code the generator never suggested — the API route's own
   *  contract); "rejected"/"clear" always need an existing row. Unlike
   *  `patch()`, the route's success response carries the server's
   *  authoritative `scoreAtDecision`/`confidenceAtDecision` snapshot, so a
   *  successful confirm/reject reconciles onto that instead of trusting the
   *  client's guess (which assumed the row's CURRENT assignment hadn't
   *  changed since page load). */
  async function decideDisease(cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) {
    setError(null);
    const member = members.find((m) => m.cwid === cwid);
    const prevRow = member?.diseases?.find((d) => d.diseaseCode === diseaseCode);
    if (!prevRow && decision !== "confirmed") return;

    if (decision === "clear") {
      // Clearing an ordinary decision reverts the row to pending (the
      // assignment still exists). Clearing a manual add's decision leaves
      // nothing left to show — no assignment backs it — so the row
      // disappears, same as it never having been added.
      setDiseaseRow(cwid, diseaseCode, prevRow?.assignment ? { ...prevRow, decision: null, drifted: false } : null);
    } else {
      setDiseaseRow(cwid, diseaseCode, {
        diseaseCode,
        assignment: prevRow?.assignment ?? null,
        decision: {
          decision,
          decidedBy: prevRow?.decision?.decidedBy ?? "",
          decidedAt: new Date(),
          scoreAtDecision: prevRow?.assignment?.score ?? prevRow?.decision?.scoreAtDecision ?? null,
          confidenceAtDecision: prevRow?.assignment?.confidence ?? prevRow?.decision?.confidenceAtDecision ?? null,
        },
        drifted: false,
      });
    }

    const key = `${cwid}::${diseaseCode}`;
    const prior = diseaseWriteQueue.current.get(key) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        let res: Response;
        try {
          res = await fetch(`/api/edit/center/${encodeURIComponent(unitCode)}/disease-assignments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwid, diseaseCode, decision }),
          });
        } catch {
          setError(mapErrorToMessage(""));
          setDiseaseRow(cwid, diseaseCode, prevRow ?? null);
          return;
        }
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; scoreAtDecision?: number | null; confidenceAtDecision?: string | null }
          | null;
        if (!res.ok || data?.ok !== true) {
          setError(mapErrorToMessage(data?.error ?? ""));
          setDiseaseRow(cwid, diseaseCode, prevRow ?? null);
          return;
        }
        if (decision !== "clear" && data.scoreAtDecision !== undefined && data.confidenceAtDecision !== undefined) {
          const scoreAtDecision = data.scoreAtDecision;
          const confidenceAtDecision = data.confidenceAtDecision;
          setDiseaseRow(cwid, diseaseCode, {
            diseaseCode,
            assignment: prevRow?.assignment ?? null,
            decision: {
              decision,
              decidedBy: prevRow?.decision?.decidedBy ?? "",
              decidedAt: new Date(),
              scoreAtDecision,
              confidenceAtDecision,
            },
            drifted: false,
          });
        }
      });
    diseaseWriteQueue.current.set(key, run);
    await run;
  }

  async function add() {
    if (!addValue || adding) return;
    const picked = addValue;
    if (members.some((m) => m.cwid === picked.cwid)) {
      setAddValue(null);
      return;
    }
    setError(null);
    setAdding(true);
    const member: RosterMember = {
      cwid: picked.cwid,
      name: picked.name,
      title: picked.title,
      membershipType: null,
      programCode: null,
      startDate: null,
      endDate: null,
    };
    setMembers((ms) => [member, ...ms]);
    setAddValue(null);
    const ok = await post({ cwid: picked.cwid, action: "add" });
    if (!ok) setMembers((ms) => ms.filter((m) => m.cwid !== picked.cwid));
    setAdding(false);
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setError(null);
    const ok = await post({ cwid: removeTarget.cwid, action: "remove" });
    if (!ok) throw new Error("remove_failed");
    setMembers((ms) => ms.filter((m) => m.cwid !== removeTarget.cwid));
    setRemoveTarget(null);
  }

  function onStartChange(m: RosterMember, value: string) {
    const startDate = value || null;
    if (startDate && m.endDate && m.endDate < startDate) {
      setError("Start date can't be after the end date.");
      return;
    }
    void patch(m.cwid, { startDate });
  }

  function onEndChange(m: RosterMember, value: string) {
    const endDate = value || null;
    if (endDate && m.startDate && endDate < m.startDate) {
      setError("End date can't be before the start date.");
      return;
    }
    void patch(m.cwid, { endDate });
  }

  const needsCloseOutOf = (m: RosterMember) =>
    m.scholarState === "departed" && statusOf(m, now) !== "inactive";

  const hasDiseases = members.some((m) => (m.diseases ?? []).length > 0);

  const rosterFiltered =
    filter === "inactive"
      ? members.filter((m) => statusOf(m, now) === "inactive")
      : filter === "departed"
        ? members.filter((m) => m.scholarState === "departed")
        : members;

  // The new filter-bar controls, AND-composed on top of the segmented filter
  // above. `preDiseaseFiltered` excludes the disease multi-select itself so
  // the multi-select's OWN option counts stay meaningful as more codes are
  // checked (an OR-widening selection, not a further narrowing one).
  const preDiseaseFiltered = rosterFiltered.filter((m) => {
    if (confidenceFilter !== "any") {
      const hasTier = liveDiseaseRows(m).some((d) => confidenceOf(d) === confidenceFilter);
      if (!hasTier) return false;
    }
    if (needsReviewOnly && pendingDiseaseRows(m).length === 0) return false;
    const q = freeText.trim().toLowerCase();
    if (q && !m.name.toLowerCase().includes(q) && !m.cwid.toLowerCase().includes(q)) return false;
    return true;
  });

  // Disease multi-select FILTER options: every code that appears anywhere on
  // the roster, with a count of currently-visible (pre-disease-filter)
  // members holding a live assignment to it. Distinct from the `diseaseOptions`
  // PROP (the full canonical list, for the "+ Add a disease" picker) —
  // this one only ever lists codes someone on THIS roster already has.
  const diseaseCodeCounts = new Map<string, number>();
  const rosterDiseaseCodes = new Set<string>();
  for (const m of members) for (const d of m.diseases ?? []) rosterDiseaseCodes.add(d.diseaseCode);
  for (const m of preDiseaseFiltered) {
    const seen = new Set<string>();
    for (const d of liveDiseaseRows(m)) {
      if (seen.has(d.diseaseCode)) continue;
      seen.add(d.diseaseCode);
      diseaseCodeCounts.set(d.diseaseCode, (diseaseCodeCounts.get(d.diseaseCode) ?? 0) + 1);
    }
  }
  const rosterDiseaseOptions = [...rosterDiseaseCodes]
    .map((code) => ({ code, count: diseaseCodeCounts.get(code) ?? 0 }))
    .sort((a, b) => diseaseLabel(a.code).localeCompare(diseaseLabel(b.code)));
  const rosterDiseaseOptionsShown = rosterDiseaseOptions.filter((o) => {
    const q = diseaseSearch.trim().toLowerCase();
    return !q || diseaseLabel(o.code).toLowerCase().includes(q) || o.code.toLowerCase().includes(q);
  });

  const visible =
    selectedDiseaseCodes.size === 0
      ? preDiseaseFiltered
      : preDiseaseFiltered.filter((m) =>
          liveDiseaseRows(m).some((d) => selectedDiseaseCodes.has(d.diseaseCode)),
        );

  // The total pending count across the WHOLE roster — unaffected by any
  // active filter, so the "Needs review" pill's badge is a stable total.
  const pendingTotal = members.reduce((sum, m) => sum + pendingDiseaseRows(m).length, 0);

  const filtersActive =
    selectedDiseaseCodes.size > 0 || confidenceFilter !== "any" || needsReviewOnly || freeText.trim() !== "";

  // The nudge is about WORK OUTSTANDING, not about what the filter is hiding —
  // "all" hides nothing now. These are the people who left WCM while their
  // membership stayed open, which is the only state here needing a curator.
  const needsCloseOut = members.filter(needsCloseOutOf).length;
  // Member + [Type, Program] + [Diseases] + Status — Start/End are no longer
  // their own columns (folded into Program/Member, see `MemberDateRange`).
  const colCount = (hasPrograms ? 4 : 2) + (hasDiseases ? 1 : 0);

  return (
    <EditPanel
      slot="center-roster-card"
      heading="Members"
      description="The people listed on this center. Listing a member does not grant them edit access."
    >
      <div className="flex flex-col gap-4">
        <div className="border-apollo-border flex flex-col gap-3 rounded-md border p-4" data-slot="center-roster-add">
          <p className="text-sm font-medium">Add member</p>
          <DirectoryPeopleTypeahead idPrefix="roster" value={addValue} onChange={setAddValue} />
          <div className="flex justify-end">
            <Button type="button" variant="apollo" onClick={add} disabled={!addValue || adding} data-testid="center-roster-add">
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          {exportEnabled ? (
            <a
              // No `?activeOnly=1`: "active only" stopped being one of the views,
              // so the export is the whole roster and its `status` column (which
              // matches the badge exactly — see the export route's docblock) is
              // what distinguishes the rows.
              href={`/edit/center/${encodeURIComponent(unitCode)}/export`}
              className="text-apollo-slate text-sm hover:underline"
              data-testid="center-roster-export-link"
            >
              Export CSV
            </a>
          ) : (
            <span />
          )}
          {/* A 3-button segmented control, not a radio group — matches the
              mockup, and stays the same "one mutually-exclusive choice"
              semantics the docblock above argues for. */}
          <div className="flex items-center gap-2" role="group" aria-label="Filter members">
            {(
              [
                ["all", "All members"],
                ["inactive", "Inactive"],
                ["departed", "Departed"],
              ] as ReadonlyArray<readonly [RosterFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
                  filter === value
                    ? "border-apollo-maroon bg-apollo-maroon text-white"
                    : "border-apollo-border text-muted-foreground hover:bg-accent"
                }`}
                data-testid={`roster-filter-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* The new filter bar — free-text search always available; the
            disease/confidence/needs-review controls only when this center
            actually has assignment data. AND-composed with each other and
            with the segmented filter above. */}
        <div className="flex flex-wrap items-end gap-3" data-testid="center-roster-filter-bar">
          <div className="flex flex-col gap-1">
            <label htmlFor="roster-search-input" className="text-muted-foreground text-xs font-medium">
              Search
            </label>
            <Input
              id="roster-search-input"
              type="text"
              placeholder="Name or CWID"
              className="h-8 w-48"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              data-testid="roster-search-input"
            />
          </div>

          {hasDiseases && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs font-medium">Disease</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5" data-testid="roster-disease-filter-trigger">
                      {selectedDiseaseCodes.size === 0
                        ? "Any disease"
                        : `${selectedDiseaseCodes.size} selected`}
                      <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-2" data-testid="roster-disease-filter-menu">
                    <Input
                      type="text"
                      placeholder="Filter diseases…"
                      className="mb-2 h-8"
                      value={diseaseSearch}
                      onChange={(e) => setDiseaseSearch(e.target.value)}
                      data-testid="roster-disease-filter-search"
                    />
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                      {rosterDiseaseOptionsShown.length === 0 ? (
                        <p className="text-muted-foreground px-1.5 py-1 text-xs">No diseases match.</p>
                      ) : (
                        rosterDiseaseOptionsShown.map((opt) => (
                          <label
                            key={opt.code}
                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-sm"
                            data-testid={`roster-disease-filter-option-${opt.code}`}
                          >
                            <Checkbox
                              checked={selectedDiseaseCodes.has(opt.code)}
                              onCheckedChange={() => toggleDiseaseCode(opt.code)}
                            />
                            <span className="truncate">{diseaseLabel(opt.code)}</span>
                            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{opt.count}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="roster-confidence-filter" className="text-muted-foreground text-xs font-medium">
                  Confidence
                </label>
                <select
                  id="roster-confidence-filter"
                  className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                  value={confidenceFilter}
                  onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
                  data-testid="roster-confidence-filter"
                >
                  <option value="any">Any</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => setNeedsReviewOnly((v) => !v)}
                aria-pressed={needsReviewOnly}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                  needsReviewOnly
                    ? "border-apollo-amber bg-apollo-amber text-white"
                    : "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber"
                }`}
                data-testid="roster-needs-review-toggle"
              >
                Needs review
                <span
                  className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] tabular-nums ${
                    needsReviewOnly ? "bg-white/25 text-white" : "bg-white/60 text-apollo-amber"
                  }`}
                >
                  {pendingTotal}
                </span>
              </button>
            </>
          )}
        </div>

        {filtersActive && (
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground" data-testid="roster-filter-result-line">
              Showing {visible.length} of {rosterFiltered.length} members
            </span>
            <button
              type="button"
              className="text-apollo-slate text-xs hover:underline"
              onClick={clearAllFilters}
              data-testid="roster-filter-clear-all"
            >
              Clear all filters
            </button>
          </div>
        )}

        {needsCloseOut > 0 && filter !== "departed" && (
          <p className="text-muted-foreground text-sm" data-testid="roster-needs-close-out">
            {needsCloseOut === 1
              ? "1 member has left WCM with their membership still open."
              : `${needsCloseOut} members have left WCM with their membership still open.`}{" "}
            <button
              type="button"
              className="text-apollo-slate underline"
              onClick={() => setFilter("departed")}
              data-testid="roster-needs-close-out-jump"
            >
              Show them
            </button>{" "}
            to set an end date.
          </p>
        )}

        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="center-roster-empty">
            This roster is empty. Add the first member to populate this center.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="[&_td]:align-middle w-full min-w-[720px] text-sm" data-testid="center-roster-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">Member</th>
                {hasPrograms && <th className="px-3 py-2 font-medium">Type</th>}
                {hasPrograms && <th className="px-3 py-2 font-medium">Program</th>}
                {hasDiseases && <th className="px-3 py-2 font-medium">Diseases</th>}
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={colCount + 1} className="text-muted-foreground px-3 py-3">
                    {rosterFiltered.length === 0 ? (
                      <>
                        No members match this filter. Choose &ldquo;All members&rdquo; to see the whole
                        roster.
                      </>
                    ) : (
                      <>
                        No members match the current filters.{" "}
                        <button
                          type="button"
                          className="text-apollo-slate underline"
                          onClick={clearAllFilters}
                          data-testid="roster-filter-clear-all-inline"
                        >
                          Clear all filters
                        </button>{" "}
                        to see more.
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                visible.map((m) => {
                  const status = statusOf(m, now);
                  // The case this card exists to surface (see the type docblock):
                  // the person left WCM but nobody closed out their membership, so
                  // it still reads Active. Amber is this UI's "needs attention"
                  // (honors-queue contested groups, all-units-directory), not red —
                  // it is a data-quality gap to fix, not a failure. Mutually
                  // exclusive with the `opacity-50` inactive dimming by
                  // construction, so the two never compose.
                  const rowNeedsCloseOut = needsCloseOutOf(m);
                  const expanded = expandedCwids.has(m.cwid);
                  const dateRange = (
                    <MemberDateRange
                      member={m}
                      onStartChange={(v) => onStartChange(m, v)}
                      onEndChange={(v) => onEndChange(m, v)}
                      needsCloseOut={rowNeedsCloseOut}
                    />
                  );
                  return (
                    <React.Fragment key={m.cwid}>
                    <tr
                      className={`border-apollo-border border-b ${
                        status === "inactive" ? "opacity-50" : ""
                      } ${rowNeedsCloseOut ? "bg-apollo-amber-tint" : ""}`}
                      data-testid={`center-roster-row-${m.cwid}`}
                      data-needs-close-out={rowNeedsCloseOut ? "true" : undefined}
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{m.name}</span>
                          {m.title && <span className="text-muted-foreground">· {m.title}</span>}
                          {m.scholarState === "departed" && (
                            <Badge
                              variant="outline"
                              className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                              data-testid={`roster-scholar-state-${m.cwid}`}
                            >
                              Left WCM
                            </Badge>
                          )}
                          {m.scholarState === "unknown" && (
                            <Badge
                              variant="outline"
                              className="border-apollo-border rounded-full"
                              data-testid={`roster-scholar-state-${m.cwid}`}
                              title="No directory record matches this CWID, so we can't show a name."
                            >
                              Not in directory
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground text-xs" data-testid={`roster-cwid-${m.cwid}`}>
                          CWID: {m.cwid}
                        </div>
                        {/* No Program column on this center — the date range
                            folds under Member instead, so it's never dropped. */}
                        {!hasPrograms && <div className="mt-0.5">{dateRange}</div>}
                      </td>
                      {hasPrograms && (
                        <td className="px-3 py-2">
                          <select
                            className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                            value={m.membershipType ?? ""}
                            onChange={(e) =>
                              patch(m.cwid, {
                                membershipType: (e.target.value || null) as RosterMember["membershipType"],
                              })
                            }
                            data-testid={`roster-type-${m.cwid}`}
                          >
                            <option value="">—</option>
                            <option value="research">Research</option>
                            <option value="clinical">Clinical</option>
                          </select>
                        </td>
                      )}
                      {hasPrograms && (
                        <td className="px-3 py-2">
                          <select
                            className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                            value={m.programCode ?? ""}
                            onChange={(e) => patch(m.cwid, { programCode: e.target.value || null })}
                            data-testid={`roster-program-${m.cwid}`}
                          >
                            <option value="">—</option>
                            {programs.map((p) => (
                              <option key={p.code} value={p.code}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                          <div className="mt-0.5">{dateRange}</div>
                        </td>
                      )}
                      {hasDiseases && (
                        <td className="px-3 py-2">
                          <DiseaseChips member={m} onToggleExpand={toggleExpand} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={`rounded-full ${
                            status === "active"
                              ? "bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border"
                              : "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
                          }`}
                          data-testid={`roster-status-${m.cwid}`}
                        >
                          {status === "active" ? "Active" : status === "pending" ? "Pending" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoveTarget(m)}
                          data-testid={`roster-remove-${m.cwid}`}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                    {hasDiseases && expanded && (m.diseases ?? []).length > 0 && (
                      <tr className="border-apollo-border bg-apollo-surface-2 border-b" data-testid={`disease-expand-row-${m.cwid}`}>
                        <td colSpan={colCount + 1} className="px-3 py-3">
                          <DiseaseExpandedPanel
                            member={m}
                            diseaseOptions={diseaseOptions}
                            onDecide={decideDisease}
                            onCollapse={() => toggleExpand(m.cwid)}
                          />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        )}

        {hasDiseases && (
          <div
            className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
            data-testid="roster-disease-legend"
          >
            <span className="text-foreground font-medium">Confidence</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-green-foreground size-2.5 rounded-full" aria-hidden />
              High
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-amber size-2.5 rounded-full" aria-hidden />
              Medium
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-slate size-2.5 rounded-full" aria-hidden />
              Low
            </span>
            <span>✓ = confirmed by an editor · rejected assignments are hidden from chips</span>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <p className="text-sm">
          <Link
            href={`/edit/center/${encodeURIComponent(unitCode)}/history`}
            className="text-apollo-slate hover:underline"
            data-testid="center-roster-history-link"
          >
            View change history
          </Link>
        </p>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove ${removeTarget.name} from this center?` : ""}
        // Steers to the End date. The previous copy ("You can add them back at
        // any time") framed removal as cheap and reversible, which is how a
        // roster loses its history: a member who LEFT and a member added in
        // ERROR are different facts, and only the second one should be erased.
        description={
          removeTarget && removeTarget.endDate
            ? "This erases the membership from the roster, including the end date already recorded. Remove only if this person was added in error — otherwise the end date alone is the correct record."
            : "This erases the membership from the roster entirely, and the center loses any record that they were ever a member. If they have LEFT the center, close the row out with an End date instead — that keeps the history. Remove only if this person was added in error."
        }
        reasonMode="none"
        confirmLabel="Remove anyway"
        confirmVariant="destructive"
        onConfirm={confirmRemove}
      />
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this center. Refresh the page and try again.";
    case "invalid_date_range":
      return "The end date can't be before the start date.";
    case "no_taxonomy":
    case "invalid_program_code":
      return "That program isn't available for this center.";
    case "assignment_not_found":
      return "This disease is no longer in the current assignment list. Refresh the page to see what changed.";
    case "unknown_disease_code":
      return "That disease code isn't recognized. Refresh the page and try again.";
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
