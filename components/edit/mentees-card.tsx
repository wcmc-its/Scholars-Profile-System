/**
 * The Mentees attribute panel (#160 follow-up). A thin config wrapper over the
 * shared `EntityPanel` — the same suppressible hide/show surface the Education /
 * Appointments / Funding panels use.
 *
 * Mentees are DERIVED (no FK; the reporting DB is truncate-rebuilt nightly from
 * MD/PhD/postdoc training records), so a mentor can only HIDE a mentee from
 * their own profile — there's no source to correct here. The suppression keys on
 * `externalId = "{mentorCwid}:{menteeCwid}"`, owner = the mentor; the panel's
 * public-profile filter (in `profile-view.tsx`) drops a hidden mentee on the
 * next render with no nightly-rebuild lag. Corrections route to ITS Support
 * (source: Jenzabar, Medical Education rosters, or Employee Central) via "Request a change".
 *
 * The one thing the mentor ADDS here is a mentee's "Current position" — where
 * they are now, which no training record carries. Every position for this
 * mentor lives in ONE `field_override` JSON object (`menteeCurrentPositions`,
 * keyed by mentee CWID) and each save POSTs the whole object to
 * `/api/edit/field`, the contract `manual-mentees-card.tsx` uses for its array
 * (and with the same last-write-wins exposure between two concurrent editors).
 */
"use client";

import * as React from "react";

import { EntityPanel } from "@/components/edit/entity-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EditContextMentee } from "@/lib/api/edit-context";
import { MAX_CURRENT_POSITION } from "@/lib/edit/manual-mentee";

export type MenteesCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  mentees: ReadonlyArray<EditContextMentee>;
  /** The stored `menteeCurrentPositions` map (mentee CWID → text). */
  currentPositions?: Readonly<Record<string, string>>;
  /** See `EntityPanel`'s `delegated`. */
  delegated?: boolean;
};

export function MenteesCard({
  cwid,
  mode,
  scholarName,
  mentees,
  currentPositions,
  delegated,
}: MenteesCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  const [positions, setPositions] = React.useState<Record<string, string>>({
    ...currentPositions,
  });

  /** Persist one mentee's position by writing the whole map; commit to local
   *  state only on success so a rejected write leaves the row showing what is
   *  actually stored. */
  async function savePosition(menteeCwid: string, text: string): Promise<boolean> {
    const next = { ...positions };
    if (text.trim()) next[menteeCwid] = text.trim();
    else delete next[menteeCwid];
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "menteeCurrentPositions",
          value: next,
        }),
      });
      const data = (await res.json()) as { ok: boolean };
      if (!res.ok || data.ok !== true) return false;
      // No `router.refresh()`: local state is authoritative here, as it is for
      // the panel's own hide/show.
      setPositions(next);
      return true;
    } catch {
      return false;
    }
  }

  return (
    <EntityPanel
      slot="mentees-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      delegated={delegated}
      entityType="mentee"
      entities={mentees}
      getTitle={(m) => m.name}
      renderMeta={(m) => m.subtitle ?? "Program unknown"}
      renderDetail={(m) => {
        // `externalId` is `{mentorCwid}:{menteeCwid}`.
        const menteeCwid = m.externalId.slice(cwid.length + 1);
        return (
          <CurrentPosition
            menteeName={m.name}
            value={positions[menteeCwid] ?? ""}
            onSave={(text) => savePosition(menteeCwid, text)}
            testId={`mentee-position-${m.externalId}`}
          />
        );
      }}
      copy={{
        // #2011 — named for its SOURCE now that the mentor's own entries sit in
        // a sibling "Added by you" card above. "Mentees" would read as the whole
        // roster and imply this panel's hide-only verb applies to all of it.
        heading: "From training records",
        description: `Hide a mentee to remove them from ${possessive} public profile. Hiding is display-only — it doesn't correct the underlying training record, which comes from Jenzabar, the Medical Education rosters, or Employee Central. You can add where a mentee is now; it appears under their name on the public profile.`,
        empty:
          mode === "superuser"
            ? "This scholar has no recorded mentees."
            : "You have no recorded mentees.",
        one: "mentee",
        other: "mentees",
        hideNote: "It clears from the profile right away.",
      }}
    />
  );
}

/** One row's "Current position": the stored text with an Edit button (or an Add
 *  button when unset), swapping to an input with Save / Cancel. */
function CurrentPosition({
  menteeName,
  value,
  onSave,
  testId,
}: {
  menteeName: string;
  value: string;
  onSave: (text: string) => Promise<boolean>;
  testId: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  if (!editing) {
    return (
      <div
        className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-sm"
        data-testid={testId}
      >
        {value ? <span>Now: {value}</span> : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={
            value
              ? `Edit current position for ${menteeName}`
              : `Add current position for ${menteeName}`
          }
          onClick={() => {
            setDraft(value);
            setFailed(false);
            setEditing(true);
          }}
          data-testid={`${testId}-edit`}
        >
          {value ? "Edit" : "Add current position"}
        </Button>
      </div>
    );
  }

  async function submit() {
    setBusy(true);
    setFailed(false);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) setEditing(false);
    else setFailed(true);
  }

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={testId}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Current position (optional)</span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Assistant Professor, University of X"
          maxLength={MAX_CURRENT_POSITION}
          disabled={busy}
          data-testid={`${testId}-input`}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          size="sm"
          disabled={busy}
          onClick={submit}
          data-testid={`${testId}-save`}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          We couldn&rsquo;t save that. Please try again.
        </p>
      ) : null}
    </div>
  );
}
