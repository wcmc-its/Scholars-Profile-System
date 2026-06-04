/**
 * The Conflicts of Interest attribute panel (#160 follow-up) — a read-only
 * mirror of the public profile's "External relationships" section.
 *
 * COI disclosures are the scholar's system-of-record data in the Weill Research
 * Gateway (WRG); Scholars only displays them. So this panel is NOT suppressible
 * — there is no Hide control and no write path. It renders the disclosures
 * grouped by `activityGroup` in the SAME order as the profile (shared
 * `groupCoiDisclosures`), with the standard "This section is not editable"
 * treatment and a "Request a change" path that is a self-service link back to
 * WRG (see `request-a-change.ts` § `coi`).
 */
"use client";

import { DisclosureGroupInfoTooltip } from "@/components/scholar/disclosure-group-info-tooltip";
import { EditPanel } from "@/components/edit/edit-panel";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { groupCoiDisclosures } from "@/lib/coi-groups";
import type { EditContextCoiDisclosure } from "@/lib/api/edit-context";

export type CoiCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  disclosures: ReadonlyArray<EditContextCoiDisclosure>;
};

export function CoiCard({ cwid, mode, scholarName, disclosures }: CoiCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  const groups = groupCoiDisclosures(disclosures);

  return (
    <EditPanel
      slot="coi-panel"
      attribute="coi"
      heading="Conflicts of Interest"
      description={`External relationships and financial interests ${possessive === "your" ? "you" : scholarName} disclosed in the Weill Research Gateway. These are shown on the public profile and aren't editable here.`}
    >
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="coi-empty">
          {mode === "superuser"
            ? "This scholar has no conflict-of-interest disclosures on file."
            : "You have no conflict-of-interest disclosures on file."}
        </p>
      ) : (
        <div className="border-border flex flex-col gap-5 rounded-md border px-4 py-4" data-slot="coi-panel-list">
          {groups.map(({ group, entities }) => (
            <div key={group} data-testid={`coi-group-${group}`}>
              <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
                {group}
                <DisclosureGroupInfoTooltip group={group} />
              </h3>
              <p className="text-foreground text-base leading-snug">{entities.join("; ")}</p>
            </div>
          ))}
        </div>
      )}

      <div className="border-border flex flex-col items-start gap-2 border-t pt-3">
        <p className="text-sm font-medium">This section is not editable.</p>
        <p className="text-muted-foreground text-sm">
          Disclosures are managed in the Weill Research Gateway. Use Request a Change to correct one at
          its source.
        </p>
        <RequestAChangeDialog attribute="coi" cwid={cwid} triggerTestId="request-a-change-toggle" />
      </div>
    </EditPanel>
  );
}
