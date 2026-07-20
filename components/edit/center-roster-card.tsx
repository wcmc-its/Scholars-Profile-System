/**
 * CenterRosterCard — the rich center roster table (#552 §6.1; the deferred
 * #540 PR-7b-roster). Columns: Member | [Type | Program] | Start | End | Status
 * | Remove.
 *
 * Type + Program are surfaced **only when the center has a program taxonomy**
 * (`programs.length > 0`) — the data-driven "Cancer-Center-only" gate. Every
 * other center shows just Member / Start / End / Status. Start/End drive the
 * derived Active / Pending / Inactive status (the #552 §3.3 active filter,
 * inclusive boundaries, nulls open), and the "show active only" toggle (default
 * ON) hides Pending + Inactive — the dropped/lapsed-member visibility.
 *
 * Inline edits POST `/api/edit/roster` `action:"set"` one field at a time
 * (a field present as `null` clears it). Add → `action:"add"`, Remove →
 * `action:"remove"`. The list updates optimistically; a failed write reverts
 * and surfaces an error. A date edit that would make End < Start is blocked
 * client-side before the POST.
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export type RosterMember = {
  cwid: string;
  name: string;
  title: string | null;
  membershipType: "research" | "clinical" | null;
  programCode: string | null;
  startDate: string | null;
  endDate: string | null;
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

/** #552 §3.3 active filter, inclusive boundaries, nulls open. */
function statusOf(member: RosterMember, today: string): Status {
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  const [showActiveOnly, setShowActiveOnly] = React.useState(true);
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<RosterMember | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/edit/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitType: "center", unitCode, ...body }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
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

  const visible = showActiveOnly
    ? members.filter((m) => statusOf(m, now) === "active")
    : members;
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
              href={`/edit/center/${encodeURIComponent(unitCode)}/export${showActiveOnly ? "?activeOnly=1" : ""}`}
              className="text-apollo-slate text-sm hover:underline"
              data-testid="center-roster-export-link"
            >
              Export CSV
            </a>
          ) : (
            <span />
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={showActiveOnly}
              onCheckedChange={(c) => setShowActiveOnly(c === true)}
              data-testid="roster-show-active-only"
            />
            Show active only
          </label>
        </div>

        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="center-roster-empty">
            This roster is empty. Add the first member to populate this center.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm" data-testid="center-roster-table">
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
                    No active members. Turn off &ldquo;Show active only&rdquo; to see pending and
                    inactive members.
                  </td>
                </tr>
              ) : (
                visible.map((m) => {
                  const status = statusOf(m, now);
                  return (
                    <tr
                      key={m.cwid}
                      className={`border-apollo-border border-b ${status === "inactive" ? "opacity-50" : ""}`}
                      data-testid={`center-roster-row-${m.cwid}`}
                    >
                      <td className="px-3 py-2">
                        <span className="font-medium">{m.name}</span>
                        {m.title && <span className="text-muted-foreground"> · {m.title}</span>}
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
                          className="h-8 w-36"
                          value={m.endDate ?? ""}
                          onChange={(e) => onEndChange(m, e.target.value)}
                          data-testid={`roster-end-${m.cwid}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
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
        description="They will no longer be listed as a member. You can add them back at any time."
        reasonMode="none"
        confirmLabel="Remove"
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
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
