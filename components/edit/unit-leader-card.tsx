/**
 * UnitLeaderCard — the unit leadership editor (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 2). Edits the three-state leader override:
 *
 *   - a curated person (a directory pick → `leaderCwid: "<cwid>"`),
 *   - an explicit vacancy (`leaderCwid: ""` — the public page shows no leader),
 *   - or no override (clear → falls back to ETL detection, e.g. the chair regex).
 *
 * Plus an interim toggle (`leaderInterim`). Save diffs the dirty fields and
 * issues one `/api/edit/field` POST per changed field (the backend writes one
 * row per call). "Clear override" drops both override rows so detection resumes.
 *
 * PR-7a wires the department route; a center's director is edited in-row via
 * `/api/edit/unit` (wired in PR-7b) — `canClear` is already false for a center.
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

type LeaderMode = "curated" | "vacant" | "detect";

const LEADER_NOUN: Record<UnitLeaderCardProps["entityType"], string> = {
  department: "chair",
  division: "chief",
  center: "director",
};

export type UnitLeaderCardProps = {
  entityType: "department" | "division" | "center";
  entityId: string;
  leader: {
    cwid: string | null;
    explicitVacancy: boolean;
    interim: boolean;
    name: string | null;
    title: string | null;
  };
  canClear: boolean;
  hasOverride: boolean;
};

function initialMode(leader: UnitLeaderCardProps["leader"]): LeaderMode {
  if (leader.cwid !== null) return "curated";
  if (leader.explicitVacancy) return "vacant";
  return "detect";
}

export function UnitLeaderCard({
  entityType,
  entityId,
  leader,
  canClear,
  hasOverride,
}: UnitLeaderCardProps) {
  const noun = LEADER_NOUN[entityType];

  const [selected, setSelected] = React.useState<DirectoryValue | null>(
    leader.cwid !== null ? { cwid: leader.cwid, name: leader.name ?? leader.cwid, title: leader.title } : null,
  );
  const [vacant, setVacant] = React.useState(leader.explicitVacancy);
  const [interim, setInterim] = React.useState(leader.interim);

  const [baseMode, setBaseMode] = React.useState<LeaderMode>(initialMode(leader));
  const [baseCwid, setBaseCwid] = React.useState<string | null>(leader.cwid);
  const [baseInterim, setBaseInterim] = React.useState(leader.interim);
  const [overrideExists, setOverrideExists] = React.useState(hasOverride);

  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const mode: LeaderMode = selected ? "curated" : vacant ? "vacant" : "detect";
  const cwidDirty = mode !== baseMode || (mode === "curated" && selected?.cwid !== baseCwid);
  const interimDirty = interim !== baseInterim;
  const dirty = cwidDirty || interimDirty;

  function reset(after: () => void) {
    if (justSaved) setJustSaved(false);
    if (error) setError(null);
    after();
  }

  async function postField(fieldName: string, op: "set" | "clear", value?: string): Promise<boolean> {
    const res = await fetch("/api/edit/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, entityType, entityId, fieldName, value }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      return false;
    }
    return true;
  }

  async function save() {
    if (!dirty || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      if (cwidDirty) {
        const ok =
          mode === "detect"
            ? await postField("leaderCwid", "clear")
            : await postField("leaderCwid", "set", mode === "curated" ? selected!.cwid : "");
        if (!ok) return;
      }
      if (interimDirty) {
        const ok = await postField("leaderInterim", "set", interim ? "true" : "false");
        if (!ok) return;
      }
      setBaseMode(mode);
      setBaseCwid(selected?.cwid ?? null);
      setBaseInterim(interim);
      setOverrideExists(mode !== "detect" || interim);
      setJustSaved(true);
    } finally {
      setIsSaving(false);
    }
  }

  async function clearOverride() {
    setError(null);
    const a = await postField("leaderCwid", "clear");
    if (!a) throw new Error("clear_failed");
    const b = await postField("leaderInterim", "clear");
    if (!b) throw new Error("clear_failed");
    setSelected(null);
    setVacant(false);
    setInterim(false);
    setBaseMode("detect");
    setBaseCwid(null);
    setBaseInterim(false);
    setOverrideExists(false);
    setConfirmOpen(false);
    setJustSaved(true);
  }

  return (
    <Card data-slot="unit-leader-card">
      <CardHeader>
        <CardTitle>Leadership</CardTitle>
        <CardDescription>
          Set the {noun} for this {entityType}, mark the role vacant, or clear the override to let
          the directory decide.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{capitalize(noun)}</label>
          <DirectoryPeopleTypeahead
            idPrefix="leader"
            value={selected}
            placeholder={`Search for a ${noun}…`}
            onChange={(v) => reset(() => {
              setSelected(v);
              if (v) setVacant(false);
            })}
          />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={() => reset(() => {
                setSelected(null);
                setVacant(true);
              })}
              data-testid="unit-leader-mark-vacant"
            >
              Mark vacant
            </Button>
            {mode === "vacant" && (
              <Badge variant="secondary" data-testid="unit-leader-vacant-pill">
                Vacant (explicit)
              </Badge>
            )}
            {mode === "detect" && (
              <span className="text-muted-foreground text-sm">No override — using directory detection.</span>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={interim}
            disabled={isSaving}
            onCheckedChange={(c) => reset(() => setInterim(c === true))}
            data-testid="unit-leader-interim"
          />
          Interim {noun}
        </label>

        <div className="flex items-center justify-end gap-3">
          {justSaved && (
            <span role="status" aria-live="polite" className="text-primary inline-flex items-center gap-1 text-sm">
              <Check className="size-4" />
              Saved
            </span>
          )}
          {canClear && overrideExists && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={isSaving}
              data-testid="unit-leader-clear"
            >
              Clear override
            </Button>
          )}
          <Button type="button" onClick={save} disabled={!dirty || isSaving} data-testid="unit-leader-save">
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear the leadership override?"
        description={`This removes the manual ${noun} and lets directory detection resume.`}
        reasonMode="none"
        confirmLabel="Clear override"
        confirmVariant="default"
        onConfirm={clearOverride}
      />
    </Card>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this unit. Refresh the page and try again.";
    case "invalid_value":
    case "invalid_cwid":
      return "That selection couldn't be saved. Please try a different person.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
