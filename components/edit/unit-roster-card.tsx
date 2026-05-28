/**
 * UnitRosterCard — the simple add/remove member list (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 3). Used for a **manual division** (and,
 * pre-#552, would have served centers — centers now get the richer
 * Member/Type/Program table deferred to PR-7b-roster, so this card is wired only
 * for `unitType === 'division'` with `Division.source === 'manual'`).
 *
 * A list of current members (name · title) each with a Remove confirm, plus an
 * LDAP-backed Add typeahead. Add/Remove POST `/api/edit/roster`
 * (`{ unitType, unitCode, cwid, action }`); the list updates optimistically and
 * reverts on failure. No bulk operations (deferred). The roster is independent
 * of leadership (edge 17) — nothing here implies the leader is a promoted member.
 */
"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Member = { cwid: string; name: string; title: string | null };

export type UnitRosterCardProps = {
  /** The API request's `unitType`. */
  entityType: "division" | "center";
  /** The API request's `unitCode`. */
  unitCode: string;
  members: ReadonlyArray<Member>;
};

export function UnitRosterCard({ entityType, unitCode, members: initial }: UnitRosterCardProps) {
  const [members, setMembers] = React.useState<Member[]>(() => [...initial]);
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<Member | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function postRoster(cwid: string, action: "add" | "remove"): Promise<boolean> {
    const res = await fetch("/api/edit/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitType: entityType, unitCode, cwid, action }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      return false;
    }
    return true;
  }

  async function add() {
    if (!addValue || adding) return;
    const picked = addValue;
    if (members.some((m) => m.cwid === picked.cwid)) {
      // Already listed — clear the picker, nothing to do.
      setAddValue(null);
      return;
    }
    setError(null);
    setAdding(true);
    const member: Member = { cwid: picked.cwid, name: picked.name, title: picked.title };
    // Optimistic insert; revert on failure.
    setMembers((prev) => [...prev, member]);
    setAddValue(null);
    const ok = await postRoster(picked.cwid, "add");
    if (!ok) {
      setMembers((prev) => prev.filter((m) => m.cwid !== picked.cwid));
    }
    setAdding(false);
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setError(null);
    const ok = await postRoster(removeTarget.cwid, "remove");
    if (!ok) throw new Error("remove_failed"); // keeps the dialog open
    setMembers((prev) => prev.filter((m) => m.cwid !== removeTarget.cwid));
    setRemoveTarget(null);
  }

  const noun = entityType;

  return (
    <Card data-slot="unit-roster-card">
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          The people listed on this {noun}. Listing a member does not grant them edit access.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="unit-roster-empty">
            This roster is empty. Add the first member to populate this {noun}.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="unit-roster-list">
            {members.map((m) => (
              <li
                key={m.cwid}
                className="flex items-center justify-between py-2"
                data-testid={`unit-roster-row-${m.cwid}`}
              >
                <span className="text-sm">
                  <span className="font-medium">{m.name}</span>
                  {m.title && <span className="text-muted-foreground"> · {m.title}</span>}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoveTarget(m)}
                  data-testid={`unit-roster-remove-${m.cwid}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-border flex flex-col gap-3 rounded-md border p-4" data-slot="unit-roster-add">
          <p className="text-sm font-medium">Add member</p>
          <DirectoryPeopleTypeahead idPrefix="roster" value={addValue} onChange={setAddValue} />
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={add}
              disabled={!addValue || adding}
              data-testid="unit-roster-add"
            >
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove ${removeTarget.name} from this ${noun}?` : ""}
        description="They will no longer be listed as a member. You can add them back at any time."
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={confirmRemove}
      />
    </Card>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this unit. Refresh the page and try again.";
    case "no_manual_roster":
      return "This division's roster comes from the directory and can't be edited here.";
    case "invalid_cwid":
      return "That selection couldn't be saved. Please try a different person.";
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
