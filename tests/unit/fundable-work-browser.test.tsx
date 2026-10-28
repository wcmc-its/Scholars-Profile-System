/**
 * The fundable-work browse rail: the score floor, a facet tick, the search box
 * and the CSV export. The facet counts are the part worth pinning — they are
 * computed with that facet's own selection left out, so ticking one option
 * must not drive its siblings to 0.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { FundableWorkBrowser, toCsv, type FundableWorkRow } from "@/components/edit/fundable-work-browser";

const row = (over: Partial<FundableWorkRow> & { id: string }): FundableWorkRow => ({
  type: "conference-abstract",
  title: `Title ${over.id}`,
  url: "https://example.org/x",
  venue: "Cancer Research",
  date: "2026-06-01",
  score: 4,
  stage: "preclinical",
  modality: "Small molecule",
  rationale: "Rationale text.",
  pitch: "Pitch text.",
  abstract: "Abstract text.",
  funders: [{ name: "Bayer", kind: "pharma", why: "Prostate franchise." }],
  authors: [{ cwid: "aaa1001", name: "Jane Doe", slug: "jane-doe", department: "Medicine", position: "last", isPostdoc: false }],
  ...over,
});

const ROWS: FundableWorkRow[] = [
  row({ id: "w1", score: 5, title: "Degrader study" }),
  row({ id: "w2", score: 4, type: "preprint", venue: "bioRxiv", title: "Vaccine antigen study" }),
  row({ id: "w3", score: 2, title: "Low scoring study" }),
];

const results = () => screen.getByText(/results?$/i).parentElement!.textContent ?? "";

describe("FundableWorkBrowser", () => {
  it("hides work below the score floor and restores it when the floor drops", () => {
    render(<FundableWorkBrowser rows={ROWS} truncated={false} />);
    expect(screen.queryByText("Low scoring study")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1+" }));
    expect(screen.getByText("Low scoring study")).toBeTruthy();
  });

  it("filters on a facet tick and counts the other options in that group independently", () => {
    render(<FundableWorkBrowser rows={ROWS} truncated={false} />);
    const preprint = screen.getByRole("checkbox", { name: "Type: Preprint" });
    fireEvent.click(preprint);
    expect(screen.getByText("Vaccine antigen study")).toBeTruthy();
    expect(screen.queryByText("Degrader study")).toBeNull();
    // The sibling option still counts its own row — not 0 — because the group's
    // own selection is excluded from its counts.
    const abstractOption = screen.getByRole("checkbox", { name: "Type: Abstract" }).closest("label")!;
    expect(within(abstractOption).getByText("1")).toBeTruthy();
  });

  it("searches titles, people and funders", () => {
    render(<FundableWorkBrowser rows={ROWS} truncated={false} />);
    fireEvent.change(screen.getByLabelText("Search fundable work"), { target: { value: "bayer vaccine" } });
    expect(results()).toContain("1");
    expect(screen.getByText("Vaccine antigen study")).toBeTruthy();
  });

  it("opens the pitch and the abstract on demand", () => {
    render(<FundableWorkBrowser rows={[ROWS[0]]} truncated={false} />);
    expect(screen.queryByText("Pitch text.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pitch & 1 funders" }));
    expect(screen.getByText("Pitch text.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Full abstract" }));
    expect(screen.getByText("Abstract text.")).toBeTruthy();
  });

  it("exports names and departments but never a cwid", () => {
    const csv = toCsv(ROWS);
    expect(csv.split("\n")).toHaveLength(4);
    expect(csv).toContain('"Jane Doe (Medicine)"');
    expect(csv).toContain('"Bayer [pharma]"');
    expect(csv).not.toContain("aaa1001");
  });

  it("escapes quotes in the CSV", () => {
    expect(toCsv([row({ id: "w9", title: 'A "quoted" title' })])).toContain('"A ""quoted"" title"');
  });
});
