/**
 * `components/edit/slug-registry.tsx` — the slug-registry table (#497). Tests
 * the segment selector visibility (requested gated, slug tab always present),
 * the per-segment column rendering, the dead-end badge, the count line, and
 * pagination links. The availability-checker island + sub-nav are mocked.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/edit/admin-subnav", () => ({
  AdminSubnav: (p: { active: string }) => <div data-testid="mock-subnav" data-active={p.active} />,
}));
vi.mock("@/components/edit/slug-availability-checker", () => ({
  SlugAvailabilityChecker: () => <div data-testid="mock-checker" />,
}));

import { SlugRegistry } from "@/components/edit/slug-registry";
import type { SlugRegistryProps } from "@/components/edit/slug-registry";

function base(over: Partial<SlugRegistryProps> = {}): SlugRegistryProps {
  return {
    segment: "active",
    rows: [],
    total: 0,
    query: "",
    page: 0,
    pageSize: 50,
    requestedSegmentVisible: true,
    pendingSlugRequests: 2,
    administratorsTab: null,
    ...over,
  };
}

describe("SlugRegistry — chrome + segments", () => {
  it("renders the sub-nav active on 'slugs' and the availability checker", () => {
    render(<SlugRegistry {...base()} />);
    expect(screen.getByTestId("mock-subnav").getAttribute("data-active")).toBe("slugs");
    expect(screen.getByTestId("mock-checker")).toBeTruthy();
  });

  it("shows all six segment tabs when the requested segment is visible", () => {
    render(<SlugRegistry {...base({ requestedSegmentVisible: true })} />);
    for (const s of ["active", "historical", "override", "reserved", "requested", "collisions"]) {
      expect(screen.getByTestId(`slug-segment-${s}`)).toBeTruthy();
    }
  });

  it("hides the requested segment tab when the slug-request feature is off", () => {
    render(<SlugRegistry {...base({ requestedSegmentVisible: false })} />);
    expect(screen.queryByTestId("slug-segment-requested")).toBeNull();
    // the slug tab itself is always present (collisions still shown)
    expect(screen.getByTestId("slug-segment-collisions")).toBeTruthy();
  });

  it("marks the active segment with aria-current and links the others", () => {
    render(<SlugRegistry {...base({ segment: "historical" })} />);
    expect(screen.getByTestId("slug-segment-historical").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("slug-segment-active").getAttribute("href")).toBe("/edit/slugs");
  });
});

describe("SlugRegistry — count + empty state", () => {
  it("shows the count range when there are rows", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "active",
          rows: [{ slug: "a", cwid: "1", name: "A" }],
          total: 137,
          page: 1,
        })}
      />,
    );
    // page 1, pageSize 50 → 51–51 (one row) of 137
    expect(screen.getByTestId("slug-registry-count").textContent).toMatch(/51.*of 137/);
  });

  it("shows the no-matches line when total is 0", () => {
    render(<SlugRegistry {...base()} />);
    expect(screen.getByTestId("slug-registry-count").textContent).toMatch(/no matching slugs/i);
  });
});

describe("SlugRegistry — per-segment columns", () => {
  it("active: slug, scholar, cwid, public + edit links", () => {
    render(
      <SlugRegistry
        {...base({ segment: "active", rows: [{ slug: "jane-smith", cwid: "js1", name: "Jane Smith" }], total: 1 })}
      />,
    );
    const row = screen.getByTestId("slug-row-jane-smith");
    expect(row.textContent).toContain("jane-smith");
    expect(row.textContent).toContain("Jane Smith");
    expect(screen.getByTestId("slug-public-jane-smith").getAttribute("href")).toBe("/scholars/jane-smith");
    expect(screen.getByTestId("slug-edit-js1").getAttribute("href")).toBe("/edit/scholar/js1");
  });

  it("historical: redirect badge for live current, dead-end badge for soft-deleted", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "historical",
          total: 2,
          rows: [
            {
              oldSlug: "old-live",
              currentSlug: "new-live",
              name: "Live",
              currentCwid: "c1",
              recordedAt: "2026-01-01T00:00:00.000Z",
              redirects: true,
            },
            {
              oldSlug: "old-dead",
              currentSlug: "gone",
              name: "Gone",
              currentCwid: "c2",
              recordedAt: "2025-01-01T00:00:00.000Z",
              redirects: false,
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("slug-redirect-old-live")).toBeTruthy();
    expect(screen.getByTestId("slug-deadend-old-dead").textContent).toMatch(/dead-end/i);
  });

  it("override: slug, pinned-for, set-by", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "override",
          total: 1,
          rows: [{ slug: "pinned", pinnedForCwid: "h1", setByCwid: "admin9", updatedAt: "2026-02-02T00:00:00.000Z" }],
        })}
      />,
    );
    const row = screen.getByTestId("slug-row-pinned");
    expect(row.textContent).toContain("pinned");
    expect(row.textContent).toContain("h1");
    expect(row.textContent).toContain("admin9");
  });

  it("reserved: word + reason, plus the lib/slug.ts note", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "reserved",
          total: 1,
          rows: [{ word: "about", reason: "Reserved route segment" }],
        })}
      />,
    );
    expect(screen.getByTestId("slug-row-about").textContent).toContain("about");
    expect(screen.getByText(/lib\/slug\.ts/)).toBeTruthy();
  });

  it("requested: requested slug, for-cwid, status badge, decision", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "requested",
          total: 1,
          rows: [
            {
              id: "r1",
              requestedSlug: "want-this",
              forCwid: "c1",
              status: "rejected",
              requestedByCwid: "c1",
              requestedAt: "2026-03-03T00:00:00.000Z",
              decidedByCwid: "admin1",
              decidedAt: "2026-03-04T00:00:00.000Z",
              decisionNote: "namesake collision",
            },
          ],
        })}
      />,
    );
    const row = screen.getByTestId("slug-row-r1");
    expect(row.textContent).toContain("want-this");
    expect(screen.getByTestId("slug-status-r1").textContent).toBe("rejected");
    expect(row.textContent).toContain("namesake collision");
  });
});

describe("SlugRegistry — pagination", () => {
  it("renders prev/next preserving the segment and query", () => {
    render(
      <SlugRegistry
        {...base({ segment: "historical", query: "smith", page: 1, total: 200, rows: [
          { oldSlug: "x", currentSlug: "y", name: "N", currentCwid: "c", recordedAt: "2026-01-01T00:00:00.000Z", redirects: true },
        ] })}
      />,
    );
    expect(screen.getByTestId("slug-registry-prev").getAttribute("href")).toBe(
      "/edit/slugs?seg=historical&q=smith",
    );
    expect(screen.getByTestId("slug-registry-next").getAttribute("href")).toBe(
      "/edit/slugs?seg=historical&q=smith&page=2",
    );
  });

  it("omits pagination when everything fits on one page", () => {
    render(<SlugRegistry {...base({ total: 1, rows: [{ slug: "a", cwid: "1", name: "A" }] })} />);
    expect(screen.queryByTestId("slug-registry-prev")).toBeNull();
    expect(screen.queryByTestId("slug-registry-next")).toBeNull();
  });
});
