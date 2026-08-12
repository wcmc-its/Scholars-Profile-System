/**
 * CenterRosterCard — the rich center roster table (#552 §6.1; the deferred
 * #540 PR-7b-roster). Columns: Member | [Type | Program] | Start | End | Status
 * | Remove.
 *
 * Type + Program are surfaced **only when the center has a program taxonomy**
 * (`programs.length > 0`) — the data-driven "Cancer-Center-only" gate. Every
 * other center shows just Member / Start / End / Status. Start/End drive the
 * derived Active / Pending / Inactive status (the #552 §3.3 active filter,
 * inclusive boundaries, nulls open).
 *
 * ONE mutually-exclusive filter — All members (default) / Inactive members only
 * / Departed members only — so the roster opens on the whole thing and nothing
 * is ever silently hidden. Two independent "X only" checkboxes could not say
 * this honestly: both unchecked reads as no restriction, both checked as an
 * impossible intersection. (It was previously a restrictive, default-ON "show
 * active only" beside an additive "show departed", opposite polarities for the
 * same intent.)
 *
 * A row whose person has left WCM while the membership is still open is tinted
 * amber and its End field outlined, because that is the combination this card
 * exists to surface and the End date is what resolves it. The count of those
 * rows drives the nudge above the table — outstanding work, not hidden rows.
 *
 * Inline edits POST `/api/edit/roster` `action:"set"` one field at a time
 * (a field present as `null` clears it). Add → `action:"add"`, Remove →
 * `action:"remove"`. The list updates optimistically; a failed write reverts
 * and surfaces an error. A date edit that would make End < Start is blocked
 * client-side before the POST.
 *
 * The disease-assignment plan (`2026-08-12-cancer-center-disease-assignment-
 * edit-ui-plan.md` §5) explicitly rejects fitting a per-person RANKED LIST of
 * diseases into another inline `<select>` cell. Instead: a small "Diseases
 * (N)" link next to a member's name (absent when N is 0) opens a Dialog
 * (`MemberDiseasesDialog` below — the same per-item Dialog primitive
 * `MeshLogicModal` uses in `cancer-center-collab-report-card.tsx`, not a new
 * one) listing that member's ranked `CancerCenterDiseaseAssignment` rows
 * merged with any `CancerCenterDiseaseDecision`, each with Confirm / Reject /
 * (Clear, once decided) buttons POSTing to `/api/edit/center/[code]/
 * disease-assignments` — same optimistic-update-with-revert convention as
 * `patch()` below, serialized per (cwid, diseaseCode) pair.
 */
"use client";

import Link from "next/link";
import * as React from "react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { RosterDiseaseRow } from "@/lib/api/unit-edit-context";

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
   *  that predate this feature still type-check. */
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
};

type Status = "active" | "pending" | "inactive";

/** The three mutually-exclusive roster views. `all` is the default. */
type RosterFilter = "all" | "inactive" | "departed";

/** #552 §3.3 active filter, inclusive boundaries, nulls open. */
function statusOf(member: RosterMember, today: string): Status {
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
 * code added after this map was last synced.
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

/** "the evidence counts already on the row" (plan §5), formatted as one
 *  compact line rather than a second mini-table. */
function evidenceLine(a: NonNullable<RosterDiseaseRow["assignment"]>): string {
  const years = a.firstYear && a.lastYear ? ` (${a.firstYear}–${a.lastYear})` : "";
  return [
    `${a.leadPubs} lead · ${a.secondPubs} second · ${a.middlePubs} middle`,
    `${a.recentPubs} recent pub${a.recentPubs === 1 ? "" : "s"}${years}`,
    `${a.grantsLed} grant${a.grantsLed === 1 ? "" : "s"} led · ${a.grantsSupport} supported`,
    `${a.trialsLed} trial${a.trialsLed === 1 ? "" : "s"} led · ${a.trialsSupport} supported`,
  ].join("  —  ");
}

function DiseaseDecisionBadge({ decision }: { decision: string }) {
  if (decision === "confirmed") {
    return (
      <Badge
        variant="outline"
        className="bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border rounded-full"
      >
        Confirmed
      </Badge>
    );
  }
  if (decision === "rejected") {
    return (
      <Badge
        variant="outline"
        className="bg-apollo-red-tint text-apollo-maroon border-apollo-red-tint-border rounded-full"
      >
        Rejected
      </Badge>
    );
  }
  return null;
}

type DiseaseDecisionKind = "confirmed" | "rejected" | "clear";

/**
 * The per-member disease panel (plan §5) — Dialog + `DialogTrigger asChild`
 * wrapping a plain link, the same per-item modal shape `MeshLogicModal` in
 * `cancer-center-collab-report-card.tsx` uses. Uncontrolled (Radix owns its
 * own open state); `member.diseases` is read straight from the live `members`
 * state in the parent, so a decision made here re-renders in place.
 */
function MemberDiseasesDialog({
  member,
  onDecide,
}: {
  member: RosterMember;
  onDecide: (cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) => Promise<void>;
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
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-apollo-slate ml-2 text-xs hover:underline"
          data-testid={`roster-diseases-${member.cwid}`}
        >
          Diseases ({diseases.length})
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl" data-testid="member-diseases-dialog">
        <DialogHeader>
          <DialogTitle>{member.name} — Disease assignments</DialogTitle>
          <DialogDescription>
            Ranked by evidence. Confirming or rejecting records your call — a later reseed of the
            underlying evidence never silently erases it.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {diseases.map((d) => {
            const busy = busyCode === d.diseaseCode;
            return (
              <li
                key={d.diseaseCode}
                className="border-apollo-border rounded-md border p-3"
                data-testid={`disease-row-${member.cwid}-${d.diseaseCode}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{diseaseLabel(d.diseaseCode)}</span>
                  <span className="text-muted-foreground text-xs">{d.diseaseCode}</span>
                  {d.assignment ? (
                    <>
                      <Badge variant="outline" className="rounded-full">
                        Rank {d.assignment.rank}
                      </Badge>
                      <Badge variant="outline" className="rounded-full">
                        {FOCUS_LABEL[d.assignment.focus] ?? d.assignment.focus}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`rounded-full ${CONFIDENCE_BADGE_CLASS[d.assignment.confidence] ?? ""}`}
                      >
                        {d.assignment.confidence} confidence
                      </Badge>
                    </>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                    >
                      No longer suggested
                    </Badge>
                  )}
                  {d.decision && <DiseaseDecisionBadge decision={d.decision.decision} />}
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
                  <p className="text-muted-foreground mt-1 text-xs">{evidenceLine(d.assignment)}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !d.assignment || d.decision?.decision === "confirmed"}
                    onClick={() => act(d.diseaseCode, "confirmed")}
                    data-testid={`disease-confirm-${member.cwid}-${d.diseaseCode}`}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !d.assignment || d.decision?.decision === "rejected"}
                    onClick={() => act(d.diseaseCode, "rejected")}
                    data-testid={`disease-reject-${member.cwid}-${d.diseaseCode}`}
                  >
                    Reject
                  </Button>
                  {d.decision && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => act(d.diseaseCode, "clear")}
                      data-testid={`disease-clear-${member.cwid}-${d.diseaseCode}`}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function CenterRosterCard({
  unitCode,
  members: initial,
  programs,
  today,
  exportEnabled = false,
}: CenterRosterCardProps) {
  const now = today ?? todayIso();
  const hasPrograms = programs.length > 0;

  const [members, setMembers] = React.useState<RosterMember[]>(() => [...initial]);
  // One mutually-exclusive filter, defaulting to the WHOLE roster. Two
  // checkboxes could not express "only" honestly: two independent "X only"
  // boxes both unchecked means no restriction, and both checked means an
  // impossible intersection. A radio makes the three states the curator
  // actually wants explicit, and nothing is ever silently hidden.
  const [filter, setFilter] = React.useState<RosterFilter>("all");
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<RosterMember | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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

  function replaceDiseaseRow(
    cwid: string,
    diseaseCode: string,
    updater: (row: RosterDiseaseRow) => RosterDiseaseRow,
  ) {
    setMembers((ms) =>
      ms.map((m) => {
        if (m.cwid !== cwid || !m.diseases) return m;
        return {
          ...m,
          diseases: m.diseases.map((d) => (d.diseaseCode === diseaseCode ? updater(d) : d)),
        };
      }),
    );
  }

  /** Confirm / Reject / Clear one (cwid, diseaseCode) decision — optimistic
   *  with revert on failure, serialized per pair, mirroring `patch()` above.
   *  Unlike `patch()`, the route's success response carries the server's
   *  authoritative `scoreAtDecision`/`confidenceAtDecision` snapshot, so a
   *  successful confirm/reject reconciles onto that instead of trusting the
   *  client's guess (which assumed the row's CURRENT assignment hadn't
   *  changed since page load). */
  async function decideDisease(cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) {
    setError(null);
    const member = members.find((m) => m.cwid === cwid);
    const prevRow = member?.diseases?.find((d) => d.diseaseCode === diseaseCode);
    if (!prevRow) return;

    const optimistic: RosterDiseaseRow =
      decision === "clear"
        ? { ...prevRow, decision: null, drifted: false }
        : {
            ...prevRow,
            decision: {
              decision,
              decidedBy: prevRow.decision?.decidedBy ?? "",
              decidedAt: new Date(),
              scoreAtDecision: prevRow.assignment?.score ?? prevRow.decision?.scoreAtDecision ?? 0,
              confidenceAtDecision:
                prevRow.assignment?.confidence ?? prevRow.decision?.confidenceAtDecision ?? "low",
            },
            drifted: false,
          };
    replaceDiseaseRow(cwid, diseaseCode, () => optimistic);

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
          replaceDiseaseRow(cwid, diseaseCode, () => prevRow);
          return;
        }
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; scoreAtDecision?: number; confidenceAtDecision?: string }
          | null;
        if (!res.ok || data?.ok !== true) {
          setError(mapErrorToMessage(data?.error ?? ""));
          replaceDiseaseRow(cwid, diseaseCode, () => prevRow);
          return;
        }
        if (decision !== "clear" && data.scoreAtDecision !== undefined && data.confidenceAtDecision !== undefined) {
          const scoreAtDecision = data.scoreAtDecision;
          const confidenceAtDecision = data.confidenceAtDecision;
          replaceDiseaseRow(cwid, diseaseCode, (row) =>
            row.decision ? { ...row, decision: { ...row.decision, scoreAtDecision, confidenceAtDecision } } : row,
          );
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

  const visible =
    filter === "inactive"
      ? members.filter((m) => statusOf(m, now) === "inactive")
      : filter === "departed"
        ? members.filter((m) => m.scholarState === "departed")
        : members;
  // The nudge is about WORK OUTSTANDING, not about what the filter is hiding —
  // "all" hides nothing now. These are the people who left WCM while their
  // membership stayed open, which is the only state here needing a curator.
  const needsCloseOut = members.filter(needsCloseOutOf).length;
  const colCount = hasPrograms ? 6 : 4;

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
          <RadioGroup
            className="flex items-center gap-4"
            value={filter}
            onValueChange={(v) => setFilter(v as RosterFilter)}
            aria-label="Filter members"
          >
            {(
              [
                ["all", "All members"],
                ["inactive", "Inactive members only"],
                ["departed", "Departed members only"],
              ] as ReadonlyArray<readonly [RosterFilter, string]>
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={value} data-testid={`roster-filter-${value}`} />
                {label}
              </label>
            ))}
          </RadioGroup>
        </div>

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
          <table className="[&_td]:align-middle w-full min-w-[760px] text-sm" data-testid="center-roster-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">Member</th>
                {hasPrograms && <th className="px-3 py-2 font-medium">Type</th>}
                {hasPrograms && <th className="px-3 py-2 font-medium">Program</th>}
                <th className="px-3 py-2 font-medium">Start</th>
                <th className="px-3 py-2 font-medium">End</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={colCount + 1} className="text-muted-foreground px-3 py-3">
                    No members match this filter. Choose &ldquo;All members&rdquo; to see
                    the whole roster.
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
                  return (
                    <tr
                      key={m.cwid}
                      className={`border-apollo-border border-b ${
                        status === "inactive" ? "opacity-50" : ""
                      } ${rowNeedsCloseOut ? "bg-apollo-amber-tint" : ""}`}
                      data-testid={`center-roster-row-${m.cwid}`}
                      data-needs-close-out={rowNeedsCloseOut ? "true" : undefined}
                    >
                      <td className="px-3 py-2">
                        <span className="font-medium">{m.name}</span>
                        {m.title && <span className="text-muted-foreground"> · {m.title}</span>}
                        {m.scholarState === "departed" && (
                          <Badge
                            variant="outline"
                            className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border ml-2 rounded-full"
                            data-testid={`roster-scholar-state-${m.cwid}`}
                          >
                            Left WCM
                          </Badge>
                        )}
                        {m.scholarState === "unknown" && (
                          <Badge
                            variant="outline"
                            className="border-apollo-border ml-2 rounded-full"
                            data-testid={`roster-scholar-state-${m.cwid}`}
                            title="No directory record matches this CWID, so we can't show a name."
                          >
                            Not in directory
                          </Badge>
                        )}
                        {(m.diseases ?? []).length > 0 && (
                          <MemberDiseasesDialog member={m} onDecide={decideDisease} />
                        )}
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
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <Input
                          type="date"
                          className="h-8 w-36"
                          value={m.startDate ?? ""}
                          onChange={(e) => onStartChange(m, e.target.value)}
                          data-testid={`roster-start-${m.cwid}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="date"
                          className={`h-8 w-36 ${
                            rowNeedsCloseOut ? "border-apollo-amber focus-visible:ring-apollo-amber" : ""
                          }`}
                          value={m.endDate ?? ""}
                          onChange={(e) => onEndChange(m, e.target.value)}
                          data-testid={`roster-end-${m.cwid}`}
                          aria-describedby={rowNeedsCloseOut ? `roster-end-hint-${m.cwid}` : undefined}
                        />
                        {rowNeedsCloseOut && (
                          <span id={`roster-end-hint-${m.cwid}`} className="sr-only">
                            This person has left WCM. Set an end date to close out their
                            membership.
                          </span>
                        )}
                      </td>
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
                  );
                })
              )}
            </tbody>
          </table>
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
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
