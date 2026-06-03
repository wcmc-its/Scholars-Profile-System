/**
 * AdministratorsRoster — the read-only Administrators-tab body (#728 Phase B,
 * `ed-admin-org-unit-roles-spec.md` § 4.2). One card per person, each listing
 * the org units they manage (name + kind badge), the role, and the grant
 * provenance (`UnitAdmin.source`). NO write controls — add/edit/revoke is Phase C.
 *
 * A pure presentational component (no hooks, no fetch) so it stays a Server
 * Component; styling + data-testid conventions mirror `unit-access-card.tsx`.
 */
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AdminRosterEntry } from "@/lib/api/administrators-roster";

/** Human-readable label for a grant's provenance (`UnitAdmin.source`). */
function provenanceLabel(source: string): string {
  switch (source) {
    case "manual":
      return "Manual";
    case "ED:DA":
      return "ED — Department Administrator";
    case "ED:DivA":
      return "ED — Division Administrator";
    case "ED:IAMDELA":
      return "ED — IAMDELA";
    case "ED:DivA-IAMDELA":
      return "ED — DivA-IAMDELA";
    default:
      // Unknown future source: show it verbatim rather than swallow it.
      return source;
  }
}

const KIND_LABEL: Record<AdminRosterEntry["grants"][number]["entityType"], string> = {
  department: "Department",
  division: "Division",
  center: "Center",
};

export type AdministratorsRosterProps = {
  entries: ReadonlyArray<AdminRosterEntry>;
  /** True ⇒ "Showing all administrators" (superuser); false ⇒ Owner-scoped. */
  isSuperuser: boolean;
  /** True when any grantee renders as a bare CWID — shows the #443 note. */
  nameResolutionDegraded: boolean;
};

export function AdministratorsRoster({
  entries,
  isSuperuser,
  nameResolutionDegraded,
}: AdministratorsRosterProps) {
  const scopeCaption = isSuperuser
    ? "Showing all administrators."
    : "Showing administrators within the units you own.";

  return (
    <div className="flex flex-col gap-4" data-slot="administrators-roster">
      <p className="text-muted-foreground text-sm" data-testid="administrators-scope-caption">
        {scopeCaption}
      </p>

      {nameResolutionDegraded && (
        <p className="text-muted-foreground text-sm" data-testid="administrators-name-degraded-note">
          Some names resolve from the Enterprise Directory and are unavailable until directory
          routing (#443) lands; unit scope, role, and provenance below are accurate.
        </p>
      )}

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="administrators-empty">
          {isSuperuser ? "No administrators yet." : "No administrators within your units."}
        </p>
      ) : (
        entries.map((entry) => (
          <Card key={entry.cwid} data-testid={`administrators-card-${entry.cwid}`}>
            <CardHeader>
              <CardTitle className="text-base">
                <span className="font-medium">{entry.name}</span>
                {entry.title && (
                  <span className="text-muted-foreground font-normal"> · {entry.title}</span>
                )}
                <span className="text-muted-foreground ml-2 text-xs font-normal tabular-nums">
                  {entry.cwid}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm" data-testid={`administrators-grants-${entry.cwid}`}>
                <thead>
                  <tr className="text-muted-foreground border-border border-b text-left">
                    <th className="py-2 font-medium">Org unit</th>
                    <th className="py-2 font-medium">Role</th>
                    <th className="py-2 font-medium">Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.grants.map((grant) => (
                    <tr
                      key={`${grant.entityType}:${grant.entityId}`}
                      className="border-border border-b"
                      data-testid={`administrators-grant-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                    >
                      <td className="py-2">
                        <span className="font-medium">{grant.unitName}</span>
                        <Badge variant="outline" className="ml-2">
                          {KIND_LABEL[grant.entityType]}
                        </Badge>
                      </td>
                      <td className="py-2 capitalize">{grant.role}</td>
                      <td className="py-2">{provenanceLabel(grant.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
