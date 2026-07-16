/**
 * #1760 — the `HonorsCard` curation editor on its own Honors & Distinctions tab. Mirrors
 * `profile-appointments-card.test.tsx`: the fetch-on-mount list render (with the
 * Hidden marker and the non-`published` status marker the curator view depends
 * on), the add flow (POST create + optimistic append), and the remove flow (POST
 * delete + list prune).
 *
 * All names here are SYNTHETIC — the repo is public and real honor data is PII.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { HonorsCard } from "@/components/edit/honors-card";

type Row = {
  id: string;
  category: "ACADEMY_MEMBERSHIP" | "INVESTIGATORSHIP" | "PRIZE" | "OTHER";
  name: string;
  organization: string;
  year: number | null;
  status: "published" | "pending" | "rejected";
  showOnProfile: boolean;
  source: string;
  sourceRef: string | null;
  enteredByCwid: string;
  createdAt: string;
  updatedAt: string;
};

function row(overrides: Partial<Row>): Row {
  return {
    id: "row-1",
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "National Academy of Medicine",
    year: 2021,
    status: "published",
    showOnProfile: true,
    source: "CURATOR",
    sourceRef: null,
    enteredByCwid: "abc1001",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

/**
 * Route the GET (list) and POST (create/update/delete) off one mock. The POST
 * echoes the posted fields back as a stored row so the optimistic list update
 * has something to render.
 */
function routedFetch(initial: Row[]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") {
      return Promise.resolve(json({ ok: true, honors: initial }));
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body.action === "delete") {
      return Promise.resolve(json({ ok: true, action: "delete", id: body.id, changed: true }));
    }
    const honor = row({
      id: typeof body.id === "string" ? body.id : "row-new",
      category: body.category as Row["category"],
      name: String(body.name),
      organization: String(body.organization),
      year: (body.year as number | null) ?? null,
      showOnProfile: body.showOnProfile !== false,
    });
    return Promise.resolve(json({ ok: true, action: body.action, honor }));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("HonorsCard — the copy must not offer a category that does not exist", () => {
  // Shipped bug: the panel description read "…academy memberships,
  // investigatorships, named chairs, and prizes" while HonorCategory carries NO
  // NAMED_CHAIR member — the UI invited users to add something the dropdown
  // cannot express. Endowed chairs are deliberately out of this pipeline (ED
  // already publishes them via primaryTitle). It survived a grep because the
  // grep was case-SENSITIVE and the prose says "named chairs" in lower case.
  it("never mentions chairs — the category was deliberately removed", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    const { container } = render(
      <HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />,
    );
    await screen.findByText("No honors added yet.");
    expect(container.textContent ?? "").not.toMatch(/chair/i);
  });
});

describe("HonorsCard — list render", () => {
  it("fetches on mount and renders rows with a meta line, Hidden and status markers", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        row({ id: "a", name: "Member", showOnProfile: true }),
        row({ id: "b", name: "Lovelace Prize", category: "PRIZE", showOnProfile: false }),
        row({ id: "c", name: "Babbage Investigator", category: "INVESTIGATORSHIP", status: "pending" }),
      ]),
    );
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);

    expect(await screen.findByText("Member")).toBeTruthy();
    expect(screen.getByText("Lovelace Prize")).toBeTruthy();
    // organization · year join into the muted meta line
    expect(screen.getAllByText(/National Academy of Medicine · 2021/)[0]).toBeTruthy();
    // the hidden row carries a Hidden marker; a non-published row carries its status
    expect(screen.getByText(/Hidden/)).toBeTruthy();
    expect(screen.getByText(/Pending review/)).toBeTruthy();
  });

  it("shows an empty state when the scholar has no honors", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<HonorsCard cwid="nobody" mode="self" scholarName="No One" />);
    expect(await screen.findByText(/No honors added yet/i)).toBeTruthy();
  });

  it("surfaces a load error when the GET fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, false)));
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    expect(await screen.findByText(/couldn.t load these honors/i)).toBeTruthy();
  });
});

describe("HonorsCard — mutations", () => {
  it("creates a row: POSTs action=create with the owner cwid, then appends it", async () => {
    const fetchMock = routedFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText(/No honors added yet/i);

    fireEvent.click(screen.getByTestId("honor-add"));
    fireEvent.change(screen.getByTestId("honor-name-add"), { target: { value: "Fellow" } });
    fireEvent.change(screen.getByTestId("honor-organization-add"), {
      target: { value: "Royal Society" },
    });
    fireEvent.change(screen.getByTestId("honor-year-add"), { target: { value: "2024" } });
    fireEvent.click(screen.getByTestId("honor-submit-add"));

    expect(await screen.findByText("Fellow")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      cwid: "abc1001",
      action: "create",
      name: "Fellow",
      organization: "Royal Society",
      year: 2024,
      // the enum-order default from the shared HONOR_CATEGORIES contract
      category: "ACADEMY_MEMBERSHIP",
    });
  });

  it("posts a blank year as null rather than an empty string", async () => {
    const fetchMock = routedFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText(/No honors added yet/i);

    fireEvent.click(screen.getByTestId("honor-add"));
    fireEvent.change(screen.getByTestId("honor-name-add"), { target: { value: "Fellow" } });
    fireEvent.change(screen.getByTestId("honor-organization-add"), {
      target: { value: "Royal Society" },
    });
    fireEvent.click(screen.getByTestId("honor-submit-add"));

    await screen.findByText("Fellow");
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((createCall![1] as RequestInit).body)).year).toBeNull();
  });

  it("blocks submit until the honor and the organization are both filled", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText(/No honors added yet/i);

    fireEvent.click(screen.getByTestId("honor-add"));
    const submit = screen.getByTestId("honor-submit-add") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("honor-name-add"), { target: { value: "Fellow" } });
    expect(submit.disabled).toBe(true); // organization still empty

    fireEvent.change(screen.getByTestId("honor-organization-add"), {
      target: { value: "Royal Society" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("blocks submit on an implausible year but allows a blank one", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText(/No honors added yet/i);

    fireEvent.click(screen.getByTestId("honor-add"));
    fireEvent.change(screen.getByTestId("honor-name-add"), { target: { value: "Fellow" } });
    fireEvent.change(screen.getByTestId("honor-organization-add"), {
      target: { value: "Royal Society" },
    });
    const submit = screen.getByTestId("honor-submit-add") as HTMLButtonElement;

    fireEvent.change(screen.getByTestId("honor-year-add"), { target: { value: "12" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("honor-year-add"), { target: { value: "" } });
    expect(submit.disabled).toBe(false);
  });

  it("offers the conferring bodies as datalist suggestions without closing the field", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText(/No honors added yet/i);

    fireEvent.click(screen.getByTestId("honor-add"));
    const org = screen.getByTestId("honor-organization-add") as HTMLInputElement;
    const list = screen.getByTestId("honor-organization-options-add");
    // the input is bound to the datalist ...
    expect(org.getAttribute("list")).toBe(list.id);
    expect(list.querySelectorAll("option").length).toBeGreaterThan(0);
    // ... but free entry still wins: an unlisted body is accepted
    fireEvent.change(screen.getByTestId("honor-name-add"), { target: { value: "Fellow" } });
    fireEvent.change(org, { target: { value: "An Unlisted Society" } });
    expect((screen.getByTestId("honor-submit-add") as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes a row: POSTs action=delete and prunes the list", async () => {
    const fetchMock = routedFetch([row({ id: "a", name: "Member" })]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HonorsCard cwid="abc1001" mode="self" scholarName="Ada Lovelace" />);
    await screen.findByText("Member");

    fireEvent.click(screen.getByTestId("honor-remove-a"));

    await waitFor(() => expect(screen.queryByText("Member")).toBeNull());
    const deleteCall = fetchMock.mock.calls.find(([, init]) => {
      const i = init as RequestInit | undefined;
      return i?.method === "POST" && JSON.parse(String(i.body)).action === "delete";
    });
    expect(deleteCall).toBeTruthy();
  });
});
