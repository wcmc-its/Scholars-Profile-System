import Link from "next/link";
import { SearchAutocomplete } from "@/components/search/autocomplete";

/**
 * Persistent site header with branding and the always-visible search box.
 * Search input wires through SearchAutocomplete (Phase 3): autocomplete fires
 * on 2 characters, Enter routes to /search, click-through routes to the
 * scholar profile.
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
        <SearchAutocomplete />
      </div>
    </header>
  );
}
