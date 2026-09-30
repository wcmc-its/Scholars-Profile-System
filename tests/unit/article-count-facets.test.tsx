/**
 * `components/edit/reports/article-count-facets.tsx` — report 8's Profiles
 * facets inside the report's `AutoSubmitForm`. A toggle submits the form
 * exactly once, AFTER the hidden inputs carry the new selection; typing in a
 * facet search box never submits; a memberless center is hidden. Assertions
 * are scoped to the island's / form's own testid.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ArticleCountFacets } from "@/components/edit/reports/article-count-facets";

const FACETS = {
  roleCategories: [{ value: "postdoc", label: "Postdoc", count: 3 }],
  departments: [
    { value: "dept:MED", label: "Medicine", count: 9, divisions: [{ value: "div:CARD", label: "Cardiology (Medicine)", count: 4 }] },
  ],
  centers: [
    { value: "center:CC", label: "Cancer Center", count: 2 },
    { value: "center:EMPTY", label: "Empty Center", count: 0 },
  ],
  // 11 > collapseAfter (10) → the facet renders its search box.
  institutions: Array.from({ length: 11 }, (_, i) => ({ value: `inst:I${i}`, label: `Institution ${i}`, count: 1 })),
};

const original = HTMLFormElement.prototype.requestSubmit;
afterEach(() => {
  HTMLFormElement.prototype.requestSubmit = original;
});

describe("ArticleCountFacets", () => {
  it("submits once per toggle with the NEW selection; a facet search never submits", () => {
    const submitted: string[][] = [];
    HTMLFormElement.prototype.requestSubmit = vi.fn(function (this: HTMLFormElement) {
      submitted.push(new FormData(this).getAll("unit").map(String));
    });
    render(
      <AutoSubmitForm action="/edit/reports/article-count" data-testid="filters">
        <ArticleCountFacets facets={FACETS} types={[]} units={["dept:MED"]} />
      </AutoSubmitForm>,
    );
    const form = screen.getByTestId("filters");
    const island = within(screen.getByTestId("article-count-facets"));
    expect(island.queryByText("Empty Center")).toBeNull();
    expect(island.getByText("Cancer Center")).toBeTruthy();

    fireEvent.change(island.getByLabelText("Search Institution"), { target: { value: "Institution 1" } });
    expect(submitted).toEqual([]);

    fireEvent.click(island.getByText("Cancer Center"));
    expect(submitted).toEqual([["dept:MED", "center:CC"]]);
    fireEvent.click(island.getByText("Medicine"));
    expect(submitted).toEqual([["dept:MED", "center:CC"], ["center:CC"]]);
    expect(new FormData(form as HTMLFormElement).getAll("type")).toEqual([]);
  });
});
