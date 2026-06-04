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
 * (source: Jenzabar or Employee Central) via "Request a change".
 */
"use client";

import { EntityPanel } from "@/components/edit/entity-panel";
import type { EditContextMentee } from "@/lib/api/edit-context";

export type MenteesCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  mentees: ReadonlyArray<EditContextMentee>;
};

export function MenteesCard({ cwid, mode, scholarName, mentees }: MenteesCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  return (
    <EntityPanel
      slot="mentees-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      entityType="mentee"
      entities={mentees}
      getTitle={(m) => m.name}
      renderMeta={(m) => m.subtitle ?? "Program unknown"}
      copy={{
        heading: "Mentees",
        description: `Hide a mentee to remove them from ${possessive} public profile. Hiding is display-only — it doesn't correct the underlying training record, which comes from Jenzabar or Employee Central.`,
        empty:
          mode === "superuser"
            ? "This scholar has no recorded mentees."
            : "You have no recorded mentees.",
        one: "mentee",
        other: "mentees",
        hideNote: "It clears from your profile right away.",
      }}
    />
  );
}
