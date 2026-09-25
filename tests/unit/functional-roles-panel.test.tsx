/**
 * The Administrators page's Functional roles tab (`functional-roles-panel.tsx`,
 * mounted by `AdministratorsRoster` only when `functionalRoles` is passed, i.e.
 * for a superuser). Covers the tab strip, manual vs imported rows, Edit scope,
 * Revoke, Import, the Assign dialog, and the rail filters. `fetch` is mocked;
 * the route's own gates are covered in `functional-roles-route.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AdministratorsRoster } from "@/components/edit/administrators-roster";
import { toggleScope } from "@/components/edit/functional-roles-panel";
import type { AdminRosterEntry } from "@/lib/api/administrators-roster";
import type { FunctionalRoleRow, FunctionalRoleScopeOptions } from "@/lib/edit/functional-roles";

const SCOPES: FunctionalRoleScopeOptions = {
  external_communications: [{ key: "*", label: "All of WCM" }],
  development: [{ key: "*", label: "All of WCM" }],
  reporting: [
    { key: "*", label: "All reports" },
    { key: "article-count", label: "Article counts" },
    { key: "mentored-publications", label: "Mentored publications" },
    { key: "mentored-publications:md", label: "Mentored publications · MD" },
  ],
};

const row = (over: Partial<FunctionalRoleRow>): FunctionalRoleRow => ({
  role: "reporting",
  cwid: "fake001",
  source: "manual",
  scopes: ["article-count"],
  name: "Pat Example",
  title: "Research Analyst",
  granteeName: "Pat Example",
  grantedBy: "adm0001",
  grantedByName: "Admin Person",
  grantedAt: "2026-04-10T12:00:00.000Z",
  ...over,
});

const MANUAL = row({});
const IMPORTED = row({
  cwid: "fake002",
  name: "Sam Sample",
  source: "report_access",
  scopes: ["mentored-publications:md"],
  grantedBy: "adm0002",
  grantedByName: "Other Admin",
});
const ALLOW = row({
  role: "development",
  cwid: "fake003",
  name: "Lee Placeholder",
  source: "allowlist",
  scopes: ["*"],
  grantedBy: "ALLOWLIST",
  grantedByName: null,
});

const UNIT_ENTRY: AdminRosterEntry = {
  cwid: "fake010",
  name: "Unit Admin",
  title: null,
  nameResolved: true,
  grants: [
    {
      entityType: "department",
      entityId: "MED",
      unitName: "Medicine",
      role: "curator",
      source: "ED:DA",
    },
  ],
};

type Routed = { url: string; body: Record<string, unknown> | null };

/** Route fetch: the directory enrichment gets an empty list; the
 *  functional-roles route answers with `reply(body)`. */
function stubFetch(reply: (body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Routed[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const payload = url.includes("/api/edit/functional-roles")
      ? reply(body ?? {})
      : { ok: true, people: [] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

function renderRoster(rows: FunctionalRoleRow[] | null) {
  return render(
    <AdministratorsRoster
      entries={[UNIT_ENTRY]}
      isSuperuser
      actorCwid="adm0001"
      nameResolutionDegraded={false}
      functionalRoles={rows ? { rows, scopeOptions: SCOPES } : undefined}
    />,
  );
}

function openRolesTab() {
  fireEvent.click(screen.getByTestId("administrators-tab-roles"));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("toggleScope", () => {
  it("the wildcard is exclusive", () => {
    expect(toggleScope(["article-count"], "*")).toEqual(["*"]);
    expect(toggleScope(["*"], "article-count")).toEqual(["article-count"]);
    expect(toggleScope(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("Administrators tabs", () => {
  it("no functionalRoles (a unit Owner) → no tab strip, org-unit roster only", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster(null);
    expect(screen.queryByTestId("administrators-tabs")).toBeNull();
    expect(screen.getByTestId("administrators-add-trigger")).toBeTruthy();
  });

  it("shows both tabs with counts; switching swaps the header action and body", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL, IMPORTED, ALLOW]);
    expect(screen.getByTestId("administrators-tab-units").textContent).toBe("Org unit grants1");
    expect(screen.getByTestId("administrators-tab-roles").textContent).toBe("Functional roles3");
    expect(screen.getByTestId("administrators-tab-units").getAttribute("aria-selected")).toBe(
      "true",
    );
    openRolesTab();
    expect(screen.getByTestId("administrators-tab-roles").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByTestId("administrators-add-trigger")).toBeNull();
    expect(screen.getByTestId("functional-roles-assign-trigger")).toBeTruthy();
    expect(screen.getByTestId("functional-roles-panel")).toBeTruthy();
    expect(screen.queryByTestId("administrators-rail")).toBeNull();
    expect(screen.getByTestId("functional-roles-caption").textContent).toContain(
      "isn’t tied to an org unit",
    );
  });
});

describe("Functional roles rows", () => {
  it("manual rows get Edit scope + Revoke and 'Added by'; imported rows are Read-only with a lock", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL, IMPORTED, ALLOW]);
    openRolesTab();
    const manual = screen.getByTestId("functional-role-reporting:fake001:manual");
    expect(within(manual).getByText("Reporting")).toBeTruthy();
    expect(within(manual).getByText("Article counts")).toBeTruthy();
    // Granted by the viewer (actorCwid adm0001) → "you".
    expect(within(manual).getByText("Added by you · Apr 2026")).toBeTruthy();
    // Someone else's grant shows the granter's name.
    expect(
      within(screen.getByTestId("functional-role-reporting:fake002:report_access")).getByText(
        "Report access · added by Other Admin · Apr 2026",
      ),
    ).toBeTruthy();
    expect(
      within(manual).getByTestId("functional-role-edit-scope-reporting:fake001:manual"),
    ).toBeTruthy();
    expect(
      within(manual).getByTestId("functional-role-revoke-reporting:fake001:manual"),
    ).toBeTruthy();

    const imported = screen.getByTestId("functional-role-reporting:fake002:report_access");
    expect(within(imported).getByText("Mentored publications · MD")).toBeTruthy();
    expect(
      within(imported).getByTestId("functional-role-locked-reporting:fake002:report_access"),
    ).toBeTruthy();
    expect(within(imported).queryByText("Revoke")).toBeNull();
    expect(within(imported).queryByText("Edit scope")).toBeNull();

    const allow = screen.getByTestId("functional-role-development:fake003:allowlist");
    expect(within(allow).getByText("All of WCM")).toBeTruthy();
    expect(within(allow).getByText("Break-glass allowlist")).toBeTruthy();

    expect(screen.getByTestId("functional-roles-stats").textContent).toContain("3 people");
    expect(screen.getByTestId("functional-roles-stats").textContent).toContain("2 imported");
    expect(screen.getByTestId("functional-roles-stats").textContent).toContain("1 granted here");
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain(
      "Showing 3 of 3 assignments.",
    );
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain(
      "Recorded here for tracking",
    );
  });

  it("an institution-wide-only manual role has no Edit scope (nothing to choose)", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([row({ role: "external_communications", scopes: ["*"] })]);
    openRolesTab();
    expect(
      screen.queryByTestId("functional-role-edit-scope-external_communications:fake001:manual"),
    ).toBeNull();
    expect(
      screen.getByTestId("functional-role-revoke-external_communications:fake001:manual"),
    ).toBeTruthy();
  });

  it("empty registry → the import prompt", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([]);
    openRolesTab();
    expect(screen.getByTestId("functional-roles-empty").textContent).toContain(
      "Import from sources",
    );
  });

  it("rail filters: Source=Imported keeps the two imported rows; Clear resets", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL, IMPORTED, ALLOW]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-roles-filter-src-imported"));
    expect(screen.queryByTestId("functional-role-reporting:fake001:manual")).toBeNull();
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain("Showing 2 of 3");
    fireEvent.click(screen.getByTestId("functional-roles-filter-role-development"));
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain("Showing 1 of 3");
    fireEvent.click(screen.getByTestId("functional-roles-filters-clear"));
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain("Showing 3 of 3");
  });

  it("search matches a scope label", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL, IMPORTED, ALLOW]);
    openRolesTab();
    fireEvent.change(screen.getByTestId("functional-roles-filter-input"), {
      target: { value: "mentored" },
    });
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain("Showing 1 of 3");
  });
});

describe("Functional roles writes", () => {
  it("Edit scope posts set_scopes with the new set and re-renders from the reply", async () => {
    const calls = stubFetch(() => ({ ok: true, rows: [{ ...MANUAL, scopes: ["*"] }] }));
    renderRoster([MANUAL]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-role-edit-scope-reporting:fake001:manual"));
    await waitFor(() => expect(screen.getByTestId("functional-roles-scope-dialog")).toBeTruthy());
    fireEvent.click(screen.getByTestId("functional-roles-scope-scope-*"));
    fireEvent.click(screen.getByTestId("functional-roles-scope-save"));
    await waitFor(() => expect(screen.getByText("All reports")).toBeTruthy());
    const call = calls.find((c) => c.url.includes("functional-roles"));
    expect(call?.body).toEqual({
      op: "set_scopes",
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
  });

  it("Revoke confirms, posts revoke, and drops the row", async () => {
    const calls = stubFetch(() => ({ ok: true, rows: [] }));
    renderRoster([MANUAL]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-role-revoke-reporting:fake001:manual"));
    await waitFor(() => expect(screen.getByText("Revoke this role?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(screen.queryByTestId("functional-role-reporting:fake001:manual")).toBeNull(),
    );
    expect(calls.find((c) => c.url.includes("functional-roles"))?.body).toEqual({
      op: "revoke",
      role: "reporting",
      cwid: "fake001",
    });
    expect(screen.getByTestId("administrators-tab-roles").textContent).toBe("Functional roles0");
  });

  it("Import posts op:import, shows the counts, and renders the reply rows", async () => {
    stubFetch(() => ({ ok: true, added: 1, updated: 0, removed: 0, rows: [IMPORTED] }));
    renderRoster([]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-roles-import"));
    await waitFor(() =>
      expect(screen.getByTestId("functional-roles-notice").textContent).toBe(
        "Import finished: 1 added, 0 updated, 0 removed.",
      ),
    );
    expect(screen.getByTestId("functional-role-reporting:fake002:report_access")).toBeTruthy();
  });

  it("a failed write shows the mapped error", async () => {
    stubFetch(() => ({ ok: false, error: "not_superuser" }));
    renderRoster([]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-roles-import"));
    await waitFor(() =>
      expect(screen.getByTestId("functional-roles-error").textContent).toContain("Only superusers"),
    );
  });

  it("the Assign dialog carries the tracking note and requires a person", async () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-roles-assign-trigger"));
    const dialog = await screen.findByTestId("functional-roles-assign-dialog");
    expect(dialog.textContent).toContain("Recorded here for tracking");
    // Reporting is the default role and offers scopes; switching to
    // Development hides the picker (institution-wide only).
    expect(within(dialog).getByTestId("functional-roles-assign-scopes")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("functional-roles-assign-role-development"));
    expect(within(dialog).queryByTestId("functional-roles-assign-scopes")).toBeNull();
    expect(
      (screen.getByTestId("functional-roles-assign-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
