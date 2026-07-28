/**
 * #2011 — the `ManualMenteesCard` editor above the hide-only Mentees panel.
 *
 * The card holds the WHOLE list in one `field_override` JSON array, so the
 * risks are different from the per-row appointment/honor cards: every mutation
 * must POST the FULL array (a partial write silently deletes the other rows),
 * and local state must not advance until the server accepts it.
 *
 * Synthetic names only — this repo is public.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ManualMenteesCard } from "@/components/edit/manual-mentees-card";
import type { ManualMentee } from "@/lib/edit/manual-mentee";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function mockPost(body: object = { ok: true }, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The parsed `value` of the single POST the card fired. */
function postedValue(fetchMock: ReturnType<typeof mockPost>): unknown {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)).value;
}

function renderCard(initial: ManualMentee[]) {
  return render(
    <ManualMenteesCard cwid="abc1001" mode="self" scholarName="Alex Self" initial={initial} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ManualMenteesCard", () => {
  it("renders the stored rows, showing the cwid only when there is one", () => {
    renderCard([
      { name: "Rowan Ellis", programLabel: "Visiting student", year: 2019 },
      { name: "Sam Okafor", cwid: "sao4001" },
    ]);
    expect(screen.getByText("Rowan Ellis")).toBeTruthy();
    expect(screen.getByText("Visiting student · 2019")).toBeTruthy();
    expect(screen.getByText("sao4001")).toBeTruthy();
  });

  it("renders its heading as a peer h2, not a subordinate h3", () => {
    // The scholar-authored panel must not read as subordinate to the read-only
    // roster beside it. `subsection` would render a muted uppercase h3.
    renderCard([]);
    const heading = screen.getByText("Added by you");
    expect(heading.tagName).toBe("H2");
    // ...and must NOT claim the id `<main aria-labelledby>` points at — the
    // sourced panel below already holds it, and two would be a duplicate id.
    expect(heading.id).toBe("manual-mentees-heading");
  });

  it("asks for the CWID first and says what it buys, without requiring it", () => {
    renderCard([]);
    fireEvent.click(screen.getByTestId("manual-mentee-add"));

    expect(screen.getByText(/WCM CWID \(optional\)/)).toBeTruthy();
    expect(
      screen.getByText(/links their profile, shows their photo, and surfaces the publications/),
    ).toBeTruthy();
    // Name alone is enough to submit — the whole point of the feature.
    fireEvent.change(screen.getByTestId("manual-mentee-name-add"), {
      target: { value: "Rowan Ellis" },
    });
    expect((screen.getByTestId("manual-mentee-submit-add") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("POSTs the FULL array on add — not just the new row", async () => {
    const fetchMock = mockPost();
    renderCard([{ name: "Sam Okafor", cwid: "sao4001" }]);

    fireEvent.click(screen.getByTestId("manual-mentee-add"));
    fireEvent.change(screen.getByTestId("manual-mentee-name-add"), {
      target: { value: "Rowan Ellis" },
    });
    fireEvent.change(screen.getByTestId("manual-mentee-year-add"), { target: { value: "2019" } });
    fireEvent.click(screen.getByTestId("manual-mentee-submit-add"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A partial write here would silently delete the pre-existing row.
    expect(postedValue(fetchMock)).toEqual([
      { name: "Sam Okafor", cwid: "sao4001" },
      { name: "Rowan Ellis", year: 2019 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/edit/field");
    expect(JSON.parse(String(init.body)).fieldName).toBe("manualMentees");
  });

  it("normalizes the draft: lowercased cwid, numeric year, blanks dropped", async () => {
    const fetchMock = mockPost();
    renderCard([]);

    fireEvent.click(screen.getByTestId("manual-mentee-add"));
    fireEvent.change(screen.getByTestId("manual-mentee-name-add"), {
      target: { value: "  Rowan Ellis  " },
    });
    fireEvent.change(screen.getByTestId("manual-mentee-cwid-add"), { target: { value: "REL2002" } });
    fireEvent.change(screen.getByTestId("manual-mentee-program-add"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("manual-mentee-submit-add"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedValue(fetchMock)).toEqual([{ name: "Rowan Ellis", cwid: "rel2002" }]);
  });

  it("POSTs the array minus the removed row", async () => {
    const fetchMock = mockPost();
    renderCard([{ name: "Rowan Ellis" }, { name: "Sam Okafor", cwid: "sao4001" }]);

    fireEvent.click(screen.getByTestId("manual-mentee-remove-0"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedValue(fetchMock)).toEqual([{ name: "Sam Okafor", cwid: "sao4001" }]);
  });

  it("blocks submit on a malformed cwid but not on a blank one", () => {
    renderCard([]);
    fireEvent.click(screen.getByTestId("manual-mentee-add"));
    fireEvent.change(screen.getByTestId("manual-mentee-name-add"), { target: { value: "Rowan" } });

    fireEvent.change(screen.getByTestId("manual-mentee-cwid-add"), { target: { value: "9zz" } });
    expect((screen.getByTestId("manual-mentee-submit-add") as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(screen.getByTestId("manual-mentee-cwid-add"), { target: { value: "" } });
    expect((screen.getByTestId("manual-mentee-submit-add") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("keeps the row on screen and surfaces the reason when the write is rejected", async () => {
    mockPost({ ok: false, error: "duplicate" }, false);
    renderCard([{ name: "Sam Okafor", cwid: "sao4001" }]);

    fireEvent.click(screen.getByTestId("manual-mentee-remove-0"));

    await waitFor(() =>
      expect(screen.getByText("You’ve already added a mentee with that CWID.")).toBeTruthy(),
    );
    // Local state must not advance past what the server actually stored.
    expect(screen.getByText("Sam Okafor")).toBeTruthy();
  });
});
