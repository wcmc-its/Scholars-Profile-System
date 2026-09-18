/**
 * `components/edit/report-access-panel.tsx` — the "Viewers" island on
 * `/edit/reports/7`. Renders the rows it is handed, POSTs a grant / revoke
 * to `/api/edit/report-access`, and re-renders from the row list the route
 * answers with (server truth, no optimistic overlay). Assertions are scoped
 * to the panel's own testids, never `document.body` at large.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportAccessPanel } from "@/components/edit/report-access-panel";

const ROW = {
  reportKey: "mentored-publications",
  scopeKey: "md",
  cwid: "usr0001",
  grantedBy: "adm0001",
  grantedAt: "2026-09-18T12:00:00.000Z",
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

describe("ReportAccessPanel", () => {
  it("renders the empty state with no rows", () => {
    render(<ReportAccessPanel reportKey="mentored-publications" initialRows={[]} scopeOptions={SCOPES} />);
    expect(screen.getByTestId("report-access-empty")).toBeTruthy();
    expect(screen.queryByTestId("report-access-row-md-usr0001")).toBeNull();
  });

  it("renders each row with its cwid, program label, grantor and a Remove button", () => {
    render(<ReportAccessPanel reportKey="mentored-publications" initialRows={[ROW]} scopeOptions={SCOPES} />);
    const row = screen.getByTestId("report-access-row-md-usr0001");
    expect(row.textContent).toContain("usr0001");
    expect(row.textContent).toContain("MD");
    expect(row.textContent).toContain("adm0001");
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByTestId("report-access-empty")).toBeNull();
  });

  it("Add viewer POSTs a lowercased grant and re-renders from the returned rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, op: "grant", changed: true, rows: [ROW] }));
    render(<ReportAccessPanel reportKey="mentored-publications" initialRows={[]} scopeOptions={SCOPES} />);
    fireEvent.change(screen.getByTestId("report-access-cwid"), { target: { value: " USR0001 " } });
    fireEvent.change(screen.getByTestId("report-access-scope"), { target: { value: "md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add viewer" }));

    await waitFor(() => expect(screen.queryByTestId("report-access-row-md-usr0001")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/report-access");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      op: "grant",
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "usr0001",
    });
    expect(screen.queryByTestId("report-access-empty")).toBeNull();
    expect((screen.getByTestId("report-access-cwid") as HTMLInputElement).value).toBe("");
  });

  it("Remove POSTs a revoke for that row's scope + cwid", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, op: "revoke", changed: true, rows: [] }));
    render(<ReportAccessPanel reportKey="mentored-publications" initialRows={[ROW]} scopeOptions={SCOPES} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByTestId("report-access-empty")).not.toBeNull());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      op: "revoke",
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "usr0001",
    });
  });

  it("a rejected write shows the mapped error and keeps the list as it was", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { ok: false, error: "invalid_cwid", field: "cwid" }));
    render(<ReportAccessPanel reportKey="mentored-publications" initialRows={[ROW]} scopeOptions={SCOPES} />);
    fireEvent.change(screen.getByTestId("report-access-cwid"), { target: { value: "1bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Add viewer" }));
    await waitFor(() => expect(screen.queryByTestId("report-access-error")).not.toBeNull());
    expect(screen.getByTestId("report-access-error").textContent).toContain("Enter a CWID");
    expect(screen.getByTestId("report-access-row-md-usr0001")).toBeTruthy();
  });
});
