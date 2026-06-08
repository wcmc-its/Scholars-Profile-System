/**
 * The proxy-mode banner (#779 / scholar-proxy-spec.md § API and UI).
 *
 * Server Component (no interactivity): the banner a designated proxy editor sees
 * above the cards on `/edit/scholar/[cwid]` when they are editing on a scholar's
 * behalf. Deliberately VISUALLY DISTINCT from the superuser banner ("editing …
 * as an administrator") and the #637 impersonation banner ("viewing/acting as
 * …") so the three roles never read alike. The label is the scholar being
 * edited — never the proxy's own CWID (the proxy is the signed-in actor).
 *
 * Visual/interaction polish (placement, exact styling) is a UI-SPEC deliverable;
 * this is the functional v1 banner.
 */
import { UserCheck } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export type ProxyBannerProps = {
  /** The scholar whose profile is being edited — their preferred name. */
  targetLabel: string;
};

export function ProxyBanner({ targetLabel }: ProxyBannerProps) {
  return (
    <Alert
      variant="info"
      className="border-apollo-slate/40 bg-apollo-surface-2 mb-6"
      data-slot="proxy-banner"
    >
      <UserCheck className="text-apollo-slate size-4" />
      <AlertDescription>
        <p>
          You are editing <strong>{targetLabel}</strong>&apos;s profile as their designated proxy
          editor. You can edit the overview and hide misattributed publications; name, title, and
          contact details come from WCM systems, and the profile URL is set by an administrator.
        </p>
      </AlertDescription>
    </Alert>
  );
}
