/**
 * The ORCID value on the read-only Name & Title panel (#2650). The one row on
 * that panel where an absent value is something the scholar must act on: since
 * May 2026 eRA refuses a SciENcv biosketch without an ORCID iD linked to eRA
 * Commons, so a null must read as a gap with a fix, not as a blank field.
 * Present → a link to the orcid.org record (the natural "is this mine" check).
 * Absent → "Not on file" + the same ReCiter self-service link Request a Change
 * already routes to. Absent with a strong-inferred candidate
 * (`SELF_EDIT_ORCID_SUGGESTION`, same fold as the home board's ORCID row) → the
 * candidate iD as "Is this yours?" ahead of the same link.
 */
"use client";

import { ORCID_MANAGE_URL, resolveSelfServiceHref } from "@/lib/edit/request-a-change";

export function OrcidValue({
  orcid,
  cwid,
  suggested = null,
}: {
  orcid: string | null;
  cwid: string;
  suggested?: { orcid: string; accepted: number } | null;
}) {
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
      {suggested && (
        <span data-testid="orcid-suggested">
          Is{" "}
          <a
            href={`https://orcid.org/${suggested.orcid}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {suggested.orcid}
          </a>{" "}
          yours?{" "}
        </span>
      )}
      <a
        href={resolveSelfServiceHref(ORCID_MANAGE_URL, cwid)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        {suggested ? "Confirm in ReCiter" : "Add it in ReCiter"}
      </a>
      <span className="text-muted-foreground block font-normal">
        Needed for NIH SciENcv biosketches; also makes your publication matching more reliable.
      </span>
    </span>
  );
}
