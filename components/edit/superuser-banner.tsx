/**
 * The superuser-mode banner (#356 Phase 7 C2, UI-SPEC § Global layout — the
 * `/edit/*` shell, § `/edit/scholar/[cwid]`).
 *
 * Server Component (no interactivity, no state): the banner an administrator
 * sees above the cards on `/edit/scholar/[cwid]` (when `cwid != session.cwid`)
 * and on `/edit/publication/[pmid]`. The label is the editing target — a
 * scholar's preferred name on the scholar surface, the publication title on
 * the takedown surface — and never the actor's CWID (the actor is already in
 * the header's account menu).
 */
import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export type SuperuserBannerProps = {
  /** The label after "editing" — a scholar's preferred name or a publication title. */
  targetLabel: string;
  /**
   * What kind of target this is. `'profile'` (default) yields the scholar
   * copy "<Name>'s profile"; `'publication'` yields the publication copy.
   */
  targetKind?: "profile" | "publication";
};

export function SuperuserBanner({ targetLabel, targetKind = "profile" }: SuperuserBannerProps) {
  return (
    <Alert variant="info" className="mb-6" data-slot="superuser-banner">
      <ShieldAlert className="size-4" />
      <AlertDescription>
        {targetKind === "profile" ? (
          <>
            You are editing <strong>{targetLabel}</strong>&apos;s profile as an administrator.
          </>
        ) : (
          <>
            You are managing the publication <strong>{targetLabel}</strong> as an administrator.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
