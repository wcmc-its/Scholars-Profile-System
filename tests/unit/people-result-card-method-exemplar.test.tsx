/**
 * #967 §7 (Variant 2) — PeopleResultCard lazily reveals the matched method
 * FAMILY's representative paper on row hover/focus:
 *   - hovering a method-evidence row fetches /api/scholar/[cwid]/method-exemplar
 *     ONCE and renders "Representative paper: <title> (year)";
 *   - a row with no qualifying paper renders nothing (omitted, not blank);
 *   - non-method evidence never fetches and never shows the line;
 *   - the reveal stays inside the single row <Link> (no nested interactive el).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PeopleHit>): PeopleHit {
  return {
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Medicine",
    deptName: "Medicine",
    divisionName: null,
    roleCategory: "full_time_faculty",
    pubCount: 100,
    grantCount: 5,
    hasActiveGrants: true,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...overrides,
  };
}

const props = {
  position: 0,
  q: "confocal microscopy",
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

function mockFetch(pub: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pub }) });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const methodHit = makeHit({
  evidence: { kind: "method", family: "Confocal microscopy", tools: ["CCM"] },
});

describe("PeopleResultCard — method-exemplar hover", () => {
  it("fetches once on hover and reveals the representative paper", async () => {
    const fetchFn = mockFetch({ pmid: "123", title: "A confocal study of the cornea", year: 2021 });
    const { container } = render(<PeopleResultCard {...props} hit={methodHit} />);
    const row = container.querySelector("a")!;

    fireEvent.mouseEnter(row);
    fireEvent.mouseEnter(row); // second hover must NOT re-fetch

    await waitFor(() =>
      expect(screen.getByText(/A confocal study of the cornea/)).toBeTruthy(),
    );
    expect(screen.getByText(/Representative paper:/)).toBeTruthy();
    expect(screen.getByText(/\(2021\)/)).toBeTruthy();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/scholar/abc1234/method-exemplar?family=Confocal%20microscopy",
    );
  });

  it("renders nothing when the family has no qualifying paper", async () => {
    const fetchFn = mockFetch(null);
    const { container } = render(<PeopleResultCard {...props} hit={methodHit} />);
    fireEvent.mouseEnter(container.querySelector("a")!);

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/finding a representative paper/)).toBeNull());
    expect(screen.queryByText(/Representative paper:/)).toBeNull();
  });

  it("fetches with ?topic= and reveals for topic evidence", async () => {
    const fetchFn = mockFetch({ pmid: "77", title: "A single-cell atlas of the cortex", year: 2023 });
    const { container } = render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: { kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
        })}
      />,
    );
    fireEvent.mouseEnter(container.querySelector("a")!);

    await waitFor(() => expect(screen.getByText(/A single-cell atlas of the cortex/)).toBeTruthy());
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/scholar/abc1234/method-exemplar?topic=single_cell_spatial_biology",
    );
  });

  it("does not fetch or reveal for non-method/non-topic evidence", async () => {
    const fetchFn = mockFetch({ pmid: "1", title: "x", year: 2020 });
    const { container } = render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: { kind: "publications", strength: "tagged", text: "5 of 9 publications tagged X" },
        })}
      />,
    );
    fireEvent.mouseEnter(container.querySelector("a")!);

    // Give any stray microtask a chance, then assert no fetch happened.
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.queryByText(/Representative paper:/)).toBeNull();
  });

  it("keeps the reveal inside the single row Link (no nested interactive element)", async () => {
    mockFetch({ pmid: "123", title: "A confocal study", year: 2021 });
    const { container } = render(<PeopleResultCard {...props} hit={methodHit} />);
    fireEvent.mouseEnter(container.querySelector("a")!);
    await waitFor(() => expect(screen.getByText(/A confocal study/)).toBeTruthy());

    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
