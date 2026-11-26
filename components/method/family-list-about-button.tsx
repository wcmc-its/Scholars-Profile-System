"use client";

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * METHOD_SERVICES — "About this list" beside the title of the systematic
 * review method page: where its publication list comes from. Shown for that
 * one family only (`isSystematicReviewFamily`), because it is the only family
 * whose list is built from two sources.
 *
 * Same (i) trigger and popover styling as `OrcidInfoButton`. A click Popover,
 * not a hover card, so it works on touch.
 */
export function FamilyListAboutButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About this list"
          className="text-muted-foreground hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)] max-sm:size-11"
          data-testid="family-list-about"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 text-left text-[13px] leading-[1.55] font-normal tracking-normal normal-case"
      >
        <p className="m-0 font-semibold">About this list</p>
        <p className="mt-1 mb-0">
          This list combines methods extracted from papers with PubMed&apos;s systematic review
          filter. It includes papers with at least one full-time faculty author.
        </p>
      </PopoverContent>
    </Popover>
  );
}
