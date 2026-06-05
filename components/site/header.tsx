import Link from "next/link";
import { SearchAutocomplete } from "@/components/search/autocomplete";
import { ScrollRevealedSearch } from "@/components/site/scroll-revealed-search";
import { HeaderAuthSlot } from "@/components/site/header-auth-slot";
import { BetaBadge, isBetaBadgeEnabled } from "@/components/site/beta-badge";

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
  // #356 Phase 5 / #640 — the auth slot (Sign in / AccountMenu) is resolved
  // entirely client-side by <HeaderAuthSlot>, which probes /api/auth/session.
  // The header must NOT read the session (cookies) on the server: every public
  // surface is CloudFront-cached with the Cookie header stripped (so a server
  // read is wrong anyway), and a server cookies() read forces statically-
  // generated pages (e.g. /scholars/[slug]) to change "static → dynamic at
  // runtime" and 500s them (#640).

  // #760 — launch-period "Beta" marker. Default ON; gated by SHOW_BETA_BADGE
  // (process.env only, NOT cookies) so it stays cache-safe like the rest of the
  // header. Retired at full launch by flipping the flag, not a code change.
  const showBetaBadge = isBetaBadgeEnabled();

  return (
    <header
      className="sticky top-0 z-50 h-[60px] border-b border-black/15"
      style={{
        backgroundColor: "var(--color-primary-cornell-red)",
        boxShadow: "inset 0 -1px 0 rgba(255, 255, 255, 0.08)",
      }}
    >
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="flex shrink-0 flex-col gap-[4px] no-underline">
          {/* #760 — badge shares the wordmark's top row so it centers on the
              "Scholars" cap height via items-center (no magic vertical offset);
              the subtitle drops to the row below. */}
          <span className="flex items-center gap-2.5">
            <span
              className="font-serif leading-none text-white"
              style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.005em" }}
            >
              Scholars
            </span>
            {showBetaBadge ? <BetaBadge /> : null}
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

        <nav aria-label="Primary" className="flex shrink-0 items-center gap-6">
          <Link href="/search" className="text-sm font-medium text-white/85 transition-colors hover:text-white">
            Browse
          </Link>
          <Link href="/about" className="text-sm font-medium text-white/85 transition-colors hover:text-white">
            About
          </Link>
          <HeaderAuthSlot isAuthenticated={false} scholar={null} />
        </nav>
      </div>
    </header>
  );
}
