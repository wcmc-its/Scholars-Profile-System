/**
 * `components/edit/report-access-popover.tsx` — the report header's access
 * badge ("Who can open this report"): the default audience plus "+ N others",
 * a read-only list, and "Manage access" for a manager, which opens the Edit
 * details sheet. It never edits. Also `useReportAccessRows`, the sheet's
 * Add / Remove round-trip (server truth, no optimistic overlay), and
 * `accessSummary`, the one string source the index row shares.
 *
 * Radix Popover portals its content to `document.body`, so the trigger is
 * clicked and the content is then found through `screen`, scoped by the
 * component's own testids — never `document.body` at large.
 */
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accessSummary,
  ReportAccessPopover,
  useReportAccessRows,
  type ReportAccessPopoverRow,
} from "@/components/edit/report-access-popover";

const ROW: ReportAccessPopoverRow = {
  reportKey: "mentored-publications",
  scopeKey: "md",
  cwid: "usr0001",
  granteeName: "Captured Name",
  name: "Curated Name",
  grantedBy: "adm0001",
  grantedAt: "2026-09-18T12:00:00.000Z",
};
const NEW_ROW: ReportAccessPopoverRow = {
  ...ROW,
  cwid: "stf0001",
  granteeName: "Staff Person",
  name: "Staff Person",
  scopeKey: "*",
};
const SCOPES: ReadonlyArray<readonly [string, string]> = [
  ["*", "All programs"],
  ["md", "MD"],
  ["mdphd", "MD-PhD"],
  ["ecr", "ECR"],
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Click the trigger and hand back the portalled content. */
function open(): HTMLElement {
  fireEvent.click(screen.getByTestId("report-access-trigger"));
  return screen.getByTestId("report-access-popover");
}

describe("ReportAccessPopover — the badge is its only presentation", () => {
  it("a manager with grant rows still gets the read-only badge: no add form, no Remove, no picker", () => {
    render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[ROW]}
        scopeOptions={SCOPES}
        canManage
      />,
    );
    expect(screen.getByTestId("report-access-trigger").textContent).toBe("Superusers and comms stewards+ 1 other");
    const content = within(open());
    expect(content.queryByTestId("report-access-add-form")).toBeNull();
    expect(content.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(content.queryByRole("button", { name: "Add" })).toBeNull();
    expect(content.getByRole("button", { name: "Manage access" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useReportAccessRows — the Edit details sheet's Add / Remove round-trip", () => {
  it("a successful write re-renders from the rows the route answers with and calls onChange", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, rows: [ROW, NEW_ROW] }));
    const onChange = vi.fn();
    const { result } = renderHook(() => useReportAccessRows("mentored-publications", [ROW], onChange));
    let ok = false;
    await act(async () => {
      ok = await result.current.post("grant", "*", { cwid: "stf0001", name: "Staff Person" });
    });
    expect(ok).toBe(true);
    expect(result.current.rows).toEqual([ROW, NEW_ROW]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      op: "grant",
      reportKey: "mentored-publications",
      scopeKey: "*",
      cwid: "stf0001",
      name: "Staff Person",
    });
  });

  it("a rejected write maps the error code and keeps the rows as they were", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { ok: false, error: "not_comms_steward" }));
    const onChange = vi.fn();
    const { result } = renderHook(() => useReportAccessRows("mentored-publications", [ROW], onChange));
    await act(async () => {
      await result.current.post("revoke", "md", { cwid: "usr0001" });
    });
    expect(result.current.error).toContain("Only a superuser or comms steward");
    expect(result.current.rows).toEqual([ROW]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a network failure sets the generic error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useReportAccessRows("mentored-publications", []));
    await act(async () => {
      await result.current.post("grant", "*", { cwid: "stf0001" });
    });
    expect(result.current.error).toBe("That didn't save. Try again.");
  });
});

describe("ReportAccessPopover — the report header badge", () => {
  it("person mode: the default audience plus '+ N others', and a read-only list with program and added date", () => {
    render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[ROW, NEW_ROW]}
        scopeOptions={SCOPES}
        canManage={false}
      />,
    );
    const trigger = screen.getByTestId("report-access-trigger");
    expect(trigger.textContent).toBe("Superusers and comms stewards+ 2 others");
    const content = within(open());
    expect(content.getByText("Who can open this report")).toBeTruthy();
    // The audience is the row's title; the line under it doesn't repeat it.
    expect(content.getByText("Always have access.")).toBeTruthy();
    expect(content.getByTestId("report-access-row-md-usr0001").textContent).toContain("Curated Name");
    expect(content.getByTestId("report-access-row-md-usr0001").textContent).toContain("MD · added Sep 18, 2026");
    expect(content.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(content.queryByRole("button", { name: "Manage access" })).toBeNull();
  });

  it("an audience override names report 8's default; no rows → no '+ others'", () => {
    render(
      <ReportAccessPopover
        mode="person"
        audience="All unit administrators"
        reportKey="article-count"
        initialRows={[]}
        scopeOptions={[["*", "All"]]}
        canManage={false}
      />,
    );
    expect(screen.getByTestId("report-access-trigger").textContent).toBe("All unit administrators");
  });

  it("a manager's 'Manage access' closes the popover and fires the sheet's open event", () => {
    const heard = vi.fn();
    window.addEventListener("report-details-open", heard);
    render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[ROW]}
        scopeOptions={SCOPES}
        canManage
      />,
    );
    const content = within(open());
    fireEvent.click(content.getByRole("button", { name: "Manage access" }));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("report-access-popover")).toBeNull();
    window.removeEventListener("report-details-open", heard);
  });

  it("unit mode: unit owners and curators, linking to the administrators page", () => {
    render(<ReportAccessPopover mode="unit" />);
    expect(screen.getByTestId("report-access-trigger").textContent).toBe("Unit owners and curators");
    const content = within(open());
    expect(content.getByRole("link", { name: "Manage unit administrators" }).getAttribute("href")).toBe(
      "/edit/administrators",
    );
  });
});

describe("accessSummary — the one string source for the header badge and the index row", () => {
  const person = (rows: ReportAccessPopoverRow[], audience?: string) =>
    accessSummary({ mode: "person", initialRows: rows, audience });

  it("keeps the #2791 audience wording per mode", () => {
    expect(accessSummary({ mode: "unit" }).text).toBe("Unit owners and curators");
    expect(accessSummary({ mode: "admin" }).text).toBe("All unit administrators");
    expect(person([]).text).toBe("Superusers and comms stewards");
    expect(person([], "All unit administrators").text).toBe("All unit administrators");
  });

  it("'+ N others' for the grant rows, singular for one, null for none", () => {
    expect(person([ROW])).toMatchObject({ others: 1, othersLabel: "+ 1 other", text: "Superusers and comms stewards + 1 other" });
    expect(person([ROW, NEW_ROW], "All unit administrators").text).toBe("All unit administrators + 2 others");
    expect(person([]).othersLabel).toBeNull();
  });

  it("the badge renders the same audience and others label", () => {
    const { container } = render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[ROW]}
        scopeOptions={SCOPES}
        canManage={false}
      />,
    );
    const summary = person([ROW]);
    const trigger = within(container).getByTestId("report-access-trigger");
    expect(trigger.textContent).toBe(`${summary.audience}${summary.othersLabel}`);
  });
});
