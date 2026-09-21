/**
 * The proxy-mode banner (#779 / scholar-proxy-spec.md § API and UI).
 *
 * Server Component (no interactivity): the banner a designated proxy editor sees
 * above the cards on `/edit/scholar/[cwid]` when they are editing on a scholar's
 * behalf. Same slate-tint notice chrome as `SuperuserBanner` (design round 3,
 * 2026-09-21 — one standard across every /edit tab); the role is told by the
 * copy ("as their designated proxy editor"), not by colour or icon. The label
 * is the scholar being edited — never the proxy's own CWID (the proxy is the
 * signed-in actor).
 */
import { Shield } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export type ProxyBannerProps = {
  /** The scholar whose profile is being edited — their preferred name. */
  targetLabel: string;
};

export function ProxyBanner({ targetLabel }: ProxyBannerProps) {
  return (
    <Alert
      variant="info"
      className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-notice-text mb-6 rounded-lg px-[13px] py-[9px]"
      data-slot="proxy-banner"
    >
      <Shield className="size-4" aria-hidden />
      <AlertDescription className="text-apollo-notice-text text-[13px]">
        <p>
          You are editing <strong className="font-[600]">{targetLabel}</strong>&apos;s profile as their designated proxy
          editor. You can edit the overview and hide misattributed publications; name, title, and
          contact details come from WCM systems, and the profile URL is set by an administrator.
        </p>
      </AlertDescription>
    </Alert>
  );
}
