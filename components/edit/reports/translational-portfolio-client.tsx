"use client";

/**
 * Report 26's Download menu: the spreadsheet, and the page itself through the
 * browser's print dialog, which saves a PDF. No PDF library: the print
 * stylesheet (`print:` classes in the body and the console shell) is the PDF.
 * Nothing here reaches `@/lib/db`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const ITEM = "hover:bg-apollo-surface-2 flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left";

export function PortfolioDownloadMenu({
  xlsxHref,
  xlsxNote = "Every table on the page, one tab each, with the underlying counts",
}: {
  xlsxHref: string;
  /** What the spreadsheet holds, under its name. */
  xlsxNote?: string;
}) {
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
          <span className="text-muted-foreground text-xs leading-[1.45]">{xlsxNote}</span>
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

/** One type-ahead match: `href` is the scholar's portfolio page under the
 *  report's filters, or null when this viewer cannot open it. */
export type LookupMatch = { cwid: string; name: string; title: string | null; department: string | null; href: string | null };

/**
 * The rail's scholar lookup: matches drop down under the box as you type
 * (debounced, stale requests aborted), arrow keys and Enter pick one, Escape
 * closes. It sits inside the rail's auto-submitting form, so its own changes
 * and Enter are kept from submitting it. `report` is the report's query
 * string, carried to the scholar's page for the link back.
 */
export function ScholarLookup({ report }: { report: string }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<LookupMatch[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const text = q.trim();
    abort.current?.abort();
    if (text.length < 2) {
      setMatches(null);
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    const t = setTimeout(() => {
      fetch(`/api/edit/reports/translational-portfolio/scholars?${new URLSearchParams({ q: text, r: report })}`, { signal: ctl.signal })
        .then((res) => (res.ok ? (res.json() as Promise<{ matches: LookupMatch[] }>) : { matches: [] }))
        .then((body) => {
          setMatches(body.matches);
          setActive(-1);
          setOpen(true);
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q, report]);

  const go = (m: LookupMatch | undefined) => {
    if (!m?.href) return;
    setOpen(false);
    window.location.assign(m.href);
  };
  const listId = `${id}-list`;
  const showList = open && matches !== null;

  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <input
        type="search"
        value={q}
        onChange={(e) => {
          e.stopPropagation(); // not a filter: never submit the rail
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = matches?.length ?? 0;
            if (n > 0) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
            setOpen(true);
          } else if (e.key === "Enter") {
            e.preventDefault(); // the form would submit
            go(matches?.[active >= 0 ? active : 0]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search by name or CWID…"
        aria-label="Look up a scholar by name or CWID"
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        className="border-apollo-border-strong bg-apollo-surface h-10 w-full rounded-lg border px-3 text-[15px]"
        data-testid="portfolio-lookup-input"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="bg-apollo-surface border-apollo-border-strong absolute inset-x-0 top-full z-20 mt-1 max-h-80 list-none overflow-y-auto rounded-lg border p-1 shadow-md"
          data-testid="portfolio-lookup"
        >
          {matches.length === 0 ? (
            <li className="text-muted-foreground px-2.5 py-2 text-sm">No active scholar matches.</li>
          ) : (
            matches.map((m, i) => (
              <li
                key={m.cwid}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={m.href ? undefined : true}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(m)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex flex-col rounded-md px-2.5 py-1.5",
                  m.href ? "cursor-pointer" : "cursor-default opacity-70",
                  i === active && m.href && "bg-apollo-surface-2",
                )}
                data-testid="portfolio-lookup-option"
              >
                <span className="text-sm font-medium">{m.name}</span>
                <span className="text-muted-foreground text-xs">
                  {[m.title, m.department].filter(Boolean).join(" · ")}
                  {m.title || m.department ? " · " : ""}
                  <span className="font-mono">{m.cwid}</span>
                </span>
                {!m.href && <span className="text-muted-foreground text-xs">You can&rsquo;t open this scholar&rsquo;s portfolio.</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
