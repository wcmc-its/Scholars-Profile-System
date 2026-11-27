"use client";

/**
 * Report 27's client half: the two buttons that open the publication modal
 * (`components/publication/publication-modal.tsx`, the one the public pages
 * use) from a Publications row. The body mounts `PublicationModalProvider`
 * around the list; nothing here fetches or reaches `@/lib/db`.
 */
import type { ReactNode } from "react";

import { pubTitleProps } from "@/components/publication/pub-html";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { sanitizePubTitle } from "@/lib/utils";

/** The paper's title, as the search and profile rows have it: a button that
 *  opens the publication modal. */
export function PaperTitle({ pmid, title }: { pmid: string; title: string }) {
  const { open } = usePublicationModal();
  return (
    <button
      type="button"
      onClick={() => open(pmid)}
      aria-haspopup="dialog"
      data-testid="downstream-reach-title"
      {...pubTitleProps(sanitizePubTitle(title), "text-left font-medium hover:underline")}
    />
  );
}

/** A count that opens the publication modal at the section listing what it
 *  counts ("trials": clinical studies, trials and patents; "policy"). */
export function ModalCount({
  pmid,
  section,
  label,
  className,
  children,
}: {
  pmid: string;
  section: "trials" | "policy";
  /** "12 clinical studies citing this paper": the button's accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { open } = usePublicationModal();
  return (
    <button
      type="button"
      onClick={() => open(pmid, { section })}
      aria-haspopup="dialog"
      aria-label={label}
      className={className}
      data-testid="downstream-reach-modal-count"
    >
      {children}
    </button>
  );
}
