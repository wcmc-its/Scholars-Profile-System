/**
 * #3368: every home-page suggestion chip is a live OpenSearch query. With
 * Next's default viewport prefetch, all six fired on every home view
 * (~220k uncached searches/day on 2026-11-12). The chips must not prefetch.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const linkProps: Array<Record<string, unknown>> = [];
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    linkProps.push(props);
    return <a href={String(props.href)}>{props.children}</a>;
  },
}));

import { TrySuggestionsChips } from "@/components/home/try-suggestions-chips";

describe("TrySuggestionsChips", () => {
  it("renders search links with prefetch disabled", () => {
    render(<TrySuggestionsChips count={6} />);
    const searchLinks = linkProps.filter((p) => String(p.href).startsWith("/search"));
    expect(searchLinks.length).toBeGreaterThan(0);
    for (const p of searchLinks) expect(p.prefetch).toBe(false);
  });
});
