"use client";

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * "What is ORCID?" — an (i) beside the ORCID iD on the public profile and on the
 * `/edit` card (ADR-016 D3). A click Popover, not a hover tooltip: it holds a
 * link, and a HoverCard is hostile to touch.
 */
export function OrcidInfoButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="What is ORCID?"
          className="text-muted-foreground hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
          data-testid="orcid-info"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 text-left text-[13px] leading-[1.55] font-normal tracking-normal normal-case"
      >
        <p className="m-0 font-semibold">What is ORCID?</p>
        <p className="mt-1 mb-0">
          ORCID is a free, unique identifier for researchers that stays with you across
          institutions and name changes. Publishers, funders and WCM systems use it to connect you
          to your work.
        </p>
        <p className="mt-2 mb-0">
          <strong>Authenticated</strong> means the researcher signed in to ORCID to prove the iD is
          theirs.
        </p>
        <a
          href="https://info.orcid.org/what-is-orcid/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block font-semibold text-[var(--color-accent-slate)] underline underline-offset-4"
        >
          Learn more at orcid.org ↗
        </a>
      </PopoverContent>
    </Popover>
  );
}
