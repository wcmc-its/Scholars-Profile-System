/**
 * #955 finding #11 — the read-only scholar profile audit table
 * (`components/edit/scholar-history-view.tsx`). Renders headers, the back-link,
 * an action row with changed-field detail, the proxy detail, the impersonation
 * note, and the empty state. (Page authorization gates live in
 * `scholar-history-page.test.tsx`, which mocks this component.)
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ScholarHistoryView } from "@/components/edit/scholar-history-view";
import type { ScholarAuditEntry } from "@/lib/api/scholar-audit";

function entry(over: Partial<ScholarAuditEntry> & { id: string }): ScholarAuditEntry {
  return {
    ts: "2026-06-05T08:00:00.000Z",
    actorCwid: "self0001",
    impersonatedCwid: null,
    action: "field_override",
    actionLabel: "Updated profile",
    fields: ["Overview"],
    detail: null,
    ...over,
  };
}

describe("ScholarHistoryView", () => {
  it("renders the table with headers and a back-link to the editor", () => {
    render(
      <ScholarHistoryView
        cwid="abc1001"
        scholarName="Jane Doe"
        entries={[entry({ id: "1" })]}
        windowDays={90}
      />,
    );
    expect(screen.getByTestId("scholar-history-table")).toBeTruthy();
    for (const h of ["When", "Actor", "Action", "Details"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    }
    const back = screen.getByRole("link", { name: /Back to Jane Doe/ });
    expect(back.getAttribute("href")).toBe("/edit/scholar/abc1001");
  });

  it("renders an action row: actor, label, and the changed fields as detail", () => {
    render(
      <ScholarHistoryView
        cwid="abc1001"
        scholarName="Jane"
        entries={[entry({ id: "1", actionLabel: "Updated profile", fields: ["Overview"] })]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("scholar-history-row-1");
    expect(row.getAttribute("data-action")).toBe("field_override");
    expect(row.textContent).toContain("self0001");
    expect(row.textContent).toContain("Updated profile");
    expect(row.textContent).toContain("Overview");
  });

  it("renders the compact detail (e.g. proxy cwid) when there are no fields", () => {
    render(
      <ScholarHistoryView
        cwid="abc1001"
        scholarName="Jane"
        entries={[
          entry({
            id: "2",
            action: "proxy_grant",
            actionLabel: "Granted proxy editor",
            fields: [],
            detail: "prx0003",
          }),
        ]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("scholar-history-row-2");
    expect(row.textContent).toContain("Granted proxy editor");
    expect(row.textContent).toContain("prx0003");
  });

  it("shows the impersonation note when impersonatedCwid is set", () => {
    render(
      <ScholarHistoryView
        cwid="abc1001"
        scholarName="Jane"
        entries={[entry({ id: "3", actorCwid: "sup0001", impersonatedCwid: "own0002" })]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("scholar-history-row-3");
    expect(row.textContent).toContain("sup0001");
    expect(row.textContent).toMatch(/as own0002/);
  });

  it("renders an empty state when there are no entries", () => {
    render(
      <ScholarHistoryView cwid="abc1001" scholarName="Jane" entries={[]} windowDays={90} />,
    );
    expect(screen.getByTestId("scholar-history-empty").textContent).toMatch(/No profile edits/);
    expect(screen.queryByTestId("scholar-history-table")).toBeNull();
  });
});
