/**
 * The ORCID value on the read-only Name & Title panel (#2650): a pointer into the
 * Identifiers & Profiles tab, where the iD is confirmed or entered. Present → a
 * link to the orcid.org record plus "Edit"; absent → "Not on file" plus "Add",
 * with the one-line reason (since May 2026 eRA refuses a SciENcv biosketch
 * without an ORCID iD linked to eRA Commons).
 */
"use client";

import Link from "next/link";

export function OrcidValue({ orcid, editHref }: { orcid: string | null; editHref: string }) {
  if (orcid) {
    return (
      <span>
        <a
          href={`https://orcid.org/${orcid}`}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
          data-testid="orcid-link"
        >
          {orcid}
        </a>{" "}
        <Link href={editHref} className="text-muted-foreground font-normal underline" data-testid="orcid-edit">
          Edit
        </Link>
      </span>
    );
  }
  return (
    <span data-testid="orcid-missing">
      Not on file.{" "}
      <Link href={editHref} className="underline" data-testid="orcid-edit">
        Add it
      </Link>
      <span className="text-muted-foreground block font-normal">
        Needed for NIH SciENcv biosketches; also makes your publication matching more reliable.
      </span>
    </span>
  );
}
