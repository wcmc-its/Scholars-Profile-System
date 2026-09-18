/**
 * The ORCID value on the read-only Name & Title panel (#2650). The one row on
 * that panel where an absent value is something the scholar must act on: since
 * May 2026 eRA refuses a SciENcv biosketch without an ORCID iD linked to eRA
 * Commons, so a null must read as a gap with a fix, not as a blank field.
 * Present → a link to the orcid.org record (the natural "is this mine" check).
 * Absent → "Not on file" + the same ReCiter self-service link Request a Change
 * already routes to.
 */
"use client";

import { ORCID_MANAGE_URL, resolveSelfServiceHref } from "@/lib/edit/request-a-change";

export function OrcidValue({ orcid, cwid }: { orcid: string | null; cwid: string }) {
  if (orcid) {
    return (
      <a
        href={`https://orcid.org/${orcid}`}
        target="_blank"
        rel="noreferrer"
        className="hover:underline"
        data-testid="orcid-link"
      >
        {orcid}
      </a>
    );
  }
  return (
    <span data-testid="orcid-missing">
      Not on file.{" "}
      <a
        href={resolveSelfServiceHref(ORCID_MANAGE_URL, cwid)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Add it in ReCiter
      </a>
      <span className="text-muted-foreground block font-normal">
        NIH requires an ORCID iD linked to eRA Commons for SciENcv biosketches.
      </span>
    </span>
  );
}
