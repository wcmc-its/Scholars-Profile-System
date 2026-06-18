/**
 * The unit-admin-mode banner (Amendment 4 / scholar-proxy-unit-admin-amendment.md
 * § Proposed model).
 *
 * Server Component (no interactivity): the banner an org-unit administrator sees
 * above the cards on `/edit/scholar/[cwid]` when they reach a scholar's edit
 * surface by virtue of administering a unit the scholar belongs to. Deliberately
 * VISUALLY DISTINCT from the #779 proxy banner ("as their designated proxy
 * editor"), the superuser banner ("as an administrator"), and the #637
 * impersonation banner ("viewing/acting as …") so the roles never read alike.
 * The label is the scholar being edited — never the admin's own CWID (the admin
 * is the signed-in actor) — and the unit names the relation that confers access
 * (the scholar's department or division — "via {unit} administrator").
 *
 * Visual/interaction polish (placement, exact styling) is a UI-SPEC deliverable;
 * this is the functional v1 banner.
 */
import { Building2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export type UnitAdminBannerProps = {
  /** The scholar whose profile is being edited — their preferred name. */
  targetLabel: string;
  /** The kind of unit through which access is conferred — `center` only when
   *  UNIT_ADMIN_CENTER_PROXY is on (#1104; D1 originally excluded centers). */
  unitKind: "department" | "division" | "center";
  /** The conferring unit's display name (resolved from `Department`/`Division`). */
  unitName: string;
};

export function UnitAdminBanner({ targetLabel, unitKind, unitName }: UnitAdminBannerProps) {
  return (
    <Alert
      variant="info"
      className="border-apollo-maroon/30 bg-apollo-surface-2 mb-6"
      data-slot="unit-admin-banner"
    >
      <Building2 className="text-apollo-maroon size-4" />
      <AlertDescription>
        <p>
          You are editing <strong>{targetLabel}</strong>&apos;s profile as an administrator of their{" "}
          {unitKind}, <strong>{unitName}</strong>. You can edit the overview and hide misattributed
          publications; name, title, and contact details come from WCM systems, and the profile URL
          is set by a Scholars administrator.
        </p>
      </AlertDescription>
    </Alert>
  );
}
