import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=publications"),
}));
vi.mock("@/components/department/publication-card", () => ({
  PublicationCard: ({ pub }: { pub: { pmid: string } }) => <div data-testid="card">{pub.pmid}</div>,
}));

import { DeptPublicationsList } from "@/components/department/dept-publications-list";

const HIT = {
  pmid: "1",
  title: "A paper",
  journal: "J",
  year: 2024,
  citationCount: 0,
  doi: null,
  pubmedUrl: null,
  authors: [],
};
const base = { page: 1, pageSize: 20, sort: "newest" as const, basePath: "/departments/x" };

describe("DeptPublicationsList, Stage select", () => {
  it("shows the Stage select beside Sort when the flag is on", () => {
    render(<DeptPublicationsList {...base} hits={[HIT]} total={1} stageFilter stage="T2" />);
    const trigger = screen.getByRole("combobox", { name: "Translational stage" });
    expect(trigger.textContent).toContain("T2 \u00b7 Clinical trials and efficacy");
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeTruthy();
  });

  it("flag off: no Stage select", () => {
    render(<DeptPublicationsList {...base} hits={[HIT]} total={1} />);
    expect(screen.queryByRole("combobox", { name: "Translational stage" })).toBeNull();
  });

  it("a picked stage with no papers keeps the select so it can be undone", () => {
    render(<DeptPublicationsList {...base} hits={[]} total={0} stageFilter stage="T1" />);
    expect(screen.getByRole("combobox", { name: "Translational stage" })).toBeTruthy();
    expect(screen.getByText("No publications at this stage.")).toBeTruthy();
  });

  it("no stage and no papers: the plain empty state, no select", () => {
    render(<DeptPublicationsList {...base} hits={[]} total={0} stageFilter />);
    expect(screen.queryByRole("combobox", { name: "Translational stage" })).toBeNull();
    expect(screen.getByText("No publications listed.")).toBeTruthy();
  });
});
