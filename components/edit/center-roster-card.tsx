/**
 * CenterRosterCard — the rich center roster table (#552 §6.1; the deferred
 * #540 PR-7b-roster). Columns: Member | Role | [Program] | [Diseases] |
 * Status. Start/End and Remove are NOT their own columns — see "Dates" below.
 *
 * Role renders for every center, from the MEMBERSHIP-group `OrgUnitRole`
 * vocabulary (`membershipRoles` prop, CHPC's Core/Affiliate Faculty Fellow
 * roles included). Program is surfaced **only when the center has a program
 * taxonomy** (`programs.length > 0`) — the data-driven "Cancer-Center-only"
 * gate. Start/End still drive the derived Active / Pending / Inactive status
 * (the #552 §3.3 active filter, inclusive boundaries, nulls open).
 *
 * Dates: a compact label ("Since Mar 2021", "Mar 2021 – Jun 2026", "Ended
 * Jun 2026", "No start date") plus an "Edit dates" link (`MemberDateRange`)
 * sits under the Program name (or under the Member name/title when the center
 * has no programs, so the range is never dropped) instead of two
 * always-visible date-input columns. "Edit dates" opens a small popover
 * with the same two `<input type=date>` fields as before, same
 * `onStartChange`/`onEndChange` validation (End < Start blocked client-side).
 * Remove sits inside that popover, under the End date — a rare action (an
 * add made in error), not something that needs permanent width on every row.
 *
 * ONE mutually-exclusive filter — All members (default) / Invited / Inactive /
 * Left WCM — rendered as status tabs, each labelled with its count, so the
 * roster opens on the whole thing and nothing is ever silently hidden. Two
 * independent "X only" checkboxes could not say this honestly: both
 * unchecked reads as no restriction, both checked as an impossible
 * intersection. Invited is a membership ROLE (#2779, `INVITED_ROLE_KEY`);
 * the Invited tab and badge derive from it.
 *
 * A row whose person has left WCM while the membership is still open is
 * tinted amber and its date-range trigger colored to match, because that is
 * the combination this card exists to surface; its Status cell reads "Left
 * WCM" instead of the membership status. "Left WCM" is the roster
 * row's `scholarState === "departed"` (`scholarStateOf` in
 * `unit-edit-context.ts`: the Scholar row is soft-deleted), and "still open" means the
 * membership is not Inactive by its dates. The count of those rows drives
 * the "Membership upkeep" card above the table ("Review each" jumps to the
 * Left WCM tab) — outstanding work, not hidden rows.
 *
 * Inline edits POST `/api/edit/roster` `action:"set"` one field at a time
 * (a field present as `null` clears it). Add → `action:"add"`, Remove →
 * `action:"remove"` (the server refuses it for a `ctsc-feed` row, whose
 * nightly sync would undo it). The list updates optimistically; a failed
 * write reverts and surfaces an error.
 *
 * Diseases: a "Diseases" column renders only for a center that actually has
 * assignment data (`hasDiseases`) — data-driven, since `unit-edit-context.ts`
 * gates the whole `diseases`/`diseaseOptions` payload on the center having a
 * `CenterProgram` taxonomy (so never on CTSC). Each member shows an amber
 * "N to review" pill for undecided rows and an "N confirmed" count; "+ Add a
 * disease" for a member with none, "Manage" when every row was rejected. A
 * "Disease inferences" summary card above the table counts members to review
 * and live inferences by confidence, and holds "Start review queue". Every
 * cell control opens
 * `CenterDiseaseReviewSheet` (Edit Center redesign; replaces the inline
 * expanded panel): evidence, Confirm / Reject / Undo, "Confirm N
 * high-confidence", and manual add. "Start review queue (N)" walks the
 * filtered members with something to review, one sheet at a time. Every
 * decision POSTs the existing `/api/edit/center/[code]/disease-assignments`
 * route via `decideDisease`, one pair at a time, serialized per (cwid,
 * diseaseCode) — so a bulk confirm is N ordinary decisions with N audit rows.
 *
 * The filter bar narrows the visible member list — client-side, over the
 * already-loaded roster, AND-composed with each other and with the status
 * tabs: a free-text search (name or CWID), a disease multi-select, Program
 * (a center with a program taxonomy only), a confidence tier, and a "Has
 * diseases to review" toggle whose count is the members matching every other
 * filter who have at least one undecided row. With the toggle on, a member
 * whose last undecided row the curator just decided STAYS listed (and on the
 * current page) until the toggle is flipped or the filters are cleared, so a
 * decision never makes a row vanish or collapses paging. The toggle also
 * narrows the disease multi-select's option counts, like every other filter.
 * "Clear all filters" resets them. The result pages 25 at a time ("Show 25
 * more").
 */
"use client";

import Link from "next/link";
import * as React from "react";
import { ArrowRight, ChevronDown, Download, Plus, Search } from "lucide-react";

import { CenterDiseaseReviewSheet } from "@/components/edit/center-disease-review-sheet";
import {
  confidenceOf,
  confirmedDiseaseRows,
  diseaseLabel,
  liveDiseaseRows,
  pendingDiseaseRows,
  type DiseaseDecisionKind,
} from "@/components/edit/center-roster-diseases";
import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DiseaseCodeOption, RosterDiseaseRow } from "@/lib/api/unit-edit-context";
import { INVITED_ROLE_KEY, MEMBER_ROLE_KEY, deriveMembershipType } from "@/lib/org-unit-roles";
import { CTSC_EXTERNAL_SOURCE, externalSourceLabel } from "@/lib/edit/external-member-sources";

export type RosterMember = {
  cwid: string;
  name: string;
  title: string | null;
  membershipType: "research" | "clinical" | null;
  /** #2542 vocabulary key backing `membershipType` — the CHPC fellow-roles
   *  select reads/writes this instead. Absent (pre-vocabulary fixtures) ⇒
   *  `"member"`. */
  membershipRoleKey?: string | null;
  programCode: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Whether the PERSON is still at WCM. Orthogonal to the membership dates:
   *  a row can be membership-Active AND scholarState "departed" — someone who
   *  left WCM with nobody having closed out their center membership. That
   *  combination is the whole point of surfacing this. Optional so existing
   *  fixtures/callers that predate #2324 still type-check; absent → "active".
   *  `"external"` (#2519) is a Cornell (Ithaca) directory member with no WCM
   *  profile at all — never "departed" or "unknown", it never had one. */
  scholarState?: "active" | "departed" | "unknown" | "external";
  /** #1827 — false ⇒ the public center page will NOT render this member (no
   *  active Scholar row, a suppressed profile, or a hidden role class), so the
   *  row is inert publicly. Absent → treated as listed. */
  publiclyListed?: boolean;
  /** Membership source (`manual-ui`, `cornell-ithaca`, `ctsc-feed`, …). Optional
   *  for fixtures that predate it; the context always sends it. */
  source?: string;
  /** Disease-assignment plan §5/§6 — this member's ranked disease-expertise
   *  picture, `[]`/absent for a non-center roster or a member with none.
   *  Optional for the same reason `scholarState` is: existing fixtures/callers
   *  that predate this feature still type-check. Already server-sorted by
   *  rank (drift-only decision rows trailing by code) — see
   *  `loadUnitEditContext`. */
  diseases?: ReadonlyArray<RosterDiseaseRow>;
};

export type CenterProgramOption = { code: string; label: string; sortOrder: number };

export type CenterMembershipRoleOption = { key: string; label: string; sortOrder: number };

export type CenterRosterCardProps = {
  unitCode: string;
  members: ReadonlyArray<RosterMember>;
  programs: ReadonlyArray<CenterProgramOption>;
  /** The center's MEMBERSHIP-group vocabulary (`ctx.centerMembershipRoles`) —
   *  CHPC's Core/Affiliate Faculty Fellow roles etc. Defaults to `[]`; a
   *  `"member"` option is always shown even when this list lacks one (an
   *  unseeded center's vocabulary). */
  membershipRoles?: ReadonlyArray<CenterMembershipRoleOption>;
  /** Injectable for tests; defaults to today (YYYY-MM-DD). */
  today?: string;
  /** #1102 — when true, render the "Export .xlsx" roster-download affordance
   *  (the `EDIT_UNIT_ROSTER_EXPORT` flag, resolved server-side). */
  exportEnabled?: boolean;
  /** The canonical disease-code list for the "+ Add a disease" manual-add
   *  picker (`ctx.diseaseOptions`, `lib/api/unit-edit-context.ts`) — every
   *  code the taxonomy knows about, not just the ones already assigned on
   *  this roster. Defaults to `[]` (a non-Cancer-Center roster, or the
   *  context loader's own catch-and-degrade path). */
  diseaseOptions?: ReadonlyArray<DiseaseCodeOption>;
  /** #2519 — when true, render the WCM/Cornell source toggle above the add
   *  typeahead (the `CORNELL_DIRECTORY_MEMBERS` flag, resolved server-side —
   *  same pattern as `exportEnabled`). Defaults to false, so a caller that
   *  doesn't pass it gets today's WCM-only add form, byte-identical. */
  cornellDirectoryEnabled?: boolean;
};

type Status = "active" | "pending" | "inactive" | "invited";

/** The mutually-exclusive roster views. `all` is the default. */
type RosterFilter = "all" | "invited" | "inactive" | "departed";

type ConfidenceFilter = "any" | "high" | "medium" | "low";

/** Rows per "Show 25 more" page. */
const PAGE_SIZE = 25;

/** #552 §3.3 active filter, inclusive boundaries, nulls open. Mirrors
 *  `isCenterMembershipActive`: an invitee is never active, whatever its dates. */
function statusOf(member: RosterMember, today: string): Status {
  if (member.membershipRoleKey === INVITED_ROLE_KEY) return "invited";
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO `YYYY-MM-DD` -> "Mar 2021" (the mockup's month-year precision; the
 *  popover still edits the exact day). */
function formatMonth(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** The mockup's one-line dates label. */
export function datesLabel(startDate: string | null, endDate: string | null): string {
  if (endDate) return startDate ? `${formatMonth(startDate)} – ${formatMonth(endDate)}` : `Ended ${formatMonth(endDate)}`;
  return startDate ? `Since ${formatMonth(startDate)}` : "No start date";
}

/**
 * The collapsed Diseases cell: an amber "N to review" pill for undecided
 * rows and an "N confirmed" count. A member with no disease rows at all gets
 * "+ Add a disease"; one whose rows were all rejected gets "Manage". Every
 * control opens the review sheet.
 */
function DiseaseCell({
  member,
  inactive,
  onOpen,
}: {
  member: RosterMember;
  inactive: boolean;
  onOpen: (cwid: string) => void;
}) {
  const diseases = member.diseases ?? [];
  const confirmed = confirmedDiseaseRows(diseases).length;
  const pending = pendingDiseaseRows(diseases).length;
  const open = () => onOpen(member.cwid);

  return (
    <div className="flex flex-col items-start gap-0.5" data-testid={`roster-disease-chips-${member.cwid}`}>
      {pending > 0 && (
        <button
          type="button"
          onClick={open}
          className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber hover:border-apollo-amber rounded-full border px-2.5 py-px text-xs font-medium whitespace-nowrap"
          data-testid={`roster-disease-pending-${member.cwid}`}
        >
          {pending} to review
        </button>
      )}
      {confirmed > 0 && (
        <button
          type="button"
          onClick={open}
          className="text-muted-foreground text-xs whitespace-nowrap hover:underline"
          data-testid={`roster-disease-manage-${member.cwid}`}
        >
          {confirmed} confirmed
        </button>
      )}
      {diseases.length === 0 && !inactive && (
        <button
          type="button"
          onClick={open}
          className="text-apollo-slate text-xs hover:underline"
          data-testid={`roster-disease-add-${member.cwid}`}
        >
          + Add a disease
        </button>
      )}
      {diseases.length > 0 && pending === 0 && confirmed === 0 && (
        <button
          type="button"
          onClick={open}
          className="text-apollo-slate text-xs hover:underline"
          data-testid={`roster-disease-manage-${member.cwid}`}
        >
          Manage
        </button>
      )}
    </div>
  );
}

/** The folded date range (mockup redesign) — a dates label plus an "Edit
 *  dates" trigger that opens a popover with the two original date inputs.
 *  Same testids (`roster-start-*` / `roster-end-*`) as the pre-redesign
 *  always-visible inputs so the write path (`onStartChange`/`onEndChange`)
 *  is untouched. */
function MemberDateRange({
  member,
  onStartChange,
  onEndChange,
  needsCloseOut,
  onRemove,
}: {
  member: RosterMember;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  needsCloseOut: boolean;
  onRemove: () => void;
}) {
  const hasDates = member.startDate !== null || member.endDate !== null;
  return (
    <Popover>
      <span
        className={`text-xs whitespace-nowrap ${
          needsCloseOut ? "text-apollo-amber font-semibold" : hasDates ? "text-muted-foreground" : "text-apollo-amber"
        }`}
        data-testid={`roster-dates-label-${member.cwid}`}
      >
        {datesLabel(member.startDate, member.endDate)}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-apollo-slate text-xs whitespace-nowrap hover:underline"
          data-testid={`roster-dates-trigger-${member.cwid}`}
        >
          Edit
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
        {/* Remove is rare (an add made in error) — it lives here, beside the
            End date that is usually the right record, not on every row. */}
        <button
          type="button"
          className="text-muted-foreground hover:text-destructive self-start text-xs hover:underline"
          onClick={onRemove}
          data-testid={`roster-remove-${member.cwid}`}
        >
          Remove from center
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function CenterRosterCard({
  unitCode,
  members: initial,
  programs,
  membershipRoles = [],
  today,
  exportEnabled = false,
  diseaseOptions = [],
  cornellDirectoryEnabled = false,
}: CenterRosterCardProps) {
  const now = today ?? todayIso();
  const hasPrograms = programs.length > 0;
  // Always at least a "Member" option — an unseeded center's vocabulary is `[]`.
  const roleOptions = React.useMemo(() => {
    const sorted = [...membershipRoles].sort((a, b) => a.sortOrder - b.sortOrder);
    return sorted.some((r) => r.key === MEMBER_ROLE_KEY)
      ? sorted
      : [{ key: MEMBER_ROLE_KEY, label: "Member", sortOrder: 0 }, ...sorted];
  }, [membershipRoles]);

  const [members, setMembers] = React.useState<RosterMember[]>(() => [...initial]);
  // #2519 — which directory the add typeahead searches. Only reachable when
  // `cornellDirectoryEnabled` renders the toggle; otherwise always "wcm".
  const [addSource, setAddSource] = React.useState<"wcm" | "cornell">("wcm");
  // One mutually-exclusive filter, defaulting to the WHOLE roster. Two
  // checkboxes could not express "only" honestly: two independent "X only"
  // boxes both unchecked means no restriction, and both checked means an
  // impossible intersection. A segmented control makes the three states the
  // curator actually wants explicit, and nothing is ever silently hidden.
  const [filter, setFilter] = React.useState<RosterFilter>("all");
  const [addOpen, setAddOpen] = React.useState(false);
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<RosterMember | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Disease review: the member whose sheet is open, and the review queue
  // (cwids, in roster order) when it was opened from "Start review queue".
  const [sheetCwid, setSheetCwid] = React.useState<string | null>(null);
  const [queue, setQueue] = React.useState<ReadonlyArray<string> | null>(null);
  const [selectedDiseaseCodes, setSelectedDiseaseCodes] = React.useState<Set<string>>(() => new Set());
  const [diseaseSearch, setDiseaseSearch] = React.useState("");
  const [confidenceFilter, setConfidenceFilter] = React.useState<ConfidenceFilter>("any");
  const [programFilter, setProgramFilter] = React.useState("");
  const [needsReviewOnly, setNeedsReviewOnly] = React.useState(false);
  // Members decided while "Has diseases to review" is on: they stay listed so
  // a decision doesn't pull the row out from under the curator (or reset
  // paging). Cleared whenever the toggle flips or the filters are cleared.
  const [reviewedHere, setReviewedHere] = React.useState<ReadonlySet<string>>(() => new Set());
  const tabRefs = React.useRef<Partial<Record<RosterFilter, HTMLButtonElement | null>>>({});
  // Free-text search — case-insensitive substring match against name OR cwid.
  const [freeText, setFreeText] = React.useState("");

  function openSheet(cwid: string) {
    setQueue(null);
    setSheetCwid(cwid);
  }

  function closeSheet() {
    setSheetCwid(null);
    setQueue(null);
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
    setProgramFilter("");
    setNeedsReviewOnly(false);
    setReviewedHere(new Set());
    setFreeText("");
  }

  function toggleNeedsReviewOnly() {
    setNeedsReviewOnly((v) => !v);
    setReviewedHere(new Set());
  }

  /** "Review and set end dates": select Left WCM and bring its tab into view
   *  (the tab strip scrolls sideways on a phone). */
  function jumpToDeparted() {
    setFilter("departed");
    tabRefs.current.departed?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  /** Resolves to the success body (truthy) or `false` on failure. */
  async function post(
    body: Record<string, unknown>,
  ): Promise<false | { ok: true; publiclyListed?: boolean }> {
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
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: string; publiclyListed?: boolean }
      | null;
    if (!res.ok || data?.ok !== true) {
      setError(mapErrorToMessage(data?.error ?? ""));
      return false;
    }
    return { ok: true, publiclyListed: data.publiclyListed };
  }

  /** Per-cwid write chain so two quick edits to the SAME row don't race. The
   *  API guards against concurrent modification ("record has changed since last
   *  read"); a second field edit fired before the first POST returns would 500
   *  and revert (e.g. setting Start then End in quick succession). */
  const writeQueue = React.useRef<Map<string, Promise<unknown>>>(new Map());

  /** Inline one-field set; optimistic with revert on failure, serialized per
   *  row. `postBody` overrides what's sent to the server when it must differ
   *  from the local optimistic patch (the role select sets `membershipType`
   *  locally too, via `deriveMembershipType`, but the wire contract is
   *  `membershipRoleKey` alone). */
  async function patch(cwid: string, field: Partial<RosterMember>, postBody?: Record<string, unknown>) {
    setError(null);
    const prev = members.find((m) => m.cwid === cwid);
    if (!prev) return;
    const next = { ...prev, ...field };
    setMembers((ms) => ms.map((m) => (m.cwid === cwid ? next : m)));
    const prior = writeQueue.current.get(cwid) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        const ok = await post({ cwid, action: "set", ...(postBody ?? field) });
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
    if (needsReviewOnly && pendingDiseaseRows(member?.diseases).length > 0) {
      setReviewedHere((s) => (s.has(cwid) ? s : new Set([...s, cwid])));
    }

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
    // #2519 — a Cornell pick with no WCM bridge (`wcmMatch`) adds as an
    // external member; a bridged Cornell pick steers to the ordinary WCM add
    // below (same as `addSource === "wcm"`, which never sets `wcmMatch`).
    const isCornellAdd = addSource === "cornell" && !picked.wcmMatch;
    const effectiveCwid = picked.wcmMatch ?? picked.netid ?? picked.cwid;
    if (members.some((m) => m.cwid === effectiveCwid)) {
      setAddValue(null);
      return;
    }
    setError(null);
    setAdding(true);
    const member: RosterMember = {
      cwid: effectiveCwid,
      name: picked.name,
      title: picked.title,
      membershipType: null,
      membershipRoleKey: MEMBER_ROLE_KEY,
      programCode: null,
      startDate: null,
      endDate: null,
    };
    setMembers((ms) => [member, ...ms]);
    setAddValue(null);
    const ok = isCornellAdd
      ? await post({ source: "cornell", netid: picked.netid, action: "add" })
      : await post({ cwid: effectiveCwid, action: "add" });
    if (!ok) setMembers((ms) => ms.filter((m) => m.cwid !== effectiveCwid));
    // #1827 — the server says this person won't render on the public center
    // page (no active, publicly-displayed profile): flag the new row.
    else if (ok.publiclyListed === false)
      setMembers((ms) =>
        ms.map((m) => (m.cwid === effectiveCwid ? { ...m, publiclyListed: false } : m)),
      );
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

  const statusCounts: Record<RosterFilter, number> = {
    all: members.length,
    invited: members.filter((m) => statusOf(m, now) === "invited").length,
    inactive: members.filter((m) => statusOf(m, now) === "inactive").length,
    departed: members.filter((m) => m.scholarState === "departed").length,
  };

  const rosterFiltered =
    filter === "inactive" || filter === "invited"
      ? members.filter((m) => statusOf(m, now) === filter)
      : filter === "departed"
        ? members.filter((m) => m.scholarState === "departed")
        : members;

  // The filter-bar controls, AND-composed on top of the status tabs above.
  const matchesBarFilters = (m: RosterMember) => {
    if (confidenceFilter !== "any") {
      const hasTier = liveDiseaseRows(m.diseases).some((d) => confidenceOf(d) === confidenceFilter);
      if (!hasTier) return false;
    }
    if (programFilter && m.programCode !== programFilter) return false;
    const q = freeText.trim().toLowerCase();
    if (q && !m.name.toLowerCase().includes(q) && !m.cwid.toLowerCase().includes(q)) return false;
    return true;
  };
  const matchesDiseaseFilter = (m: RosterMember) =>
    selectedDiseaseCodes.size === 0 ||
    liveDiseaseRows(m.diseases).some((d) => selectedDiseaseCodes.has(d.diseaseCode));
  const hasPending = (m: RosterMember) => pendingDiseaseRows(m.diseases).length > 0;
  // `preDiseaseFiltered` is every filter EXCEPT the disease multi-select, so
  // the multi-select's OWN option counts stay meaningful as more codes are
  // checked (an OR-widening selection, not a further narrowing one). The
  // review toggle is in it, so it narrows those counts too.
  const preDiseaseFiltered = rosterFiltered.filter(
    (m) => matchesBarFilters(m) && (!needsReviewOnly || hasPending(m) || reviewedHere.has(m.cwid)),
  );

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
    for (const d of liveDiseaseRows(m.diseases)) {
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

  const visible = preDiseaseFiltered.filter(matchesDiseaseFilter);

  // Members (under every other filter, not the toggle itself) with at least
  // one undecided disease — the "Has diseases to review" count and the
  // review queue's contents.
  const needsReviewList = rosterFiltered.filter((m) => matchesBarFilters(m) && matchesDiseaseFilter(m) && hasPending(m));

  // Page by cwid so a disease decision (which replaces the member objects)
  // doesn't reset "Show 25 more"; only a change to WHICH members match does
  // (and with the review toggle on, `reviewedHere` keeps a decided member in).
  const visibleKey = visible.map((m) => m.cwid).join("\n");
  const visibleCwids = React.useMemo(() => (visibleKey ? visibleKey.split("\n") : []), [visibleKey]);
  const paging = useShowMore(visibleCwids, PAGE_SIZE);
  const byCwid = new Map(members.map((m) => [m.cwid, m]));
  const pageMembers = paging.visible.flatMap((c) => byCwid.get(c) ?? []);

  const filtersActive =
    selectedDiseaseCodes.size > 0 ||
    confidenceFilter !== "any" ||
    programFilter !== "" ||
    needsReviewOnly ||
    freeText.trim() !== "";

  // The banner is about WORK OUTSTANDING, not about what the filter is hiding.
  // These are the people who left WCM while their membership stayed open,
  // which is the only state here needing a curator.
  const needsCloseOut = members.filter(needsCloseOutOf).length;
  // Member + Role + [Program] + [Diseases] + Status — Start/End are no longer
  // their own columns (folded into Program/Member, see `MemberDateRange`).
  const colCount = 3 + (hasPrograms ? 1 : 0) + (hasDiseases ? 1 : 0);

  // Disease-inference summary card — roster-wide, independent of the filters.
  const liveRows = members.flatMap((m) => liveDiseaseRows(m.diseases));
  const tierCounts = { high: 0, medium: 0, low: 0 };
  for (const d of liveRows) {
    const c = confidenceOf(d);
    if (c === "high" || c === "medium" || c === "low") tierCounts[c] += 1;
  }
  const membersToReview = members.filter(hasPending).length;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const liveTotal = liveRows.length || 1;
  // Redundant once the curator is ON the Left WCM tab.
  const showCloseOut = needsCloseOut > 0 && filter !== "departed";

  const programLabelOf = (code: string | null) =>
    code ? (programs.find((p) => p.code === code)?.label ?? code) : null;

  function startQueue() {
    const cwids = needsReviewList.map((m) => m.cwid);
    if (cwids.length === 0) return;
    setQueue(cwids);
    setSheetCwid(cwids[0]);
  }

  const sheetMember = sheetCwid ? (byCwid.get(sheetCwid) ?? null) : null;
  const queueIndex = queue && sheetCwid ? queue.indexOf(sheetCwid) : -1;
  // The next queued member who STILL has something to review (live state, so
  // anyone finished meanwhile is skipped).
  const nextCwid =
    queue && queueIndex >= 0
      ? queue.slice(queueIndex + 1).find((c) => pendingDiseaseRows(byCwid.get(c)?.diseases).length > 0)
      : undefined;
  const queueState =
    queue && queueIndex >= 0
      ? {
          position: queueIndex + 1,
          total: queue.length,
          nextName: nextCwid ? (byCwid.get(nextCwid)?.name ?? nextCwid) : null,
          onNext: () => nextCwid && setSheetCwid(nextCwid),
          onPrev: queueIndex > 0 ? () => setSheetCwid(queue[queueIndex - 1]) : null,
        }
      : null;

  return (
    <>
    {(hasDiseases || showCloseOut) && (
      <div className="mb-4 grid gap-4 lg:grid-cols-2" data-testid="center-roster-summary">
        {hasDiseases && (
          <section
            className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-xl border p-5"
            data-testid="roster-disease-summary"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">Disease inferences</p>
                <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="roster-disease-summary-members">
                  {membersToReview === 0
                    ? "Nothing left to review"
                    : `${fmt(membersToReview)} ${membersToReview === 1 ? "member" : "members"} to review`}
                </p>
                <p className="text-muted-foreground text-[13px] tabular-nums">{fmt(liveRows.length)} inferences</p>
              </div>
              {needsReviewList.length > 0 && (
                <Button type="button" variant="apollo" size="sm" onClick={startQueue} data-testid="roster-start-review-queue">
                  Start review queue
                  <ArrowRight className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
            <div className="bg-apollo-surface-2 flex h-2 overflow-hidden rounded-full" aria-hidden>
              <span className="bg-apollo-slate" style={{ width: `${(tierCounts.high / liveTotal) * 100}%` }} />
              <span className="bg-apollo-amber" style={{ width: `${(tierCounts.medium / liveTotal) * 100}%` }} />
              <span className="bg-apollo-border-strong" style={{ width: `${(tierCounts.low / liveTotal) * 100}%` }} />
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums" data-testid="roster-disease-summary-tiers">
              <span>
                <span className="bg-apollo-slate mr-1.5 inline-block size-2 rounded-sm" aria-hidden />
                <strong className="font-semibold">{fmt(tierCounts.high)}</strong> high
              </span>
              <span>
                <span className="bg-apollo-amber mr-1.5 inline-block size-2 rounded-sm" aria-hidden />
                <strong className="font-semibold">{fmt(tierCounts.medium)}</strong> medium
              </span>
              <span>
                <span className="bg-apollo-border-strong mr-1.5 inline-block size-2 rounded-sm" aria-hidden />
                <strong className="font-semibold">{fmt(tierCounts.low)}</strong> low
              </span>
            </p>
            {filtersActive && needsReviewList.length > 0 && (
              <p className="text-muted-foreground text-xs">
                The queue follows the Members filters below ({fmt(needsReviewList.length)}{" "}
                {needsReviewList.length === 1 ? "member" : "members"}).
              </p>
            )}
          </section>
        )}
        {showCloseOut && (
          <section
            className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-xl border p-5"
            data-testid="roster-upkeep"
          >
            <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">Membership upkeep</p>
            <div
              className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber flex flex-col gap-2.5 rounded-lg border px-4 py-3 text-sm"
              data-testid="roster-needs-close-out"
            >
              <p>
                <strong className="block font-semibold">
                  {needsCloseOut === 1 ? "1 member has left WCM" : `${needsCloseOut} members have left WCM`}
                </strong>
                Their center membership is still open.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="bg-apollo-surface w-fit"
                onClick={jumpToDeparted}
                data-testid="roster-needs-close-out-jump"
              >
                Review each
              </Button>
            </div>
          </section>
        )}
      </div>
    )}
    <EditPanel
      slot="center-roster-card"
      heading="Members"
      description="Listing a member does not grant them edit access."
      headerAction={
        <div className="flex flex-wrap items-center gap-2">
          {exportEnabled && (
            <a
              // No `?activeOnly=1`: the export is the whole roster, and its
              // `status` column is what distinguishes the rows.
              href={`/edit/center/${encodeURIComponent(unitCode)}/export`}
              className="text-foreground hover:bg-accent inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap"
              data-testid="center-roster-export-link"
            >
              <Download className="size-3.5" aria-hidden />
              Export .xlsx
            </a>
          )}
          <Button
            type="button"
            variant="apollo"
            size="sm"
            onClick={() => setAddOpen((v) => !v)}
            aria-expanded={addOpen}
            data-testid="center-roster-add-open"
          >
            <Plus className="size-3.5" aria-hidden />
            Add member
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {addOpen && (
        <div className="border-apollo-border flex flex-col gap-3 rounded-md border p-4" data-slot="center-roster-add">
          <p className="text-sm font-medium">Add member</p>
          {cornellDirectoryEnabled && (
            <div
              className="border-apollo-border flex w-fit overflow-hidden rounded-md border"
              role="group"
              aria-label="Directory source"
            >
              {(
                [
                  ["wcm", "WCM"],
                  ["cornell", "Cornell"],
                ] as ReadonlyArray<readonly ["wcm" | "cornell", string]>
              ).map(([value, label], i) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setAddSource(value);
                    setAddValue(null);
                  }}
                  aria-pressed={addSource === value}
                  className={`px-3 py-1 text-sm font-medium transition-colors ${i > 0 ? "border-apollo-border border-l" : ""} ${
                    addSource === value
                      ? "bg-apollo-maroon text-white"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                  data-testid={`center-roster-add-source-${value}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <DirectoryPeopleTypeahead
            idPrefix="roster"
            value={addValue}
            onChange={setAddValue}
            source={cornellDirectoryEnabled ? addSource : "wcm"}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAddOpen(false);
                setAddValue(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" variant="apollo" onClick={add} disabled={!addValue || adding} data-testid="center-roster-add">
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
        )}

        {/* Status tabs — ONE mutually-exclusive choice (see the docblock),
            each labelled with its count. Scrolls sideways inside itself on a
            phone rather than widening the page. */}
        <div
          className="border-apollo-border flex gap-4 overflow-x-auto border-b sm:gap-6"
          role="tablist"
          aria-label="Filter members"
        >
          {(
            [
              ["all", "All members"],
              ["invited", "Invited"],
              ["inactive", "Inactive"],
              ["departed", "Left WCM"],
            ] as ReadonlyArray<readonly [RosterFilter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              ref={(el) => {
                tabRefs.current[value] = el;
              }}
              onClick={() => setFilter(value)}
              aria-selected={filter === value}
              className={`-mb-px shrink-0 border-b-2 pt-2 pb-2.5 text-sm whitespace-nowrap sm:text-[15px] tabular-nums transition-colors ${
                filter === value
                  ? "border-apollo-maroon text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground border-transparent"
              }`}
              data-testid={`roster-filter-${value}`}
            >
              {label}{" "}
              <span className="bg-apollo-surface-2 text-muted-foreground ml-1 rounded-full px-1.5 py-px text-xs font-medium">
                {statusCounts[value]}
              </span>
            </button>
          ))}
        </div>

        {/* Filter bar — search always; Program only for a center with a
            program taxonomy; the disease controls only when this center has
            assignment data. AND-composed with each other and with the tabs. */}
        <div className="flex flex-wrap items-center gap-2.5" data-testid="center-roster-filter-bar">
          <div className="relative w-full sm:w-64">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
              aria-hidden
            />
            <Input
              id="roster-search-input"
              type="text"
              aria-label="Search name or CWID"
              placeholder="Name or CWID"
              className="h-[34px] pl-8"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              data-testid="roster-search-input"
            />
          </div>

          {hasDiseases && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[34px] gap-1.5 font-normal"
                  data-testid="roster-disease-filter-trigger"
                >
                  <span>
                    {selectedDiseaseCodes.size === 0
                      ? "Any disease"
                      : `${fmt(selectedDiseaseCodes.size)} ${selectedDiseaseCodes.size === 1 ? "disease" : "diseases"}`}
                  </span>
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2" data-testid="roster-disease-filter-menu">
                <Input
                  type="text"
                  placeholder="Filter diseases…"
                  aria-label="Filter diseases"
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
                        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{opt.count.toLocaleString("en-US")}</span>
                      </label>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {hasPrograms && (
            <select
              aria-label="Program"
              className="border-apollo-border-strong bg-apollo-surface h-[34px] max-w-full rounded-md border px-2 text-sm"
              value={programFilter}
              onChange={(e) => setProgramFilter(e.target.value)}
              data-testid="roster-program-filter"
            >
              <option value="">Any program</option>
              {programs.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          )}

          {hasDiseases && (
            <>
              <select
                id="roster-confidence-filter"
                aria-label="Confidence"
                className="border-apollo-border-strong bg-apollo-surface h-[34px] rounded-md border px-2 text-sm"
                value={confidenceFilter}
                onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
                data-testid="roster-confidence-filter"
              >
                <option value="any">Any confidence</option>
                <option value="high">High confidence</option>
                <option value="medium">Medium confidence</option>
                <option value="low">Low confidence</option>
              </select>

              <button
                type="button"
                onClick={toggleNeedsReviewOnly}
                aria-pressed={needsReviewOnly}
                className={`inline-flex h-[34px] items-center gap-2 rounded-md border px-3 text-sm whitespace-nowrap transition-colors ${
                  needsReviewOnly
                    ? "border-apollo-amber bg-apollo-amber-tint text-apollo-amber font-medium"
                    : "border-apollo-border-strong bg-apollo-surface hover:bg-accent"
                }`}
                data-testid="roster-needs-review-toggle"
              >
                Needs review
                <span className="text-muted-foreground text-xs tabular-nums" data-testid="roster-needs-review-count">
                  {needsReviewList.length.toLocaleString("en-US")}
                </span>
              </button>
            </>
          )}

        </div>

        {filtersActive && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground" data-testid="roster-filter-result-line">
              {visible.length.toLocaleString("en-US")} of {rosterFiltered.length.toLocaleString("en-US")} members match
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

        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="center-roster-empty">
            This roster is empty. Add the first member to populate this center.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="[&_td]:align-middle w-full min-w-[720px] text-sm" data-testid="center-roster-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left text-xs">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Role</th>
                {hasPrograms && <th className="px-3 py-2 font-medium">Program &amp; dates</th>}
                {hasDiseases && <th className="px-3 py-2 font-medium">Diseases</th>}
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="text-muted-foreground px-3 py-3">
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
                pageMembers.map((m) => {
                  const status = statusOf(m, now);
                  // The case this card exists to surface (see the type docblock):
                  // the person left WCM but nobody closed out their membership, so
                  // it still reads Active. Amber is this UI's "needs attention"
                  // (honors-queue contested groups, all-units-directory), not red —
                  // it is a data-quality gap to fix, not a failure. Mutually
                  // exclusive with the inactive row's page-colour background
                  // by construction, so the two never compose.
                  const rowNeedsCloseOut = needsCloseOutOf(m);
                  // Remove lives in the dates popover — a rare action that
                  // doesn't need permanent screen real estate.
                  const dateAndRemove = (
                    <div className="mt-1 flex items-center gap-1.5">
                      <MemberDateRange
                        member={m}
                        onStartChange={(v) => onStartChange(m, v)}
                        onEndChange={(v) => onEndChange(m, v)}
                        needsCloseOut={rowNeedsCloseOut}
                        onRemove={() => setRemoveTarget(m)}
                      />
                    </div>
                  );
                  return (
                    <tr
                      key={m.cwid}
                      className={`border-apollo-border border-b ${
                        status === "inactive" ? "bg-apollo-page" : ""
                      } ${rowNeedsCloseOut ? "bg-apollo-amber-tint" : ""}`}
                      data-testid={`center-roster-row-${m.cwid}`}
                      data-needs-close-out={rowNeedsCloseOut ? "true" : undefined}
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* No hover card for an external (netid, no WCM
                              profile) or unresolvable cwid: there is no
                              scholar card to show, and a netid could collide
                              with an unrelated WCM cwid. */}
                          {m.scholarState === "external" || m.scholarState === "unknown" ? (
                            <span className="font-semibold">{m.name}</span>
                          ) : (
                            <ScholarHoverCard cwid={m.cwid}>
                              <span className="font-semibold" data-testid={`roster-name-${m.cwid}`}>
                                {m.name}
                              </span>
                            </ScholarHoverCard>
                          )}
                          {m.publiclyListed === false &&
                            m.scholarState !== "departed" &&
                            m.scholarState !== "unknown" &&
                            m.scholarState !== "external" && (
                              <Badge
                                variant="outline"
                                className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                                data-testid={`roster-not-public-${m.cwid}`}
                                title="On the roster, but this person won't appear on the public center page until they have an active, public Scholars profile."
                              >
                                Not shown publicly
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
                          {m.scholarState === "external" && (
                            <Badge
                              variant="outline"
                              className="border-apollo-border rounded-full"
                              data-testid={`roster-scholar-state-${m.cwid}`}
                              title={
                                m.source === CTSC_EXTERNAL_SOURCE
                                  ? "From the CTSC feed — no SPS profile. Changes here are overwritten by the nightly sync."
                                  : "Cornell University (Ithaca) directory member — no WCM profile"
                              }
                            >
                              {externalSourceLabel(m.source ?? "")}
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground flex min-w-0 gap-1.5 text-xs">
                          {m.title && (
                            <>
                              <span className="max-w-[22rem] truncate" title={m.title}>
                                {m.title}
                              </span>
                              <span aria-hidden>·</span>
                            </>
                          )}
                          <span className="font-mono" data-testid={`roster-cwid-${m.cwid}`}>
                            {m.cwid}
                          </span>
                        </div>
                        {/* No Program column on this center — the date range
                            folds under Member instead, so it's never dropped. */}
                        {!hasPrograms && dateAndRemove}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                          value={m.membershipRoleKey ?? MEMBER_ROLE_KEY}
                          onChange={(e) => {
                            const roleKey = e.target.value;
                            patch(
                              m.cwid,
                              { membershipRoleKey: roleKey, membershipType: deriveMembershipType(roleKey) },
                              { membershipRoleKey: roleKey },
                            );
                          }}
                          data-testid={`roster-type-${m.cwid}`}
                        >
                          {roleOptions.map((r) => (
                            <option key={r.key} value={r.key}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      {hasPrograms && (
                        <td className="px-3 py-2">
                          <select
                            className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                            value={m.programCode ?? ""}
                            onChange={(e) => patch(m.cwid, { programCode: e.target.value || null })}
                            data-testid={`roster-program-${m.cwid}`}
                          >
                            <option value="">Choose program…</option>
                            {programs.map((p) => (
                              <option key={p.code} value={p.code}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                          {dateAndRemove}
                        </td>
                      )}
                      {hasDiseases && (
                        <td className="px-3 py-2">
                          <DiseaseCell member={m} inactive={status === "inactive"} onOpen={openSheet} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        {m.scholarState === "departed" ? (
                          <Badge
                            variant="outline"
                            className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                            data-testid={`roster-scholar-state-${m.cwid}`}
                          >
                            Left WCM
                          </Badge>
                        ) : status === "active" ? (
                          // Active is the norm — plain text; only exceptions get a pill.
                          <span className="text-muted-foreground" data-testid={`roster-status-${m.cwid}`}>
                            Active
                          </span>
                        ) : (
                          <Badge
                            variant="outline"
                            className={`rounded-full ${
                              status === "invited"
                                ? "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border"
                                : status === "inactive"
                                  ? "bg-apollo-surface-2 text-foreground border-apollo-border-strong"
                                  : "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
                            }`}
                            data-testid={`roster-status-${m.cwid}`}
                          >
                            {status === "pending" ? "Pending" : status === "invited" ? "Invited" : "Inactive"}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        )}

        {visible.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground text-[13px]" data-testid="roster-range-label">
              {paging.rangeLabel} members
            </span>
            {paging.hasMore && (
              <button
                type="button"
                className="text-apollo-slate text-sm hover:underline"
                onClick={paging.showMore}
                data-testid="roster-show-more"
              >
                Load more
              </button>
            )}
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
            Change history
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

      {/* Not gated on `hasDiseases`: undoing the roster's last manual add
          would otherwise unmount the sheet mid-review. Only disease controls
          open it, so it is unreachable on a center without them. */}
      <CenterDiseaseReviewSheet
        member={
          sheetMember
            ? {
                cwid: sheetMember.cwid,
                name: sheetMember.name,
                title: sheetMember.title,
                programLabel: programLabelOf(sheetMember.programCode),
                diseases: sheetMember.diseases ?? [],
              }
            : null
        }
        onClose={closeSheet}
        diseaseOptions={diseaseOptions}
        onDecide={decideDisease}
        queue={queueState}
        error={error}
      />
    </EditPanel>
    </>
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
    case "feed_owned_membership":
      return "This member comes from the nightly CTSC feed, so removing them here would be undone overnight. Set an end date instead, or have CTSC update the record.";
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
