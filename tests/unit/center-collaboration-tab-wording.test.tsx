/**
 * The center Collaboration tab is a thin wrapper over the shared
 * `UnitCollaborationNetwork`; it must keep the center wording ("Programs",
 * "Show program:", "All programs") and its data URL. vis-network is never
 * reached — the graph container just stays empty in jsdom.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

vi.mock("vis-network/standalone", () => ({
  DataSet: class {
    add() {}
    clear() {}
  },
  Network: class {
    on() {}
    setOptions() {}
    stabilize() {}
    destroy() {}
  },
}));

import { CenterCollaborationTab } from "@/components/center/center-collaboration-tab";
import { DepartmentCollaborationTab } from "@/components/department/department-collaboration-tab";

const PAYLOAD = {
  programs: [
    { code: "P1", label: "Group One", color: "#0072B2" },
    { code: "P2", label: "Group Two", color: "#D55E00" },
  ],
  nodes: [
    { i: 0, cwid: "tst0001", name: "Ada Alpha", slug: "ada", programCode: "P1", pubCount: 3 },
    { i: 1, cwid: "tst0002", name: "Bo Beta", slug: "bo", programCode: "P1", pubCount: 2 },
  ],
  papers: [{ pmid: "1", year: 2024, m: [0, 1] }],
  awards: [],
  grantAxis: false,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe("collaboration tab wrappers", () => {
  it("center: fetches the center route and keeps the program wording", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <CenterCollaborationTab centerSlug="test_center" centerName="Test Center" />,
    );
    const view = within(container);
    expect(await view.findByText("Show program:")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/centers/test_center/collaboration");
    expect(view.getByRole("button", { name: "Programs" })).toBeTruthy();
    expect(view.getByRole("button", { name: "All programs" })).toBeTruthy();
    expect(container.textContent).toContain("links are within-program");
  });

  it("department: fetches the department route and speaks in divisions", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <DepartmentCollaborationTab deptSlug="test-dept" deptName="Department of Testing" />,
    );
    const view = within(container);
    expect(await view.findByText("Show division:")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/departments/test-dept/collaboration");
    expect(view.getByRole("button", { name: "Divisions" })).toBeTruthy();
    expect(view.getByRole("button", { name: "All divisions" })).toBeTruthy();
    expect(container.textContent).toContain(
      "links are within-division (cross-division collaboration is in the Divisions view)",
    );
    expect(container.textContent).not.toMatch(/program/i);
  });

  it("department: empty payload reads as the department empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ...PAYLOAD, nodes: [], papers: [] }) })),
    );
    const { container } = render(
      <DepartmentCollaborationTab deptSlug="test-dept" deptName="Department of Testing" />,
    );
    expect(
      await within(container).findByText(
        "Not enough co-authorship data yet to draw a collaboration network for this department.",
      ),
    ).toBeTruthy();
  });
});
