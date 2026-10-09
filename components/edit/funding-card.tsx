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
import { fundingRoleLabel } from "@/lib/funding-roles";
import type { EditContextGrant } from "@/lib/api/edit-context";

export type FundingCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  grants: ReadonlyArray<EditContextGrant>;
  /** See `EntityPanel`'s `delegated`. */
  delegated?: boolean;
};

/** #2180 — `Grant.datesSource` in words. An unrecognized value renders as-is
 *  rather than being guessed into one of the known ones. */
function datesSourceLabel(datesSource: string): string {
  if (datesSource === "infoed") return "Dates from InfoEd";
  if (datesSource === "reporter") return "Dates from NIH RePORTER (missing in InfoEd)";
  return `Dates from ${datesSource}`;
}

/**
 * #2180 — the record-level routing line under an InfoEd award: the four things
 * an admin needs to know who to contact and what to quote (InfoEd account,
 * central office, intake type, where the dates came from). Degrades FIELD BY
 * FIELD — each part renders only when recorded, never a guessed default — and
 * the whole line is omitted when nothing is known (every RePORTER row).
 */
export function grantRecordParts(g: EditContextGrant): string[] {
  const parts: string[] = [];
  if (g.accountNumber) parts.push(`InfoEd account ${g.accountNumber}`);
  if (g.centralOffice) parts.push(`Office: ${g.centralOffice}`);
  if (g.intakeType) parts.push(`Intake type: ${g.intakeType}`);
  if (g.datesSource) parts.push(datesSourceLabel(g.datesSource));
  return parts;
}

export function FundingCard({ cwid, mode, scholarName, grants, delegated }: FundingCardProps) {
  // The panel mixes two systems of record: InfoEd (the default) and NIH
  // RePORTER (the "via NIH RePORTER" backfill rows). Surface both in the header
  // when present, and route each row's "Request a change" to the right place.
  const hasReporter = grants.some((g) => g.source === "RePORTER");
  const hasRecordDetail = grants.some((g) => grantRecordParts(g).length > 0);
  return (
    <EntityPanel
      slot="funding-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      delegated={delegated}
      entityType="grant"
      entities={grants}
      filterable
      extendable
      sourceLabel={hasReporter ? "InfoEd and NIH RePORTER" : undefined}
      getRequestAttribute={(g) => (g.source === "RePORTER" ? "funding-reporter" : "funding")}
      getTitle={(g) => g.title}
      renderDetail={(g) => {
        const parts = grantRecordParts(g);
        return parts.length > 0 ? (
          <p className="text-muted-foreground mt-0.5 text-xs" data-slot="grant-record">
            {parts.join(" · ")}
          </p>
        ) : null;
      }}
      renderMeta={(g) => (
        <>
          {g.funderLabel}
          {" · "}
          {fundingRoleLabel(g.role)}
          {" · "}
          {g.startYear}–{g.endYear}
          {" · "}
          <Badge
            variant="outline"
            className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
          >
            {g.isActive ? "Active" : "Past"}
          </Badge>
          {g.source === "RePORTER" ? (
            <>
              {" · "}
              <span className="text-muted-foreground">via NIH RePORTER</span>
            </>
          ) : null}
        </>
      )}
      copy={{
        heading: "Funding",
        description: `Hide a grant to remove yourself from it on ${
          mode === "superuser" ? "this scholar's profile" : "this site"
        }. Each entry is your role on one award; hiding it doesn't affect the award's other investigators. It may take up to a day to clear from funding search. Hiding is display-only — it doesn't correct the award; ${
          hasReporter
            ? "the underlying record stays in its source system (InfoEd or NIH RePORTER)."
            : "the record stays in WCM systems and on internal reports."
        }${
          hasRecordDetail
            ? " To correct an InfoEd award, contact the office that manages it (listed under the award, when InfoEd records one) and quote its account number."
            : ""
        }`,
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
