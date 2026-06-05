/**
 * The Education attribute panel (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Panel — Education). A thin config wrapper over
 * the shared `EntityPanel`. Education has no search surface, so a hide clears
 * on the next profile render with no nightly-rebuild lag.
 */
"use client";

import { EntityPanel } from "@/components/edit/entity-panel";
import type { EditContextEducation } from "@/lib/api/edit-context";

export type EducationCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  educations: ReadonlyArray<EditContextEducation>;
};

export function EducationCard({ cwid, mode, scholarName, educations }: EducationCardProps) {
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
