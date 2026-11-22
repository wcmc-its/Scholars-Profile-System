/**
 * The Education attribute panel (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Panel — Education). A thin config wrapper over
 * the shared `EntityPanel`. Education has no search surface, so a hide clears
 * on the next profile render with no nightly-rebuild lag.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EntityPanel } from "@/components/edit/entity-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { EditContextEducation, EditContextTraining } from "@/lib/api/edit-context";
import { TRAINING_TYPES } from "@/lib/edit/training";
import { trainingYearRange } from "@/lib/training-years";
import { cn } from "@/lib/utils";

/** One panel row: a degree, or a postgraduate training entry (ASMS or
 *  scholar-entered). Both hide through the `education` suppression. */
type Row =
  | (EditContextEducation & { kind: "degree" })
  | (EditContextTraining & { kind: "training" });

export type EducationCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  educations: ReadonlyArray<EditContextEducation>;
  trainings: ReadonlyArray<EditContextTraining>;
  /** See `EntityPanel`'s `delegated`. */
  delegated?: boolean;
  /** #1997 — whether `field_override(scholar, hideEducationYears)` is set. */
  hideYears: boolean;
};

export function EducationCard({
  cwid,
  mode,
  scholarName,
  educations,
  trainings,
  hideYears,
  delegated,
}: EducationCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  const rows: Row[] = [
    ...educations.map((e) => ({ ...e, kind: "degree" as const })),
    ...trainings.map((t) => ({ ...t, kind: "training" as const })),
  ];
  return (
    <EntityPanel
      slot="education-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      delegated={delegated}
      entityType="education"
      entities={rows}
      extendable
      getTitle={(e) =>
        e.kind === "degree"
          ? e.field
            ? `${e.degree}, ${e.field}`
            : e.degree
          : e.specialty
            ? `${e.type}, ${e.specialty}`
            : e.type
      }
      renderMeta={(e) => (
        <>
          {e.institution}
          {" · "}
          {e.kind === "degree"
            ? (e.year ?? "Year unknown")
            : trainingYearRange(e.yearFrom, e.yearTo) || "Years unknown"}
        </>
      )}
      renderDetail={(e) =>
        e.kind === "training" && e.source !== "ASMS" ? <RemoveTraining row={e} /> : null
      }
      aboveList={
        <div className="flex flex-col gap-4">
          {/* Nothing to hide the years OF when there are no entries on file. */}
          {rows.length > 0 ? (
            <YearsSwitch cwid={cwid} hideYears={hideYears} possessive={possessive} />
          ) : null}
          <AddTraining cwid={cwid} />
        </div>
      }
      copy={{
        heading: "Education",
        description: `Hide an education or training entry to remove it from ${possessive} public profile. Hiding is display-only — it doesn't correct the record, which stays in WCM systems and on internal reports. Postgraduate training that's missing can be added below.`,
        empty:
          mode === "superuser"
            ? "This scholar has no education or training entries on file."
            : "You have no education or training entries on file.",
        one: "entry",
        other: "entries",
      }}
    />
  );
}

/**
 * #1997 — one switch over the whole panel: `field_override(scholar,
 * hideEducationYears)`, written with the same POST /api/edit/field shape the
 * Visibility card's Sections panel uses. The entries stay; only each entry's
 * graduation year is dropped (from the profile payload, so the CV export and
 * every other payload consumer follow). Turning the years OFF hides nothing the
 * reader can miss — the entry itself remains — so unlike a section hide it
 * applies straight away with no confirm dialog.
 */
function YearsSwitch({
  cwid,
  hideYears,
  possessive,
}: {
  cwid: string;
  hideYears: boolean;
  possessive: string;
}) {
  const router = useRouter();
  const [hidden, setHidden] = React.useState(hideYears);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function write(hide: boolean) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "hideEducationYears",
          value: hide ? "true" : "false",
        }),
      });
      const data = (await res.json()) as { ok?: boolean };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't update the graduation years. Please try again.");
        return;
      }
      setHidden(hide);
      router.refresh();
    } catch {
      setError("We couldn't update the graduation years. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            Show graduation years on {possessive} public profile
          </div>
          <div className="text-muted-foreground text-xs">
            {hidden
              ? "Hidden — the entries below still show, without their years."
              : "Visible on each entry below."}
          </div>
        </div>
        <Switch
          checked={!hidden}
          disabled={pending}
          onCheckedChange={(checked) => void write(!checked)}
          aria-label={`Show graduation years on ${possessive} public profile`}
          data-testid="education-years-toggle"
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** POST to /api/edit/training; resolves to an error message, or null on success. */
async function postTraining(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch("/api/edit/training", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean };
    return res.ok && data.ok === true ? null : "We couldn't save that change. Please try again.";
  } catch {
    return "We couldn't save that change. Please try again.";
  }
}

/** "Added in Scholars" + Remove, under a scholar-entered training row. ASMS
 *  rows have no Remove: they return nightly, so they are hidden instead. */
function RemoveTraining({ row }: { row: EditContextTraining }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Added in Scholars</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const err = await postTraining({ action: "delete", externalId: row.externalId });
          setBusy(false);
          setError(err);
          if (!err) router.refresh();
        }}
        data-testid={`training-remove-${row.externalId}`}
      >
        {busy ? "Removing…" : "Remove"}
      </Button>
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  );
}

const EMPTY_DRAFT = { type: "", institution: "", specialty: "", yearFrom: "", yearTo: "" };

/** "Add training" button that opens an inline form (type, institution,
 *  specialty, years), posting a scholar-entered row. */
function AddTraining({ cwid }: { cwid: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof EMPTY_DRAFT, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="apollo"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="training-add"
        >
          Add training
        </Button>
      </div>
    );
  }

  const from = draft.yearFrom ? Number(draft.yearFrom) : null;
  const to = draft.yearTo ? Number(draft.yearTo) : null;
  const rangeOk = from === null || to === null || to >= from;
  const canSubmit = draft.type !== "" && draft.institution.trim() !== "" && rangeOk && !busy;

  async function submit() {
    setBusy(true);
    const err = await postTraining({
      action: "create",
      cwid,
      type: draft.type,
      institution: draft.institution,
      specialty: draft.specialty || null,
      yearFrom: from,
      yearTo: to,
    });
    setBusy(false);
    setError(err);
    if (!err) {
      setDraft(EMPTY_DRAFT);
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <div
      className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
      data-testid="training-form"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Type</span>
        <select
          value={draft.type}
          onChange={(e) => set("type", e.target.value)}
          className={cn(
            "border-input bg-background h-9 rounded-md border px-3 text-sm",
            "focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
          )}
          data-testid="training-type"
        >
          <option value="">Select a type</option>
          {TRAINING_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Institution</span>
        <Input
          value={draft.institution}
          onChange={(e) => set("institution", e.target.value)}
          placeholder="e.g. Massachusetts General Hospital"
          data-testid="training-institution"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Specialty <span className="text-muted-foreground font-normal">(optional)</span>
        </span>
        <Input
          value={draft.specialty}
          onChange={(e) => set("specialty", e.target.value)}
          placeholder="e.g. Infectious Diseases"
          data-testid="training-specialty"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">
            Start year <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Input
            inputMode="numeric"
            value={draft.yearFrom}
            onChange={(e) => set("yearFrom", e.target.value.replace(/\D/g, "").slice(0, 4))}
            data-testid="training-year-from"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">
            End year <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Input
            inputMode="numeric"
            value={draft.yearTo}
            onChange={(e) => set("yearTo", e.target.value.replace(/\D/g, "").slice(0, 4))}
            data-testid="training-year-to"
          />
        </label>
      </div>
      {!rangeOk ? (
        <p className="text-destructive text-xs">The end year can&rsquo;t be before the start year.</p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          disabled={!canSubmit}
          onClick={() => void submit()}
          data-testid="training-submit"
        >
          {busy ? "Saving…" : "Add training"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setDraft(EMPTY_DRAFT);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
