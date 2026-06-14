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

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { DisclosureGroupInfoTooltip } from "@/components/scholar/disclosure-group-info-tooltip";
import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Button } from "@/components/ui/button";
import { groupCoiDisclosures } from "@/lib/coi-groups";
import type { EditContextCoiDisclosure } from "@/lib/api/edit-context";

export type CoiCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  disclosures: ReadonlyArray<EditContextCoiDisclosure>;
  /**
   * Count of publication-derived suggestions on the nested "From your
   * publications" sub-view. When > 0, an amber bridge invites the viewer over
   * so the suggestions are discoverable from the COI page (otherwise a scholar
   * with no disclosures lands on a dead "nothing on file" and never finds them).
   * Populated for a self viewer OR a superuser (#836); a comms_steward is
   * excluded at the loader, so it is 0 for them. The bridge copy reframes by
   * `mode` (first-person for self, the scholar's name for a superuser).
   */
  suggestionCount?: number;
  /** Href of the nested suggestions sub-view — the ACTIVE surface for `mode`. */
  suggestionsHref?: string;
};

export function CoiCard({
  cwid,
  mode,
  scholarName,
  disclosures,
  suggestionCount = 0,
  suggestionsHref,
}: CoiCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  const groups = groupCoiDisclosures(disclosures);
  const showBridge = suggestionCount > 0 && Boolean(suggestionsHref);

  return (
    <EditPanel
      slot="coi-panel"
      attribute="coi"
      heading="Conflicts of Interest"
      description={`External relationships and financial interests ${possessive === "your" ? "you" : scholarName} disclosed in the Weill Research Gateway. These are shown on the public profile and aren't editable here.`}
    >
      <LockedBadge />

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="coi-empty">
          {mode === "superuser"
            ? "This scholar has no conflict-of-interest disclosures on file."
            : "You have no conflict-of-interest disclosures on file."}
        </p>
      ) : (
        <div className="border-apollo-border flex flex-col gap-5 rounded-md border px-4 py-4" data-slot="coi-panel-list">
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

      {showBridge && (
        <div
          className="border-apollo-amber-tint-border bg-apollo-amber-tint flex flex-wrap items-center justify-between gap-4 rounded-md border px-4 py-3.5"
          data-testid="coi-suggestions-bridge"
        >
          <div className="min-w-0">
            <p className="text-foreground flex items-center gap-2 text-sm font-semibold">
              <span className="bg-apollo-amber size-[7px] shrink-0 rounded-full" aria-hidden />
              {suggestionCount} {suggestionCount === 1 ? "relationship" : "relationships"} from{" "}
              {possessive} publications worth a look
            </p>
            <p className="text-muted-foreground mt-1 max-w-prose text-[0.8rem] leading-relaxed">
              Some papers {mode === "superuser" ? `${scholarName} authored` : "you authored"} name
              relationships in their competing-interests statements that don&rsquo;t match a current
              Gateway disclosure.{" "}
              {mode === "superuser"
                ? `Visible only to ${scholarName} and administrators.`
                : "Visible only to you."}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={suggestionsHref!} data-testid="coi-suggestions-bridge-link">
              Review suggestions
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      )}

      <div className="border-apollo-border flex flex-col items-start gap-2 border-t pt-3">
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
