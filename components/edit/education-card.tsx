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
import { Switch } from "@/components/ui/switch";
import type { EditContextEducation } from "@/lib/api/edit-context";

export type EducationCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  educations: ReadonlyArray<EditContextEducation>;
  /** #1997 — whether `field_override(scholar, hideEducationYears)` is set. */
  hideYears: boolean;
};

export function EducationCard({
  cwid,
  mode,
  scholarName,
  educations,
  hideYears,
}: EducationCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  return (
    <EntityPanel
      slot="education-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      entityType="education"
      entities={educations}
      getTitle={(e) => (e.field ? `${e.degree}, ${e.field}` : e.degree)}
      renderMeta={(e) => (
        <>
          {e.institution}
          {" · "}
          {e.year ?? "Year unknown"}
        </>
      )}
      // Nothing to hide the years OF when there are no entries on file.
      aboveList={
        educations.length > 0 ? (
          <YearsSwitch cwid={cwid} hideYears={hideYears} possessive={possessive} />
        ) : null
      }
      copy={{
        heading: "Education",
        description: `Hide an education or training entry to remove it from ${possessive} public profile. Hiding is display-only — it doesn't correct the record, which stays in WCM systems and on internal reports.`,
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
