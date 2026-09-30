/**
 * #2542 Phase C — CenterLeadershipCard: the vocabulary-driven leadership
 * editor on `/edit/center/[code]`, in its Edit Center mockup layout
 * (2026-09-25): one list of every holder in role order + ONE add row
 * ("Add [person] as [role] [Interim] Add") + a "Not filled: …" line.
 *
 *  - holders render in the order the (server-filtered) `roles` prop arrives —
 *    a role the actor isn't allowed at this center is simply absent from that
 *    prop (`isRoleAllowedAtUnit`, computed server-side), so it is never offered
 *    in the add row's role select either;
 *  - picking a singleHolder role that already has a holder relabels the add
 *    button "Replace" (POSTing `replace: true`), swapping the local list from
 *    the response's `replacedCwid`;
 *  - a non-singleHolder role always offers a plain "Add";
 *  - Remove goes through ConfirmDialog before POSTing;
 *  - the per-row interim checkbox POSTs `set_interim`.
 *
 * The directory typeahead is stubbed (its own tests cover it); fetch is mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
    idPrefix,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
    idPrefix?: string;
  }) => (
    <button
      type="button"
      data-testid={`pick-${idPrefix}`}
      onClick={() => onChange({ cwid: "new001", name: "New Person", title: "Professor" })}
    >
      pick
    </button>
  ),
}));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { CenterLeadershipCard } from "@/components/edit/center-leadership-card";

function okFetch(extra: Record<string, unknown> = {}) {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true, ...extra }) });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

function pickRole(key: string) {
  fireEvent.change(screen.getByTestId("leadership-add-role"), { target: { value: key } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const ROLES = [
  {
    key: "director",
    label: "Director",
    singleHolder: true,
    sortOrder: 10,
    holders: [{ cwid: "dir001", name: "Dana Director", title: "MD", interim: false }],
  },
  {
    key: "co_director",
    label: "Co-Director",
    singleHolder: false,
    sortOrder: 20,
    holders: [
      { cwid: "cod001", name: "Cody One", title: "PhD", interim: false },
      { cwid: "cod002", name: "Cody Two", title: null, interim: true },
    ],
  },
  {
    key: "associate_director",
    label: "Associate Director",
    singleHolder: false,
    sortOrder: 30,
    holders: [],
  },
];

describe("CenterLeadershipCard (#2542 Phase C, Edit Center mockup layout)", () => {
  it("lists every holder in one list, in role (prop) order", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    const rows = screen
      .getAllByTestId(/^role-holder-(director|co_director|associate_director)-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual([
      "role-holder-director-dir001",
      "role-holder-co_director-cod001",
      "role-holder-co_director-cod002",
    ]);
    // The role is named on each row; an interim holder is flagged inline.
    expect(screen.getByTestId("role-holder-label-co_director-cod002").textContent).toBe(
      "Co-Director · interim",
    );
  });

  it("names the unfilled roles under the add row", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    expect(screen.getByTestId("center-leadership-unfilled").textContent).toBe(
      "Not filled: Associate Director.",
    );
  });

  it("the add row's role select offers exactly the server-allowed roles, defaulting to an empty one", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    const select = screen.getByTestId("leadership-add-role") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "director",
      "co_director",
      "associate_director",
    ]);
    expect(select.value).toBe("associate_director");
  });

  it("no assignable roles at all → the empty-state message, no add row", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={[]} />);
    expect(screen.getByText(/no assignable leadership roles/i)).toBeTruthy();
    expect(screen.queryByTestId("leadership-add")).toBeNull();
  });

  it("picking a filled singleHolder role labels the button 'Replace'; other roles say 'Add'", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    pickRole("director");
    expect(screen.getByTestId("leadership-add").textContent).toBe("Replace");
    pickRole("co_director");
    expect(screen.getByTestId("leadership-add").textContent).toBe("Add");
    pickRole("associate_director");
    expect(screen.getByTestId("leadership-add").textContent).toBe("Add");
  });

  it("adding to an empty multi-holder role POSTs add with no replace flag", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    pickRole("associate_director");
    fireEvent.click(screen.getByTestId("pick-leadership-add"));
    fireEvent.click(screen.getByTestId("leadership-add"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      centerCode: "meyer",
      roleKey: "associate_director",
      action: "add",
      cwid: "new001",
    });
    expect(body).not.toHaveProperty("replace");
    expect(body).not.toHaveProperty("interim");
    await waitFor(() =>
      expect(screen.getByTestId("role-holder-associate_director-new001")).toBeTruthy(),
    );
    expect(screen.getByTestId("center-leadership-unfilled").textContent).toBe("All roles filled.");
  });

  it("replacing a singleHolder incumbent POSTs add with replace:true and swaps the holder", async () => {
    const fetchMock = okFetch({
      replacedCwid: "dir001",
      holder: { cwid: "new001", name: "New Person", title: "Professor", interim: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    pickRole("director");
    fireEvent.click(screen.getByTestId("pick-leadership-add"));
    fireEvent.click(screen.getByTestId("leadership-add"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({ roleKey: "director", action: "add", cwid: "new001", replace: true });
    expect(body).not.toHaveProperty("interim");
    await waitFor(() => {
      expect(screen.queryByTestId("role-holder-director-dir001")).toBeNull();
      expect(screen.getByTestId("role-holder-director-new001")).toBeTruthy();
    });
    expect(screen.getByTestId("role-interim-director-new001").getAttribute("data-state")).toBe(
      "unchecked",
    );
  });

  it("a replacement holder renders the interim state the ROUTE returns, never a hardcoded false", async () => {
    const fetchMock = okFetch({
      replacedCwid: "dir001",
      holder: { cwid: "new001", name: "New Person", title: "Professor", interim: true },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    pickRole("director");
    fireEvent.click(screen.getByTestId("pick-leadership-add"));
    fireEvent.click(screen.getByTestId("leadership-add-interim"));
    fireEvent.click(screen.getByTestId("leadership-add"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({ action: "add", cwid: "new001", replace: true, interim: true });
    await waitFor(() => {
      expect(screen.getByTestId("role-holder-director-new001")).toBeTruthy();
    });
    expect(screen.getByTestId("role-interim-director-new001").getAttribute("data-state")).toBe(
      "checked",
    );
  });

  it("a 409 single-holder conflict surfaces an inline error and does not touch the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: "role_single_holder_conflict", incumbentCwid: "dir001" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    pickRole("director");
    fireEvent.click(screen.getByTestId("pick-leadership-add"));
    fireEvent.click(screen.getByTestId("leadership-add"));
    await waitFor(() => expect(screen.getByText(/someone else was just assigned/i)).toBeTruthy());
    expect(screen.getByTestId("role-holder-director-dir001")).toBeTruthy();
  });

  it("toggling interim POSTs set_interim", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("role-interim-co_director-cod001"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      roleKey: "co_director",
      action: "set_interim",
      cwid: "cod001",
      interim: true,
    });
  });

  it("Remove opens a confirm dialog before POSTing, and updates the list on confirm", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("role-remove-co_director-cod002"));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirmButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({ roleKey: "co_director", action: "remove", cwid: "cod002" });
    await waitFor(() => {
      expect(screen.queryByTestId("role-holder-co_director-cod002")).toBeNull();
    });
    expect(screen.getByTestId("role-holder-co_director-cod001")).toBeTruthy();
  });

  it("Cancel on the confirm dialog leaves the holder in place and posts nothing", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("role-remove-director-dir001"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("role-holder-director-dir001")).toBeTruthy();
  });

  it("picking someone already holding the chosen role shows an inline error instead of POSTing", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    const rolesWithDupe = [
      {
        key: "co_director",
        label: "Co-Director",
        singleHolder: false,
        sortOrder: 20,
        holders: [{ cwid: "new001", name: "Already There", title: null, interim: false }],
      },
    ];
    render(<CenterLeadershipCard centerCode="meyer" roles={rolesWithDupe} />);
    fireEvent.click(screen.getByTestId("pick-leadership-add"));
    fireEvent.click(screen.getByTestId("leadership-add"));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/already holds this role/i)).toBeTruthy();
  });
});
