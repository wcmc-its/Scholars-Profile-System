/**
 * The Funding attribute panel (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Panel — Funding). A thin config wrapper over
 * the shared `EntityPanel`, with a title filter + bounded scroll (a productive
 * PI can have dozens of awards). Each entry is the scholar's role on one award;
 * hiding it removes only their row, not the award. A hide clears the profile
 * immediately but funding search only on the next nightly rebuild (#481).
 */
"use client";

import { Badge } from "@/components/ui/badge";
import { EntityPanel } from "@/components/edit/entity-panel";
import type { EditContextGrant } from "@/lib/api/edit-context";

export type FundingCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  grants: ReadonlyArray<EditContextGrant>;
};

export function FundingCard({ cwid, mode, scholarName, grants }: FundingCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  return (
    <EntityPanel
      slot="funding-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      entityType="grant"
      entities={grants}
      filterable
      getTitle={(g) => g.title}
      renderMeta={(g) => (
        <>
          {g.funderLabel}
          {" · "}
          {g.role}
          {" · "}
          {g.startYear}–{g.endYear}
          {" · "}
          <Badge variant={g.isActive ? "secondary" : "outline"}>{g.isActive ? "Active" : "Past"}</Badge>
        </>
      )}
      copy={{
        heading: "Funding",
        description: `Hide a grant to remove yourself from it on ${
          mode === "superuser" ? "this scholar's profile" : "this site"
        }. Each entry is your role on one award; hiding it doesn't affect the award's other investigators. It may take up to a day to clear from funding search.`,
        empty:
          mode === "superuser"
            ? "We don't have funding records for this scholar."
            : "We don't have funding records for you.",
        one: "grant",
        other: "grants",
        hideNote: "It may take up to a day to clear from funding search.",
        filterPlaceholder: "Filter by title…",
        filterAriaLabel: "Filter grants by title",
      }}
    />
  );
}
