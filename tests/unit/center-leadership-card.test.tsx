/**
 * #2542 Phase C — CenterLeadershipCard: the vocabulary-driven leadership
 * editor on `/edit/center/[code]`.
 *
 *  - renders one section per role, in the order the (server-filtered) `roles`
 *    prop arrives — a role the actor isn't allowed at this center is simply
 *    absent from that prop (`isRoleAllowedAtUnit`, computed server-side by
 *    `lib/api/unit-edit-context.ts`), so this card never re-derives allowlist
 *    logic itself;
 *  - a singleHolder role with no holder offers "Add"; with a holder it shows
 *    the holder AND relabels the add control "Replace" (POSTing
 *    `replace: true`), swapping the local list from the response's
 *    `replacedCwid`;
 *  - a non-singleHolder role always offers a plain "Add" and lists every
 *    holder;
 *  - Remove goes through ConfirmDialog before POSTing;
 *  - the interim checkbox POSTs `set_interim`.
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

import { CenterLeadershipCard } from "@/components/edit/center-leadership-card";

function okFetch(extra: Record<string, unknown> = {}) {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true, ...extra }) });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
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

describe("CenterLeadershipCard (#2542 Phase C)", () => {
  it("renders one section per role, in prop order, with holders listed", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    const sections = screen
      .getAllByTestId(/^role-editor-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(sections).toEqual([
      "role-editor-director",
      "role-editor-co_director",
      "role-editor-associate_director",
    ]);
    expect(screen.getByTestId("role-holder-director-dir001")).toBeTruthy();
    expect(screen.getByTestId("role-holder-co_director-cod001")).toBeTruthy();
    expect(screen.getByTestId("role-holder-co_director-cod002")).toBeTruthy();
  });

  it("a role absent from the props renders no section at all (server-side allowlist)", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={[ROLES[0]]} />);
    expect(screen.queryByTestId("role-editor-co_director")).toBeNull();
    expect(screen.queryByTestId("role-editor-associate_director")).toBeNull();
  });

  it("no assignable roles at all → the empty-state message, no sections", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={[]} />);
    expect(screen.getByText(/no assignable leadership roles/i)).toBeTruthy();
    expect(screen.queryByTestId(/^role-editor-/)).toBeNull();
  });

  it("a singleHolder role with a holder labels the control 'Replace'; an empty role labels it 'Add'", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    expect(screen.getByTestId("role-add-director").textContent).toBe("Replace");
    expect(screen.getByTestId("role-add-associate_director").textContent).toBe("Add");
    // Multi-holder role also stays "Add" even though it already has holders.
    expect(screen.getByTestId("role-add-co_director").textContent).toBe("Add");
  });

  it("adding to an empty multi-holder role POSTs add with no replace flag", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("pick-role-associate_director"));
    fireEvent.click(screen.getByTestId("role-add-associate_director"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      centerCode: "meyer",
      roleKey: "associate_director",
      action: "add",
      cwid: "new001",
    });
    expect(body).not.toHaveProperty("replace");
    expect(screen.getByTestId("role-holder-associate_director-new001")).toBeTruthy();
  });

  it("replacing a singleHolder incumbent POSTs add with replace:true and swaps the holder", async () => {
    const fetchMock = okFetch({ replacedCwid: "dir001" });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("pick-role-director"));
    fireEvent.click(screen.getByTestId("role-add-director"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({ roleKey: "director", action: "add", cwid: "new001", replace: true });
    await waitFor(() => {
      expect(screen.queryByTestId("role-holder-director-dir001")).toBeNull();
      expect(screen.getByTestId("role-holder-director-new001")).toBeTruthy();
    });
  });

  it("a 409 single-holder conflict surfaces an inline error and does not touch the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: "role_single_holder_conflict", incumbentCwid: "dir001" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterLeadershipCard centerCode="meyer" roles={ROLES} />);
    fireEvent.click(screen.getByTestId("pick-role-director"));
    fireEvent.click(screen.getByTestId("role-add-director"));
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
    // Not yet POSTed — the dialog must be confirmed first.
    expect(fetchMock).not.toHaveBeenCalled();
    const confirmButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({ roleKey: "co_director", action: "remove", cwid: "cod002" });
    await waitFor(() => {
      expect(screen.queryByTestId("role-holder-co_director-cod002")).toBeNull();
    });
    // The untouched co-director stays.
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

  it("picking someone already holding the role shows an inline error instead of POSTing", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    // The typeahead stub always "picks" cwid new001 — give this role an
    // existing holder with that exact cwid so the duplicate guard fires.
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
    fireEvent.click(screen.getByTestId("pick-role-co_director"));
    fireEvent.click(screen.getByTestId("role-add-co_director"));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/already holds this role/i)).toBeTruthy();
  });
});
