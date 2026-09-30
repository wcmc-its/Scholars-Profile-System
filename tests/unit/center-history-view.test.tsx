/**
 * #552 Phase 7 — the read-only center roster audit table
 * (`components/edit/center-history-view.tsx`). Renders headers, the back-link,
 * add / modify rows, the diff summary, the impersonation note, and the empty
 * state. (Page authorization gates live in `center-history-page.test.tsx`,
 * which mocks this component — they cannot share a file, since `vi.mock` is
 * hoisted module-wide.)
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The top bar mounts the real AccountMenu (a client island that probes
// /api/auth/session) now that this page has no AdminSubnav to supply it
// (dwd2001 nav fix). Stub it so these content assertions run without a live
// fetch / Popover — the menu mount itself is pinned in console-top-bar.test.tsx.
vi.mock("@/components/site/account-menu", () => ({
  AccountMenu: ({ context }: { context?: string }) => (
    <div data-testid="account-menu-stub" data-context={context} />
  ),
}));

import { CenterHistoryView } from "@/components/edit/center-history-view";
import type { CenterAuditEntry } from "@/lib/api/center-audit";

function entry(over: Partial<CenterAuditEntry> & { id: string }): CenterAuditEntry {
  return {
    ts: "2026-06-05T08:00:00.000Z",
    actorCwid: "cur0001",
    impersonatedCwid: null,
    changeKind: "add",
    targetCwid: "abc1001",
    fieldChanges: [],
    ...over,
  };
}

describe("CenterHistoryView", () => {
  // dwd2001 nav fix: this page has no AdminSubnav, so the top bar must carry
  // the account menu itself (ConsoleTopBar's showAccountMenu).
  it("renders an account menu — this page has no AdminSubnav to supply one", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer Cancer Center"
        entries={[]}
        windowDays={90}
      />,
    );
    expect(screen.getByTestId("account-menu-stub").getAttribute("data-context")).toBe("console");
  });

  it("renders the table with headers and a back-link to the editor", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer Cancer Center"
        entries={[entry({ id: "1" })]}
        windowDays={90}
      />,
    );
    expect(screen.getByTestId("center-history-table")).toBeTruthy();
    for (const h of ["When", "Actor", "Change", "Member", "Details"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    }
    const back = screen.getByRole("link", { name: /Back to Meyer Cancer Center/ });
    expect(back.getAttribute("href")).toBe("/edit/center/meyer_cancer_center");
  });

  it("renders an add row: actor, change label, member, dash diff", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[
          entry({ id: "1", changeKind: "add", actorCwid: "cur0001", targetCwid: "abc1001" }),
        ]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("center-history-row-1");
    expect(row.getAttribute("data-change-kind")).toBe("add");
    expect(row.textContent).toContain("Added");
    expect(row.textContent).toContain("cur0001");
    expect(row.textContent).toContain("abc1001");
  });

  it("renders a modify row's field diff (Field: from → to)", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[
          entry({
            id: "2",
            changeKind: "modify",
            fieldChanges: [
              { field: "type", from: "research", to: "clinical" },
              { field: "program", from: null, to: "CT" },
            ],
          }),
        ]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("center-history-row-2");
    expect(row.textContent).toContain("Type:");
    expect(row.textContent).toContain("research");
    expect(row.textContent).toContain("clinical");
    expect(row.textContent).toContain("Program:");
    expect(row.textContent).toContain("CT");
  });

  it("renders a disease-assignment-decision row (add kind) as 'Disease: BREAST → confirmed'", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[
          entry({
            id: "4",
            changeKind: "add",
            targetCwid: "abc1001",
            fieldChanges: [{ field: "disease", from: "BREAST", to: "confirmed" }],
          }),
        ]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("center-history-row-4");
    expect(row.textContent).toContain("Disease:");
    expect(row.textContent).toContain("BREAST");
    expect(row.textContent).toContain("confirmed");
  });

  it("renders a cleared disease decision (remove kind) with a dash 'to' value", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[
          entry({
            id: "5",
            changeKind: "remove",
            targetCwid: "abc1001",
            fieldChanges: [{ field: "disease", from: "BREAST", to: null }],
          }),
        ]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("center-history-row-5");
    expect(row.textContent).toContain("Disease:");
    expect(row.textContent).toContain("BREAST");
    expect(row.textContent).toContain("—");
  });

  it("shows the impersonation note when impersonatedCwid is set", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[entry({ id: "3", actorCwid: "sup0001", impersonatedCwid: "own0002" })]}
        windowDays={90}
      />,
    );
    const row = screen.getByTestId("center-history-row-3");
    expect(row.textContent).toContain("sup0001");
    expect(row.textContent).toMatch(/as own0002/);
  });

  it("renders an empty state when there are no entries", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[]}
        windowDays={90}
      />,
    );
    expect(screen.getByTestId("center-history-empty").textContent).toMatch(/No roster changes/);
    expect(screen.queryByTestId("center-history-table")).toBeNull();
  });

  it("renders the unavailable notice (taking precedence over table + empty) when the read failed", () => {
    render(
      <CenterHistoryView
        centerCode="meyer_cancer_center"
        centerName="Meyer"
        entries={[entry({ id: "1" })]}
        windowDays={90}
        unavailable
      />,
    );
    expect(screen.getByTestId("center-history-unavailable").textContent).toMatch(
      /temporarily unavailable/,
    );
    expect(screen.queryByTestId("center-history-table")).toBeNull();
    expect(screen.queryByTestId("center-history-empty")).toBeNull();
  });
});
