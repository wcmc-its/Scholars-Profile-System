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
import { ArrowUpRight } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { LockedRow } from "@/components/edit/readonly-attribute-panel";
import { fieldSource } from "@/lib/edit/field-sources";
import { WEB_DIRECTORY_URL } from "@/lib/edit/request-a-change";

export type EmailCardProps = {
  /** The imported `Scholar.email`; `null` when no email is on file. */
  email: string | null;
  /** `Scholar.emailVisibility` — 'public' | 'institution' | 'none' | null
   *  (NULL until the first ED ETL backfill; treated as "Not released"). */
  emailVisibility: string | null;
};

/** Visibility label + one-line "who can see this" explainer mirroring SPEC
 *  table A. Anything other than the two observed values (incl. NULL pre-backfill)
 *  falls through to the fail-closed "Not released" state. Worded without a
 *  possessive so it reads the same to the scholar and to an administrator
 *  (locked-panels canvas, 2026-09-23). */
function describeVisibility(value: string | null): { label: string; explainer: string } {
  switch (value) {
    case "public":
      return { label: "Public", explainer: "Anyone on the web can see it on the public profile." };
    case "institution":
      return {
        label: "Institution only",
        explainer:
          "Only people signed in or on the WCM network can see it. It's hidden from the public web.",
      };
    default:
      return { label: "Not released", explainer: "It's hidden everywhere on the public profile." };
  }
}

export function EmailCard({ email, emailVisibility }: EmailCardProps) {
  const { label, explainer } = describeVisibility(emailVisibility);

  return (
    <EditPanel
      slot="email-panel"
      heading="Email"
      description="The contact email on the public profile, and who can see it."
      headerAction={<LockedBadge from={fieldSource("name-title")} />}
    >
      <dl>
        <LockedRow label="Email">
          {email ?? <span className="text-muted-foreground">None on record</span>}
        </LockedRow>
        <LockedRow
          label="Visibility"
          alignTop
          action={
            <Link
              href={WEB_DIRECTORY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] whitespace-nowrap text-[#5c574d] hover:text-[#1f1b19] hover:underline"
              data-testid="email-web-directory-link"
            >
              Update in Web Directory
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          }
        >
          <div className="flex flex-col gap-2.5 pt-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium" data-testid="email-visibility-label">
                {label}
              </span>
              <span className="text-[#5c574d]" data-testid="email-visibility-explainer">
                {explainer}
              </span>
            </div>
            <p
              className="bg-apollo-surface-2 rounded-md px-3 py-2.5 text-[13px] leading-normal text-pretty text-[#5c574d]"
              data-testid="email-download-policy"
            >
              WCM staff who are signed in or on the campus network can also get this email through
              the internal directory export. That access is logged. Emails set to &ldquo;Not
              released&rdquo; are left out of the export, and bulk downloads of large groups
              aren&rsquo;t supported.
            </p>
            <p className="text-muted-foreground text-[13px] text-pretty">
              To change it, update &ldquo;Publish to&rdquo; in the Emails section of the Web
              Directory. Changes reach Scholars on the next refresh.
            </p>
          </div>
        </LockedRow>
      </dl>
    </EditPanel>
  );
}
