/**
 * `components/edit/reports/article-count-body.tsx` — report 8's rail layout:
 * desktop rail below `lg` hidden, the phone `FiltersSheet` trigger counting the
 * active filters, the sheet's copy of the rail with its own DOM ids and its own
 * GET form (a toggle there submits THAT form), and the "people, not articles"
 * note under the facets. Assertions are scoped to the rendered body and the
 * sheet dialog, never `document.body`.
 */
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ choices: vi.fn(), counts: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/article-count-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/article-count-report")>()),
  loadArticleCountChoices: h.choices,
  loadArticleCounts: h.counts,
}));

import { renderArticleCountReport } from "@/components/edit/reports/article-count-body";

const FACETS = {
  roleCategories: [{ value: "postdoc", label: "Postdoc", count: 3 }],
  departments: [{ value: "dept:MED", label: "Medicine", count: 9, divisions: [] }],
  centers: [{ value: "center:CC", label: "Cancer Center", count: 2 }],
  institutions: [{ value: "inst:I1", label: "Institution 1", count: 1 }],
};
const BASE = "/edit/reports/article-count";

const original = HTMLFormElement.prototype.requestSubmit;
beforeEach(() => {
  h.choices.mockResolvedValue({ facets: FACETS, atypes: ["Review", "Article"] });
  h.counts.mockResolvedValue({ rows: [{ year: 2026, count: 7 }], total: 7 });
});
afterEach(() => {
  HTMLFormElement.prototype.requestSubmit = original;
});

async function renderBody(searchParams: Record<string, string | string[]>) {
  const { main } = await renderArticleCountReport({ searchParams, basePath: BASE } as Parameters<
    typeof renderArticleCountReport
  >[0]);
  return render(<div data-testid="body">{main}</div>);
}

describe("report 8 body — rail, phone sheet, facets note", () => {
  it('counts active filters on the trigger; plain "Filters" on defaults', async () => {
    const filtered = await renderBody({
      type: "postdoc",
      unit: ["dept:MED", "center:CC"],
      pos: "first",
    });
    const trigger = within(filtered.getByTestId("body")).getByTestId(
      "article-count-filters-sheet-trigger",
    );
    expect(trigger.textContent).toBe("Filters (4)");
    expect(trigger.className).toContain("lg:hidden");
    filtered.unmount();

    const bare = await renderBody({});
    expect(
      within(bare.getByTestId("body")).getByTestId("article-count-filters-sheet-trigger")
        .textContent,
    ).toBe("Filters");
  });

  it("desktop rail is lg-only, carries the people-not-articles note under the facets", async () => {
    const { getByTestId } = await renderBody({});
    const rail = within(getByTestId("body")).getByTestId("article-count-rail");
    expect(rail.className).toContain("hidden lg:block");
    expect(rail.className).not.toMatch(/\bmd:/);
    const note = within(rail).getByTestId("article-count-facets-note");
    expect(note.textContent).toBe("Counts are active people, not articles.");
    expect(note.className).toContain("text-[11px]");
    // Directly after the who-filter facets.
    expect(note.previousElementSibling?.getAttribute("data-testid")).toBe("article-count-facets");
  });

  it("the sheet copy has its own form id, no id is shared, and a toggle there submits the sheet's form", async () => {
    const submitted: HTMLFormElement[] = [];
    HTMLFormElement.prototype.requestSubmit = vi.fn(function (this: HTMLFormElement) {
      submitted.push(this);
    });
    const { getByTestId, getByRole } = await renderBody({ unit: "dept:MED" });
    const body = getByTestId("body");
    fireEvent.click(within(body).getByTestId("article-count-filters-sheet-trigger"));
    const dialog = getByRole("dialog");

    const railForm = within(within(body).getByTestId("article-count-rail")).getByTestId(
      "article-count-filters",
    ) as HTMLFormElement;
    const sheetForm = within(dialog).getByTestId("article-count-filters") as HTMLFormElement;
    expect(railForm.id).toBe("article-count-filters");
    expect(sheetForm.id).toBe("article-count-filters-sheet");
    for (const f of [railForm, sheetForm]) {
      expect(f.getAttribute("action")).toBe(BASE);
      expect(f.getAttribute("method")).toBe("get");
    }
    const ids = [...body.querySelectorAll("[id]"), ...dialog.querySelectorAll("[id]")].map(
      (e) => e.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // Any control that joins a form by id must name its own copy's form.
    for (const el of dialog.querySelectorAll("[form]"))
      expect(el.getAttribute("form")).toBe(sheetForm.id);
    for (const el of body.querySelectorAll("[form]"))
      expect(el.getAttribute("form")).toBe(railForm.id);

    fireEvent.click(
      within(within(dialog).getByTestId("article-count-facets")).getByText("Cancer Center"),
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(sheetForm);
    expect(new FormData(sheetForm).getAll("unit")).toEqual(["dept:MED", "center:CC"]);
    // The rail's own selection is untouched.
    expect(new FormData(railForm).getAll("unit")).toEqual(["dept:MED"]);
    // The note rides along in the sheet copy too.
    expect(within(dialog).getByTestId("article-count-facets-note")).toBeTruthy();
  });
});
