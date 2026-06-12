/**
 * The read-only "Email" attribute panel (email-visibility SPEC § C). The email
 * and its release audience are owned by the Web Directory (the SOR): SPS imports
 * `weillCornellEduReleaseCode;mail` into `Scholar.emailVisibility` on each ED ETL
 * run and never authors it. So this panel has NO write control — it shows the
 * imported email, the current visibility, a plain-language "who can see this"
 * line mirroring SPEC table A, and a self-service link to the Web Directory where
 * the scholar changes the "publish to" value in the Emails section.
 *
 * Owner context is internal (the scholar editing their own profile, or a
 * superuser on their behalf), so the email itself is always shown here — the
 * visibility value is informational, the same trap-avoidance as `ed_locked`
 * fields (an editable control would silently desync on the next ETL run).
 */
"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { Button } from "@/components/ui/button";
import { WEB_DIRECTORY_URL } from "@/lib/edit/request-a-change";

export type EmailCardProps = {
  mode: "self" | "superuser";
  scholarName: string;
  /** The imported `Scholar.email`; `null` when no email is on file. */
  email: string | null;
  /** `Scholar.emailVisibility` — 'public' | 'institution' | 'none' | null
   *  (NULL until the first ED ETL backfill; treated as "Not released"). */
  emailVisibility: string | null;
};

/** Visibility label + one-line "who can see this" explainer mirroring SPEC
 *  table A. Anything other than the two observed values (incl. NULL pre-backfill)
 *  falls through to the fail-closed "Not released" state. */
function describeVisibility(value: string | null): { label: string; explainer: string } {
  switch (value) {
    case "public":
      return {
        label: "Public",
        explainer: "Anyone on the web can see your email on your public profile.",
      };
    case "institution":
      return {
        label: "Institution only",
        explainer:
          "Only people signed in or on the WCM network can see your email; it is hidden from the public web.",
      };
    default:
      return {
        label: "Not released",
        explainer: "Your email is hidden everywhere on your public profile.",
      };
  }
}

export function EmailCard({ mode, scholarName, email, emailVisibility }: EmailCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  const { label, explainer } = describeVisibility(emailVisibility);
  // First-person table-A copy for the scholar; reframed to the scholar's name
  // for a superuser viewing it on their behalf.
  const reframed =
    mode === "superuser"
      ? explainer.replace(/\byour\b/g, `${scholarName}'s`).replace(/\bYour\b/g, `${scholarName}'s`)
      : explainer;

  return (
    <EditPanel
      slot="email-panel"
      attribute="name-title"
      heading="Email"
      description={`The email shown on ${possessive} public profile and who can see it. Both come from the WCM Web Directory and aren't editable here.`}
    >
      <LockedBadge />

      <dl className="border-apollo-border grid grid-cols-[max-content_1fr] gap-x-8 border-t text-sm">
        <div className="border-apollo-border contents [&>*]:border-b [&>*]:py-3.5">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="text-foreground font-medium">{email ?? "—"}</dd>
        </div>
        <div className="border-apollo-border contents [&>*]:border-b [&>*]:py-3.5">
          <dt className="text-muted-foreground">Visibility</dt>
          <dd className="text-foreground font-medium" data-testid="email-visibility-label">
            {label}
          </dd>
        </div>
      </dl>

      <p className="text-muted-foreground text-sm" data-testid="email-usage-note">
        This is the contact email shown on {possessive} public profile.
      </p>

      <p className="text-muted-foreground text-sm" data-testid="email-visibility-explainer">
        {reframed}
      </p>

      <p className="text-muted-foreground text-sm" data-testid="email-download-policy">
        WCM staff who are signed in or on the campus network may also download {possessive} email
        as part of an internal directory export, and that access is logged. A &ldquo;Not
        released&rdquo; email is excluded from the export, and bulk download of large groups is not
        supported.
      </p>

      <div className="border-apollo-border flex flex-col items-start gap-2 border-t pt-3">
        <p className="text-sm font-medium">This section is not editable.</p>
        <p className="text-muted-foreground text-sm">
          To change who can see {possessive} email, update the &ldquo;Publish to&rdquo; value in the
          Emails section of the Web Directory. The change reaches Scholars on the next refresh.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link
            href={WEB_DIRECTORY_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="email-web-directory-link"
          >
            Update in Web Directory
            <ExternalLink className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </EditPanel>
  );
}
