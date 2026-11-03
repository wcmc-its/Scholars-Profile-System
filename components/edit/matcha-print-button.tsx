"use client";

/** The report's one on-screen action. Printing (or Save as PDF) is the browser's own. */
export function MatchaPrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium hover:opacity-90"
    >
      Print / Save as PDF
    </button>
  );
}
