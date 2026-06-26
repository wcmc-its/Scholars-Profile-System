/**
 * #967 §7 (Variant 2) + rep-papers disclosure — PeopleResultCard reveals the
 * matched method FAMILY's (or topic's) representative papers via a CLICKABLE
 * chevron disclosure (replaces the old hover reveal):
 *   - the row is a stretched-link card: the NAME is the only <Link>, the chevron
 *     is a real <button> sitting above the stretched overlay;
 *   - clicking the chevron fetches /api/scholar/[cwid]/method-exemplar ONCE and
 *     renders the up-to-3 representative papers ({ pubs, total } shape);
 *   - a method/topic row whose fetch resolves with 0 papers degrades to a profile
 *     link (the badge guarantees the section exists), never a dead control;
 *   - non-method/non-topic evidence never fetches a method-exemplar.
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

/** Stub the lazy exemplar fetch with a `{ pubs, total }` payload. */
function mockFetch(payload: { pubs: unknown[]; total: number }) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The chevron disclosure button (its accessible name mentions "key papers"). */
const chevron = () => screen.getByRole("button", { name: /key papers/i });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const methodHit = makeHit({
  evidence: { kind: "method", family: "Confocal microscopy", tools: ["CCM"] },
});

describe("PeopleResultCard — stretched-link structure", () => {
  it("the NAME is the only <Link>, and the disclosure is a real <button>", () => {
    mockFetch({ pubs: [], total: 0 });
    const { container } = render(<PeopleResultCard {...props} hit={methodHit} />);
    const links = container.querySelectorAll("a");
    // exactly one link — the stretched name link to the profile.
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain("Jane Doe");
    expect(links[0].className).toContain("after:absolute");
    // the disclosure chevron is a button (keyboard-operable), not a link.
    expect(chevron()).toBeTruthy();
  });
});

describe("PeopleResultCard — method/topic rep-papers disclosure (click)", () => {
  it("fetches once on the FIRST expand click and reveals the representative papers", async () => {
    const fetchFn = mockFetch({
      pubs: [
        { pmid: "123", title: "A confocal study of the cornea", year: 2021 },
        { pmid: "124", title: "Another confocal study", year: 2020 },
      ],
      total: 7,
    });
    render(<PeopleResultCard {...props} hit={methodHit} />);

    fireEvent.click(chevron()); // open
    await waitFor(() => expect(screen.getByText(/A confocal study of the cornea/)).toBeTruthy());
    expect(screen.getByText(/\(2021\)/)).toBeTruthy();
    // total (7) > shown (2) ⇒ "+5 more in profile".
    expect(screen.getByText(/\+5 more in profile/)).toBeTruthy();

    // collapse + re-open must NOT re-fetch (fetch is once, cached in a ref).
    fireEvent.click(chevron()); // close
    fireEvent.click(chevron()); // re-open
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The active query rides along as `&q=` so the loader can prefer + highlight
    // title-matching papers.
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/scholar/abc1234/method-exemplar?family=Confocal%20microscopy&q=confocal%20microscopy",
    );
  });

  it("degrades to a profile link (not a dead control) when a METHOD fetch resolves with 0 papers", async () => {
    mockFetch({ pubs: [], total: 0 });
    render(<PeopleResultCard {...props} hit={methodHit} />);

    fireEvent.click(chevron());
    // once the empty fetch resolves the panel shows a methods & tools profile link
    // instead of retracting the chevron.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /view their methods & tools/i })).toBeTruthy(),
    );
    expect(chevron()).toBeTruthy(); // chevron NOT dropped
  });

  it("degrades to a research-areas link when a TOPIC fetch resolves with 0 papers", async () => {
    mockFetch({ pubs: [], total: 0 });
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: { kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
        })}
      />,
    );

    fireEvent.click(chevron());
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /view their research areas/i })).toBeTruthy(),
    );
  });

  it("fetches with ?topic= and reveals for topic evidence", async () => {
    const fetchFn = mockFetch({
      pubs: [{ pmid: "77", title: "A single-cell atlas of the cortex", year: 2023 }],
      total: 1,
    });
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: { kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
        })}
      />,
    );

    fireEvent.click(chevron());
    await waitFor(() => expect(screen.getByText(/A single-cell atlas of the cortex/)).toBeTruthy());
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/scholar/abc1234/method-exemplar?topic=single_cell_spatial_biology&q=confocal%20microscopy",
    );
  });
});

describe("PeopleResultCard — non-method/topic evidence never fetches a method-exemplar", () => {
  it("publications evidence with inline pubs renders the stack from the hit, no fetch", async () => {
    const fetchFn = mockFetch({ pubs: [{ pmid: "1", title: "x", year: 2020 }], total: 1 });
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: {
            kind: "publications",
            strength: "mention",
            text: "2 of 100 publications mention “confocal”",
            count: 2,
            pubs: [
              { pmid: "5", title: "Inline mention paper one", year: 2022 },
              { pmid: "6", title: "Inline mention paper two", year: 2021 },
            ],
          },
        })}
      />,
    );

    fireEvent.click(chevron());
    await waitFor(() => expect(screen.getByText(/Inline mention paper one/)).toBeTruthy());
    expect(screen.getByText(/Inline mention paper two/)).toBeTruthy();
    // inline pubs ⇒ NO method-exemplar fetch.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a publications match with no pubs offers no chevron and never fetches", async () => {
    const fetchFn = mockFetch({ pubs: [], total: 0 });
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          evidence: { kind: "publications", strength: "tagged", text: "5 of 9 publications tagged X", count: 5 },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /key papers/i })).toBeNull();
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
