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
import type {
  FunctionalRoleRow,
  FunctionalRoleScopeOptions,
  GateHolder,
} from "@/lib/edit/functional-roles";

const SCOPES: FunctionalRoleScopeOptions = {
  external_affairs: [
    { key: "communications", label: "Communications" },
    { key: "development", label: "Development" },
  ],
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
  role: "external_affairs",
  cwid: "fake003",
  name: "Lee Placeholder",
  source: "allowlist",
  scopes: ["communications", "development"],
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

function renderRoster(
  rows: FunctionalRoleRow[] | null,
  extra: { authzEnabled?: boolean; gateHolders?: GateHolder[] } = {},
) {
  return render(
    <AdministratorsRoster
      entries={[UNIT_ENTRY]}
      isSuperuser
      actorCwid="adm0001"
      nameResolutionDegraded={false}
      functionalRoles={rows ? { rows, scopeOptions: SCOPES, ...extra } : undefined}
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

    const allow = screen.getByTestId("functional-role-external_affairs:fake003:allowlist");
    expect(within(allow).getByText("External Affairs")).toBeTruthy();
    // The functions render as the row's scope pills.
    expect(
      within(
        screen.getByTestId("functional-role-scopes-external_affairs:fake003:allowlist"),
      ).getByText("Communications"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByTestId("functional-role-scopes-external_affairs:fake003:allowlist"),
      ).getByText("Development"),
    ).toBeTruthy();
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

  it("a manual External Affairs row offers Edit functions, which posts the chosen functions", async () => {
    const calls = stubFetch(() => ({
      ok: true,
      rows: [row({ role: "external_affairs", scopes: ["communications", "development"] })],
    }));
    renderRoster([row({ role: "external_affairs", scopes: ["communications"] })]);
    openRolesTab();
    const edit = screen.getByTestId("functional-role-edit-scope-external_affairs:fake001:manual");
    expect(edit.textContent).toBe("Edit functions");
    fireEvent.click(edit);
    const dialog = await screen.findByTestId("functional-roles-scope-dialog");
    expect(within(dialog).getByText("Functions")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("functional-roles-scope-scope-development"));
    fireEvent.click(screen.getByTestId("functional-roles-scope-save"));
    await waitFor(() => expect(screen.queryByTestId("functional-roles-scope-dialog")).toBeNull());
    expect(calls.find((c) => c.url.includes("functional-roles"))?.body).toEqual({
      op: "set_scopes",
      role: "external_affairs",
      cwid: "fake001",
      scopes: ["communications", "development"],
    });
  });

  it("External Affairs counts as institution-wide in the Scope filter", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL, IMPORTED, ALLOW]);
    openRolesTab();
    fireEvent.click(screen.getByTestId("functional-roles-filter-scope-all"));
    expect(screen.getByTestId("functional-role-external_affairs:fake003:allowlist")).toBeTruthy();
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain("Showing 1 of 3");
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
    fireEvent.click(screen.getByTestId("functional-roles-filter-role-external_affairs"));
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
    // Only two roles: External Affairs (one role, not Comms/Development) and Reporting.
    expect(within(dialog).queryByTestId("functional-roles-assign-role-development")).toBeNull();
    // Reporting is the default role and starts at "All reports".
    expect(
      (within(dialog).getByTestId("functional-roles-assign-scope-*") as HTMLInputElement).checked,
    ).toBe(true);
    // External Affairs shows its functions, none ticked: they are chosen explicitly.
    fireEvent.click(within(dialog).getByTestId("functional-roles-assign-role-external_affairs"));
    const picker = within(dialog).getByTestId("functional-roles-assign-scopes");
    expect(within(picker).getByText("Functions")).toBeTruthy();
    expect(
      (
        within(dialog).getByTestId(
          "functional-roles-assign-scope-communications",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (within(dialog).getByTestId("functional-roles-assign-scope-development") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("functional-roles-assign-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("with FUNCTIONAL_ROLES_AUTHZ on, the dialog and footer say rows grant access", async () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL], { authzEnabled: true });
    openRolesTab();
    expect(screen.getByTestId("functional-roles-footer").textContent).toContain(
      "Assignments here grant access, in addition to",
    );
    expect(screen.getByTestId("functional-roles-footer").textContent).not.toContain(
      "Recorded here for tracking",
    );
    fireEvent.click(screen.getByTestId("functional-roles-assign-trigger"));
    const dialog = await screen.findByTestId("functional-roles-assign-dialog");
    expect(dialog.textContent).toContain("Assignments here grant access");
  });
});

describe("Functional roles parity line", () => {
  const HOLDERS: GateHolder[] = [
    {
      role: "reporting",
      cwid: "fake002",
      name: "Sam Sample",
      reportKey: "mentored-publications",
      scope: "md",
      via: "report_access",
    },
    {
      role: "external_affairs",
      cwid: "fake020",
      name: null,
      scope: "development",
      via: "development_allowlist",
    },
  ];

  it("no parity line without gate holders", () => {
    stubFetch(() => ({ ok: true }));
    renderRoster([MANUAL]);
    openRolesTab();
    expect(screen.queryByTestId("functional-roles-parity")).toBeNull();
  });

  it("lists holders with no covering row, and clears after an import covers them", async () => {
    const covering = row({
      role: "external_affairs",
      cwid: "fake020",
      source: "allowlist",
      scopes: ["development"],
    });
    stubFetch(() => ({ ok: true, added: 1, updated: 0, removed: 0, rows: [IMPORTED, covering] }));
    renderRoster([IMPORTED], { gateHolders: HOLDERS });
    openRolesTab();
    const parity = screen.getByTestId("functional-roles-parity");
    expect(parity.textContent).toContain("1 current grant has no matching row here");
    expect(screen.getByTestId("functional-roles-parity-gap-fake020").textContent).toContain(
      "External Affairs · Development · via Development allowlist",
    );
    expect(screen.queryByTestId("functional-roles-parity-gap-fake002")).toBeNull();
    // Web Directory group members are called out as unchecked.
    expect(parity.textContent).toContain("Web Directory group members can’t be listed");

    fireEvent.click(screen.getByTestId("functional-roles-import"));
    await waitFor(() =>
      expect(screen.getByTestId("functional-roles-parity").textContent).toContain(
        "all 2 current grants from report access and the allowlists have a matching row",
      ),
    );
  });
  it("shows the CWID once for an unnamed holder, and Name + CWID for a named one", () => {
    stubFetch(() => ({ ok: true }));
    const named: GateHolder = { ...HOLDERS[1]!, cwid: "fake021", name: "Nia Named" };
    renderRoster([], { gateHolders: [HOLDERS[1]!, named] });
    openRolesTab();
    const bare = screen.getByTestId("functional-roles-parity-gap-fake020");
    expect(bare.textContent!.match(/fake020/g)).toHaveLength(1);
    expect(bare.textContent).toMatch(/^fake020 · External Affairs/);
    const withName = screen.getByTestId("functional-roles-parity-gap-fake021");
    expect(withName.textContent).toMatch(/^Nia Named fake021 · External Affairs/);
  });
});

describe("Functional roles registry row names", () => {
  it("a row whose name is its CWID shows the CWID once; a named row shows Name + CWID", () => {
    stubFetch(() => ({ ok: true }));
    const bare = row({ cwid: "fake030", name: "fake030", title: null, granteeName: null });
    renderRoster([MANUAL, bare]);
    openRolesTab();
    const bareRow = screen.getByTestId("functional-role-reporting:fake030:manual");
    expect(bareRow.textContent!.match(/fake030/g)).toHaveLength(1);
    const namedRow = screen.getByTestId("functional-role-reporting:fake001:manual");
    expect(within(namedRow).getByText("Pat Example")).toBeTruthy();
    expect(within(namedRow).getByText("fake001")).toBeTruthy();
  });
});
