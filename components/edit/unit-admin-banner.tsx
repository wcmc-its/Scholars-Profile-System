/**
 * The unit-admin-mode banner (Amendment 4 / scholar-proxy-unit-admin-amendment.md
 * § Proposed model).
 *
 * Server Component (no interactivity): the banner an org-unit administrator sees
 * above the cards on `/edit/scholar/[cwid]` when they reach a scholar's edit
 * surface by virtue of administering a unit the scholar belongs to. Same
 * slate-tint notice chrome as `SuperuserBanner` (design round 3, 2026-09-21 —
 * one standard across every /edit tab); the role is told by the copy ("as an
 * administrator of their {unit}"), not by colour or icon. The label is the
 * scholar being edited — never the admin's own CWID (the admin is the signed-in
 * actor) — and the unit names the relation that confers access (the scholar's
 * department or division — "via {unit} administrator").
 */
import { Shield } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export type UnitAdminBannerProps = {
  /** The scholar whose profile is being edited — their preferred name. */
  targetLabel: string;
  /** The kind of unit through which access is conferred — `center` only when
   *  UNIT_ADMIN_CENTER_PROXY is on (#1104; D1 originally excluded centers);
   *  `institution` = the scholar's ED primary organization (lib/institutions.ts). */
  unitKind: "department" | "division" | "center" | "institution";
  /** The conferring unit's display name (resolved from `Department`/`Division`). */
  unitName: string;
};

export function UnitAdminBanner({ targetLabel, unitKind, unitName }: UnitAdminBannerProps) {
  return (
    <Alert
      variant="info"
      className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-notice-text mb-6 rounded-lg px-[13px] py-[9px]"
      data-slot="unit-admin-banner"
    >
      <Shield className="size-4" aria-hidden />
      <AlertDescription className="text-apollo-notice-text text-[13px]">
        <p>
          You are editing <strong className="font-[600]">{targetLabel}</strong>&apos;s profile as an administrator of their{" "}
          {unitKind}, <strong className="font-[600]">{unitName}</strong>. You can edit the overview and hide misattributed
          publications; name, title, and contact details come from WCM systems, and the profile URL
          is set by a Scholars administrator.
        </p>
      </AlertDescription>
    </Alert>
  );
}
