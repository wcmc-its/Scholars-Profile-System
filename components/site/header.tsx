import Link from "next/link";
import { SearchAutocomplete } from "@/components/search/autocomplete";
import { ScrollRevealedSearch } from "@/components/site/scroll-revealed-search";

export function SiteHeader({
  showSearch = true,
  revealOnScrollPast,
}: {
  showSearch?: boolean;
  /**
   * Optional sentinel element id. When provided, the header search stays
   * hidden until this element scrolls out of view. Used on the homepage to
   * suppress the duplicate header search while the hero search is on-screen
   * (issue #215).
   */
  revealOnScrollPast?: string;
}) {
  return (
    <header
      className="sticky top-0 z-50 h-[60px] border-b border-black/15"
      style={{
        backgroundColor: "var(--color-primary-cornell-red)",
        boxShadow: "inset 0 -1px 0 rgba(255, 255, 255, 0.08)",
      }}
    >
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="flex flex-col shrink-0 gap-[4px] no-underline">
          <span
            className="font-serif leading-none text-white"
            style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.005em" }}
          >
            Scholars
          </span>
          <span
            className="font-sans uppercase leading-none text-white/82"
            style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.12em" }}
          >
            Weill Cornell Medicine
          </span>
        </Link>

        {showSearch ? (
          <div className="flex-1">
            {revealOnScrollPast ? (
              <ScrollRevealedSearch sentinelId={revealOnScrollPast} />
            ) : (
              <SearchAutocomplete />
            )}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <nav className="flex shrink-0 items-center gap-6">
          <Link href="/search" className="text-sm font-medium text-white/85 transition-colors hover:text-white">
            Browse
          </Link>
          <Link href="/about" className="text-sm font-medium text-white/85 transition-colors hover:text-white">
            About
          </Link>
          <Link href="/support" className="text-sm font-medium text-white/85 transition-colors hover:text-white">
            Support
          </Link>
        </nav>
      </div>
    </header>
  );
}
