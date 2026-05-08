"use client";

import { SponsorAbbr } from "@/components/ui/sponsor-abbr";
import { isNihIc } from "@/lib/sponsor-lookup";

/**
 * Renders a funder for the eyebrow line. When the short maps to an NIH IC,
 * prefix with "NIH/" so the parent agency is visible (issue #80 item 1).
 * The IC short itself stays a SponsorAbbr so hover still expands it to the
 * full IC name (e.g., "National Cancer Institute").
 */
export function FunderEyebrow({
  short,
  className,
}: {
  short: string;
  className?: string;
}) {
  if (isNihIc(short)) {
    return (
      <span className={className}>
        <span>NIH/</span>
        <SponsorAbbr short={short} />
      </span>
    );
  }
  return <SponsorAbbr short={short} className={className} />;
}
