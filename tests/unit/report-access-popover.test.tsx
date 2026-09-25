/**
 * `components/edit/report-access-popover.tsx` — the "Who can run this report"
 * popover. Unit mode is static text + a link (no fetch, no controls); person
 * mode renders the grant rows it is handed, shows Remove / Add only when
 * `canManage`, POSTs a grant WITH the picked person's name, and re-renders
 * from the row list the route answers with (server truth, no optimistic
 * overlay).
 *
 * Radix Popover portals its content to `document.body`, so the trigger is
 * clicked and the content is then found through `screen`, scoped by the
 * component's own testids — never `document.body` at large. The people
 * picker is mocked to a button that fires `onChange` with a fixed
 * `DirectoryValue`, so the test exercises the popover's wiring, not the
 * typeahead's debounce / fetch (covered in its own suite).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectoryValue } from "@/components/edit/directory-people-typeahead";

const PICKED: DirectoryValue = { cwid: "stf0001", name: "Staff Person", title: "Program Coordinator" };

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    value,
    onChange,
    idPrefix,
  }: {
    value: DirectoryValue | null;
    onChange: (v: DirectoryValue | null) => void;
    idPrefix?: string;
  }) => (
    <button type="button" data-testid={`${idPrefix}-typeahead-stub`} onClick={() => onChange(PICKED)}>
      {value ? `picked:${value.cwid}` : "pick"}
    </button>
  ),
}));

import {
  accessSummary,
  ReportAccessPopover,
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
  cwid: PICKED.cwid,
  granteeName: PICKED.name,
  name: PICKED.name,
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

describe("ReportAccessPopover — unit mode", () => {
  it("opens to the unit rule and an administrators link; no Add, no typeahead, no fetch", () => {
    render(<ReportAccessPopover mode="unit" />);
    expect(screen.queryByTestId("report-access-popover")).toBeNull();
    const content = open();
    expect(content.textContent).toContain(
      "Owners and Curators of the unit this report is opened for can run it, plus superusers and comms stewards.",
    );
    const link = within(content).getByRole("link", { name: "Manage unit administrators" });
    expect(link.getAttribute("href")).toBe("/edit/administrators");
    expect(within(content).queryByTestId("report-access-add-form")).toBeNull();
    expect(within(content).queryByTestId("report-access-typeahead-stub")).toBeNull();
    expect(within(content).queryByRole("button", { name: /Add|Remove/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the trigger carries the shared accessible name", () => {
    render(<ReportAccessPopover mode="unit" />);
    expect(screen.getByRole("button", { name: "Who can run this report" })).toBeTruthy();
  });
});

describe("ReportAccessPopover — person mode, canManage=false", () => {
  it("lists each row by resolved name + cwid + program + grantor, with no Remove or Add", () => {
    render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[ROW]}
        scopeOptions={SCOPES}
        canManage={false}
      />,
    );
    const content = open();
    expect(content.textContent).toContain("Superusers and comms stewards can always run this report.");
    const row = within(content).getByTestId("report-access-row-md-usr0001");
    expect(row.textContent).toContain("Curated Name");
    expect(row.textContent).toContain("usr0001");
    expect(row.textContent).toContain("MD");
    expect(row.textContent).toContain("adm0001");
    expect(within(content).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(content).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(content).queryByTestId("report-access-add-form")).toBeNull();
    expect(within(content).queryByTestId("report-access-empty")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state with no rows", () => {
    render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={[]}
        scopeOptions={SCOPES}
        canManage={false}
      />,
    );
    const content = open();
    expect(within(content).getByTestId("report-access-empty").textContent).toContain("No one else yet.");
  });
});

describe("ReportAccessPopover — person mode, canManage=true", () => {
  function renderManaged(rows: ReadonlyArray<ReportAccessPopoverRow>) {
    return render(
      <ReportAccessPopover
        mode="person"
        reportKey="mentored-publications"
        initialRows={rows}
        scopeOptions={SCOPES}
        canManage
      />,
    );
  }

  it("shows a Remove per row and the add form; Add is disabled until a person is picked", () => {
    renderManaged([ROW]);
    const content = open();
    expect(within(content).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(within(content).getByTestId("report-access-add-form")).toBeTruthy();
    expect(within(content).getByTestId("report-access-typeahead-stub")).toBeTruthy();
    expect((within(content).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("picking a person + Add POSTs the grant WITH name and re-renders from the returned rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, op: "grant", changed: true, rows: [ROW, NEW_ROW] }),
    );
    renderManaged([ROW]);
    const content = open();
    fireEvent.click(within(content).getByTestId("report-access-typeahead-stub"));
    expect(within(content).getByTestId("report-access-typeahead-stub").textContent).toBe("picked:stf0001");
    fireEvent.change(within(content).getByTestId("report-access-scope"), { target: { value: "*" } });
    const add = within(content).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);

    await waitFor(() => expect(within(content).queryByTestId("report-access-row-*-stf0001")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/report-access");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      op: "grant",
      reportKey: "mentored-publications",
      scopeKey: "*",
      cwid: "stf0001",
      name: "Staff Person",
    });
    // The new row renders the server's resolved name, and the picker is cleared.
    expect(within(content).getByTestId("report-access-row-*-stf0001").textContent).toContain("Staff Person");
    expect(within(content).getByTestId("report-access-typeahead-stub").textContent).toBe("pick");
  });

  it("Remove POSTs a revoke for that row's scope + cwid, with no name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, op: "revoke", changed: true, rows: [] }));
    renderManaged([ROW]);
    const content = open();
    fireEvent.click(within(content).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(content).queryByTestId("report-access-empty")).not.toBeNull());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      op: "revoke",
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "usr0001",
    });
  });

  it("a rejected write renders the mapped alert and keeps the list as it was", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { ok: false, error: "not_comms_steward" }));
    renderManaged([ROW]);
    const content = open();
    fireEvent.click(within(content).getByTestId("report-access-typeahead-stub"));
    fireEvent.click(within(content).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(content).queryByRole("alert")).not.toBeNull());
    expect(within(content).getByTestId("report-access-error").textContent).toContain(
      "Only a superuser or comms steward",
    );
    expect(within(content).getByTestId("report-access-row-md-usr0001")).toBeTruthy();
    // The pick is kept so the operator can retry without re-searching.
    expect(within(content).getByTestId("report-access-typeahead-stub").textContent).toBe("picked:stf0001");
  });

  it("a network failure renders the generic alert", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderManaged([]);
    const content = open();
    fireEvent.click(within(content).getByTestId("report-access-typeahead-stub"));
    fireEvent.click(within(content).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(content).queryByRole("alert")).not.toBeNull());
    expect(within(content).getByRole("alert").textContent).toContain("That didn't save. Try again.");
  });
});

describe("ReportAccessPopover — badge variant (report page header)", () => {
  it("person mode: the default audience plus '+ N others', and a read-only list with program and added date", () => {
    render(
      <ReportAccessPopover
        mode="person"
        variant="badge"
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
        variant="badge"
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
        variant="badge"
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
    render(<ReportAccessPopover mode="unit" variant="badge" />);
    expect(screen.getByTestId("report-access-trigger").textContent).toBe("Unit owners and curators");
    const content = within(open());
    expect(content.getByRole("link", { name: "Manage unit administrators" }).getAttribute("href")).toBe(
      "/edit/administrators",
    );
  });
});

describe("accessSummary — the one string source for the header badge and the index row", () => {
  const person = (rows: ReportAccessPopoverRow[], audience?: string) =>
    accessSummary({
      mode: "person",
      reportKey: "mentored-publications",
      initialRows: rows,
      scopeOptions: SCOPES,
      canManage: false,
      audience,
    });

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
        variant="badge"
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
