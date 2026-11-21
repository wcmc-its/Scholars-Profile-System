/**
 * Site-chrome links to /, /about and /search must not prefetch. They render on
 * every public page, so Next's viewport prefetch fetched all three RSC payloads
 * on every view: ~810k requests/day from one scraper fleet on 2026-11-20, and
 * /search is uncached at the edge, so each one reached the origin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const linkProps: Array<Record<string, unknown>> = [];
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    linkProps.push(props);
    return <a href={String(props.href)}>{props.children}</a>;
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/search/autocomplete", () => ({ SearchAutocomplete: () => null }));
vi.mock("@/components/site/scroll-revealed-search", () => ({ ScrollRevealedSearch: () => null }));
vi.mock("@/components/site/header-auth-slot", () => ({ HeaderAuthSlot: () => null }));

import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { MobileNav } from "@/components/site/mobile-nav";

const CHROME_TARGETS = new Set(["/", "/about", "/search"]);
const chromeLinks = () => linkProps.filter((p) => CHROME_TARGETS.has(String(p.href)));

beforeEach(() => {
  linkProps.length = 0;
});

describe("site chrome links do not prefetch", () => {
  it("SiteHeader: wordmark, Browse, About and the mobile search icon", () => {
    render(<SiteHeader />);
    const hrefs = chromeLinks().map((p) => String(p.href));
    expect(hrefs).toEqual(expect.arrayContaining(["/", "/about", "/search"]));
    // Browse + the mobile search icon both point at /search.
    expect(hrefs.filter((h) => h === "/search")).toHaveLength(2);
    for (const p of chromeLinks()) expect(p.prefetch).toBe(false);
  });

  it("SiteFooter: Help & support", () => {
    render(<SiteFooter />);
    expect(chromeLinks()).toHaveLength(1);
    for (const p of chromeLinks()) expect(p.prefetch).toBe(false);
  });

  it("MobileNav: Browse and About in the sheet", async () => {
    render(<MobileNav />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await screen.findByRole("link", { name: "Browse" });
    const hrefs = chromeLinks().map((p) => String(p.href));
    expect(hrefs).toEqual(expect.arrayContaining(["/about", "/search"]));
    for (const p of chromeLinks()) expect(p.prefetch).toBe(false);
  });
});
