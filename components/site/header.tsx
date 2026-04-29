import Link from "next/link";
import { Search } from "lucide-react";

/**
 * Persistent site header with branding and the always-visible search box.
 * Search functionality wires up in Phase 3; for now the input is non-interactive.
 */
export function SiteHeader() {
  return (
    <header className="border-border bg-background sticky top-0 z-10 border-b">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="bg-primary text-primary-foreground rounded-md px-2 py-1 text-sm">
            WCM
          </span>
          <span className="text-base">Scholars</span>
        </Link>
        <div className="flex-1" />
        <div className="text-muted-foreground flex w-full max-w-sm items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <Search className="h-4 w-4" />
          <span className="text-muted-foreground italic">Search scholars (Phase 3)</span>
        </div>
      </div>
    </header>
  );
}
