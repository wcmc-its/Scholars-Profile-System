"use client";

/**
 * Report 26's Download menu: the spreadsheet, and the page itself through the
 * browser's print dialog, which saves a PDF. No PDF library: the print
 * stylesheet (`print:` classes in the body and the console shell) is the PDF.
 * Nothing here reaches `@/lib/db`.
 */
import { useEffect, useState } from "react";
import { ChevronDown, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ITEM = "hover:bg-apollo-surface-2 flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left";

export function PortfolioDownloadMenu({ xlsxHref }: { xlsxHref: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="apollo" size="sm" data-testid="portfolio-download">
          <Download className="size-4" aria-hidden />
          Download
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="border-apollo-border-strong w-[340px] rounded-[10px] p-1.5" data-testid="portfolio-download-menu">
        <a href={xlsxHref} className={ITEM} onClick={() => setOpen(false)} data-testid="portfolio-download-xlsx">
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Spreadsheet</span>
            <span className="text-muted-foreground text-xs">.xlsx</span>
          </span>
          <span className="text-muted-foreground text-xs leading-[1.45]">Every table on the page, one tab each, with the underlying counts</span>
        </a>
        <button
          type="button"
          className={ITEM}
          onClick={() => {
            setOpen(false);
            // After the popover closes, so it is not in the printout.
            requestAnimationFrame(() => window.print());
          }}
          data-testid="portfolio-download-pdf"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">PDF report</span>
            <span className="text-muted-foreground text-xs">.pdf</span>
          </span>
          <span className="text-muted-foreground text-xs leading-[1.45]">
            The page as shown, charts included. Opens the print dialog; choose Save as PDF.
          </span>
        </button>
        <div className="bg-apollo-border mx-1 my-1.5 h-px" aria-hidden />
        <p className="text-muted-foreground px-3 pt-1 pb-1.5 text-xs">Every file uses the current filters and notes the date.</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Scrolls to the URL's `#units` / `#items` once the body has streamed in. The
 * body sits in a Suspense keyed on the filters, so after a filter link Next
 * looks for the anchor while only the skeleton exists and lands at the top.
 * Mounts with each new body, so it runs once per filter change.
 */
export function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);
  return null;
}
