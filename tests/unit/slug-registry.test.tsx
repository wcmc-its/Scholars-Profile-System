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

// The row actions are a client island that calls `useRouter()`.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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
    ...over,
  };
}

describe("SlugRegistry — chrome + segments", () => {
  it("titles the page Profile URLs and renders the requests slot above the registry", () => {
    render(<SlugRegistry {...base({ requests: <div data-testid="mock-requests" /> })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Profile URLs");
    expect(screen.getByTestId("mock-requests")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Registry" })).toBeTruthy();
  });

  it("one /scholars/ input: a GET form that keeps the tab, with Clear when a query is set", () => {
    render(<SlugRegistry {...base({ segment: "override", query: "smith" })} />);
    const form = screen.getByTestId("slug-registry-search-form");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.querySelector("input[name=seg]")?.getAttribute("value")).toBe("override");
    expect((screen.getByTestId("slug-check-input") as HTMLInputElement).defaultValue).toBe("smith");
    expect(screen.getByTestId("slug-registry-clear").getAttribute("href")).toBe("/edit/slugs?seg=override");
  });

  it("tabs carry their match counts and keep the query", () => {
    render(<SlugRegistry {...base({ query: "smith", counts: { active: 12, historical: 3 } })} />);
    const live = screen.getByTestId("slug-segment-active");
    expect(live.textContent).toBe("Live12");
    expect(screen.getByTestId("slug-segment-historical").getAttribute("href")).toBe(
      "/edit/slugs?seg=historical&q=smith",
    );
    expect(screen.getByTestId("slug-segment-requested").textContent).toBe("Decided requests");
  });

  it("verdicts: available, taken by a live scholar, a redirect, and a CWID", () => {
    const { rerender } = render(
      <SlugRegistry {...base({ query: "free", verdict: { kind: "status", status: { state: "available", slug: "free" } } })} />,
    );
    expect(screen.getByTestId("slug-check-result").textContent).toBe("Available/free isn’t in use");
    rerender(
      <SlugRegistry
        {...base({
          query: "held",
          verdict: { kind: "status", status: { state: "taken", slug: "held", held: "live", cwid: "zzx0001", name: "Pat Example" } },
        })}
      />,
    );
    expect(screen.getByTestId("slug-check-result").textContent).toBe("TakenPat Example (zzx0001)");
    rerender(
      <SlugRegistry
        {...base({
          query: "old",
          verdict: {
            kind: "status",
            status: { state: "taken", slug: "old", held: "history", currentCwid: "zzx0002", currentSlug: "new" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("slug-check-result").textContent).toMatch(/^RedirectForwards to \/new/);
    rerender(
      <SlugRegistry
        {...base({ query: "zzx0003", verdict: { kind: "cwid", cwid: "zzx0003", name: "Lee Sample", slug: "lee-sample" } })}
      />,
    );
    expect(screen.getByTestId("slug-check-result").textContent).toBe("CWIDLee Sample is at /lee-sample");
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
    expect(screen.getByTestId("slug-registry-count").textContent).toMatch(/no matching urls/i);
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
  });

  it("one page of rows reads 'N shown', or 'N matching' with a query", () => {
    const rows = [{ slug: "a", cwid: "1", name: "A" }];
    const { rerender } = render(<SlugRegistry {...base({ rows, total: 1 })} />);
    expect(screen.getByTestId("slug-registry-count").textContent).toBe("1 shown");
    rerender(<SlugRegistry {...base({ rows, total: 1, query: "a" })} />);
    expect(screen.getByTestId("slug-registry-count").textContent).toBe("1 matching");
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

  it("active: extras add the department and mark a pinned URL", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "active",
          total: 2,
          rows: [
            { slug: "jane-smith", cwid: "js1", name: "Jane Smith" },
            { slug: "sam-doe", cwid: "sd1", name: "Sam Doe" },
          ],
          extras: { people: { js1: { name: "Jane Smith", department: "Medicine" } }, pinned: ["js1"], baseHolders: {} },
        })}
      />,
    );
    const pinned = screen.getByTestId("slug-row-jane-smith");
    expect(pinned.textContent).toContain("js1 · Medicine");
    expect(pinned.textContent).toContain("Pinned");
    expect(screen.getByTestId("slug-row-sam-doe").textContent).toContain("Auto");
  });

  it("collisions: says who holds the base URL, or that it is free", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "collisions",
          total: 2,
          rows: [
            { slug: "jane-smith-2", cwid: "js2", name: "Jane Smith" },
            { slug: "sam-doe-2", cwid: "sd2", name: "Sam Doe" },
          ],
          extras: {
            people: {},
            pinned: [],
            baseHolders: { "jane-smith": { cwid: "js1", name: "Jane Smith" }, "sam-doe": null },
          },
        })}
      />,
    );
    expect(screen.getByTestId("slug-row-jane-smith-2").textContent).toContain("Base held by Jane Smith (js1)");
    expect(screen.getByTestId("slug-row-sam-doe-2").textContent).toContain("Base is free");
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
    expect(screen.getByTestId("slug-status-r1").textContent).toBe("Denied");
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

describe("SlugRegistry — row actions", () => {
  it("Live: Pin on an auto row only, beside Edit; none on a pinned row", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "active",
          total: 2,
          rows: [
            { slug: "jane-smith", cwid: "js1", name: "Jane Smith" },
            { slug: "sam-doe", cwid: "sd1", name: "Sam Doe" },
          ],
          extras: { people: {}, pinned: ["js1"], baseHolders: {} },
        })}
      />,
    );
    expect(screen.getByTestId("slug-pin-sd1").textContent).toBe("Pin");
    expect(screen.queryByTestId("slug-pin-js1")).toBeNull();
    expect(screen.getByTestId("slug-edit-js1")).toBeTruthy();
    expect(screen.getByTestId("slug-edit-sd1")).toBeTruthy();
  });

  it("Pinned: Unpin beside Edit", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "override",
          total: 1,
          rows: [{ slug: "dr-doe", pinnedForCwid: "h1", setByCwid: "admin9", updatedAt: "2026-02-02T00:00:00.000Z" }],
        })}
      />,
    );
    const row = screen.getByTestId("slug-row-dr-doe");
    expect(screen.getByTestId("slug-unpin-h1").textContent).toBe("Unpin");
    expect(row.contains(screen.getByTestId("slug-edit-h1"))).toBe(true);
  });

  it("Redirects: Remove on every row", () => {
    render(
      <SlugRegistry
        {...base({
          segment: "historical",
          total: 1,
          rows: [
            {
              oldSlug: "old-live",
              currentSlug: "new-live",
              name: "Live",
              currentCwid: "c1",
              recordedAt: "2026-01-01T00:00:00.000Z",
              redirects: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("slug-remove-old-live").textContent).toBe("Remove");
  });

  it("Reserved and Collisions: no write action (built-in route words can't be released)", () => {
    const { rerender } = render(
      <SlugRegistry
        {...base({ segment: "reserved", total: 1, rows: [{ word: "about", reason: "Reserved route segment" }] })}
      />,
    );
    expect(screen.getByTestId("slug-row-about").querySelector("button")).toBeNull();
    expect(screen.getByText(/can’t be released here/)).toBeTruthy();
    rerender(
      <SlugRegistry
        {...base({ segment: "collisions", total: 1, rows: [{ slug: "jane-smith-2", cwid: "js2", name: "Jane Smith" }] })}
      />,
    );
    expect(screen.queryByTestId("slug-pin-js2")).toBeNull();
  });
});
