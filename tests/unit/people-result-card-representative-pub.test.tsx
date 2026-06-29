/**
 * Issue #967 — PeopleResultCard renders the representative-pub clause inside the
 * reason line: highlighted title when `titleHtml` is present, plain title +
 * year otherwise, and nothing extra when `matchReason.pub` is absent.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// HeadshotAvatar pulls images/network; stub it so the test asserts only the text.
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
    pubCount: 372,
    grantCount: 11,
    hasActiveGrants: true,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...overrides,
  };
}

const props = {
  position: 0,
  q: "hiv",
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

describe("PeopleResultCard — #967 representative-pub clause", () => {
  it("renders the highlighted title + year after the count when titleHtml is present", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: {
            icon: "publications",
            text: "14 of 372 publications tagged HIV",
            pub: {
              pmid: "1",
              title: "Broadly neutralizing antibodies for HIV-1 prevention",
              titleHtml: "Broadly neutralizing antibodies for <mark>HIV</mark>-1 prevention",
              year: 2024,
            },
          },
        })}
      />,
    );
    expect(screen.getByText(/14 of 372 publications tagged HIV/)).toBeTruthy();
    // #1361 — HighlightedSnippet now renders the <mark> as the light-red pill (a
    // real <mark>), unified with publication/grant titles.
    expect(screen.getByText("HIV").tagName).toBe("MARK");
    expect(screen.getByText(/Broadly neutralizing antibodies for/)).toBeTruthy();
    expect(screen.getByText(/\(2024\)/)).toBeTruthy();
  });

  it("renders the plain title when there is no titleHtml (descriptor-tagged, no literal term)", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: {
            icon: "publications",
            text: "14 of 372 publications tagged HIV",
            pub: { pmid: "2", title: "Antiretroviral therapy outcomes", year: 2019 },
          },
        })}
      />,
    );
    expect(screen.getByText(/Antiretroviral therapy outcomes/)).toBeTruthy();
    expect(screen.getByText(/\(2019\)/)).toBeTruthy();
    expect(screen.queryByText("HIV", { selector: "strong" })).toBeNull();
  });

  it("renders the bare count line (no incl. clause) when matchReason has no pub", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { icon: "publications", text: "14 of 372 publications tagged HIV" },
        })}
      />,
    );
    expect(screen.getByText(/14 of 372 publications tagged HIV/)).toBeTruthy();
    expect(screen.queryByText(/incl\./)).toBeNull();
  });

  it("omits the year suffix when the representative pub has no year", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: {
            icon: "publications",
            text: "5 of 100 publications mention “crispr”",
            pub: { pmid: "3", title: "A CRISPR screen" },
          },
        })}
      />,
    );
    expect(screen.getByText(/A CRISPR screen/)).toBeTruthy();
    expect(screen.queryByText(/\(\d{4}\)/)).toBeNull();
  });
});
