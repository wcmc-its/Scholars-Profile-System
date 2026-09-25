/**
 * Report 8's rail islands inside the body's `AutoSubmitForm`:
 * - `ReportFacetList`: a tick submits (a native change); typing in its search
 *   never does; a selection past the collapse stays rendered (so it submits).
 * - `JifField`: a segment submits once with the new hidden `jif`; the exact
 *   box submits on Enter / blur, never per keystroke.
 * - `CwidListField`: the paste is parsed live (non-CWIDs named, skipped);
 *   Apply stores the list and submits `list=<id>`; Remove submits without it.
 * Assertions are scoped to each render's container.
 */
import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { CwidListField } from "@/components/edit/reports/cwid-list-field";
import { JifField } from "@/components/edit/reports/jif-field";
import { ReportFacetList } from "@/components/edit/reports/report-facet-list";

const original = HTMLFormElement.prototype.requestSubmit;
let submitted: FormData[] = [];
beforeEach(() => {
  submitted = [];
  HTMLFormElement.prototype.requestSubmit = vi.fn(function (this: HTMLFormElement) {
    submitted.push(new FormData(this));
  });
});
afterEach(() => {
  HTMLFormElement.prototype.requestSubmit = original;
  vi.unstubAllGlobals();
});

const inForm = (node: React.ReactNode) => render(<AutoSubmitForm data-testid="form">{node}</AutoSubmitForm>);

describe("ReportFacetList", () => {
  const OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: `dept:D${i}`, label: `Dept ${i}`, count: 12 - i }));

  it("a tick submits the new selection; search typing does not; a selection past the collapse stays", () => {
    const { container } = inForm(
      <ReportFacetList name="unit" options={OPTIONS} selected={["dept:D11"]} collapseAfter={8} searchPlaceholder="Search departments…" countsLabel="People" />,
    );
    const q = within(container);
    // 8 shown + the selected 12th.
    expect(q.getAllByRole("checkbox")).toHaveLength(9);
    expect(q.getByText("Show all 12")).toBeTruthy();
    fireEvent.change(q.getByRole("searchbox"), { target: { value: "Dept 1" } });
    expect(submitted).toHaveLength(0);
    fireEvent.change(q.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(q.getByRole("checkbox", { name: /Dept 0/ }));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].getAll("unit")).toEqual(["dept:D0", "dept:D11"]);
  });
});

describe("JifField", () => {
  it("a segment submits once with the new minimum", () => {
    const { container } = inForm(<JifField defaultValue={0} max={100} />);
    const q = within(container);
    expect(q.getByRole("button", { name: "Any" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(q.getByRole("button", { name: "≥ 10" }));
    expect(submitted.map((f) => f.get("jif"))).toEqual(["10"]);
  });

  it("the exact box submits on Enter or blur, one decimal, never per keystroke", () => {
    const { container } = inForm(<JifField defaultValue={0} max={100} />);
    const box = within(container).getByTestId("jif-exact");
    fireEvent.change(box, { target: { value: "7" } });
    fireEvent.change(box, { target: { value: "7.46" } });
    expect(submitted).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(submitted.map((f) => f.get("jif"))).toEqual(["7.5"]);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    expect(submitted.map((f) => f.get("jif"))).toEqual(["7.5", "0"]);
  });
});

describe("CwidListField", () => {
  it("parses the paste live, applies the valid CWIDs, then submits list=<id>", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, id: "NewList12345", count: 2 }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = inForm(<CwidListField applied={null} />);
    const q = within(container);
    fireEvent.change(q.getByRole("textbox", { name: "CWIDs" }), { target: { value: "ABC1234, def5678\n12" } });
    expect(submitted).toHaveLength(0);
    expect(q.getByTestId("cwid-list-parsed").textContent).toBe("2 CWIDs · 1 skipped (not CWIDs): 12");
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "Apply list" }));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/edit/reports/article-count/cwid-list", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "abc1234 def5678" }) }));
    expect(submitted.map((f) => f.get("list"))).toEqual(["NewList12345"]);
  });

  it("Remove list submits without the list", () => {
    const { container } = inForm(<CwidListField applied={{ id: "Old123456789", found: true, count: 3, unmatched: [] }} />);
    const q = within(container);
    expect(q.getByTestId("cwid-list-counts").textContent).toBe("3 CWIDs · 3 matched");
    fireEvent.click(q.getByRole("button", { name: "Remove list" }));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].has("list")).toBe(false);
  });
});
