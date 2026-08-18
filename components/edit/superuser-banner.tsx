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

import { PubTitle } from "@/components/publication/pub-html";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type SuperuserBannerProps = {
  /** The label after "editing" — a scholar's preferred name or a publication title. */
  targetLabel: string;
  /**
   * What kind of target this is. `'profile'` (default) yields the scholar
   * copy "<Name>'s profile"; `'publication'` yields the publication copy.
   */
  targetKind?: "profile" | "publication";
  /**
   * The `cv_generator` role (#2482) reaches this same superuser-parity chrome
   * for READ access only — every write affordance below is `inert` (see
   * `EditShell`). Swaps the "editing … as an administrator" claim for an
   * honest read-only line so the banner never overstates what the viewer can
   * do.
   */
  readOnly?: boolean;
};

export function SuperuserBanner({
  targetLabel,
  targetKind = "profile",
  readOnly = false,
}: SuperuserBannerProps) {
  return (
    <Alert
      variant="info"
      className="border-apollo-maroon/30 bg-apollo-surface-2 mb-6"
      data-slot="superuser-banner"
    >
      <ShieldAlert className="text-apollo-maroon size-4" />
      <AlertDescription>
        {/* One <p> so the sentence is a single grid item. AlertDescription is a
            CSS grid; without this wrapper the leading text, the <strong> name,
            and the trailing "'s profile…" each become their own grid row, which
            is what dropped the possessive onto its own line. */}
        <p>
          {readOnly ? (
            <>
              You are viewing <strong>{targetLabel}</strong>&apos;s profile. This role is
              read-only: nothing on this page can be changed.
            </>
          ) : targetKind === "profile" ? (
            <>
              You are editing <strong>{targetLabel}</strong>&apos;s profile as an administrator.
            </>
          ) : (
            <>
              You are managing the publication <PubTitle as="strong" value={targetLabel} /> as an
              administrator.
            </>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
