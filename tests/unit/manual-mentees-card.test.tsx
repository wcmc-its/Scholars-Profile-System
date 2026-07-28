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

function renderCard(initial: ManualMentee[], unresolvedCwids?: string[]) {
  return render(
    <ManualMenteesCard
      cwid="abc1001"
      mode="self"
      scholarName="Alex Self"
      initial={initial}
      unresolvedCwids={unresolvedCwids}
    />,
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

  describe("unresolved-CWID notice (#2011 follow-up)", () => {
    // A CWID is format-checked but never existence-checked, on purpose: alumni
    // legitimately hold one with no Scholar row. The cost is that a TYPO looks
    // identical to a legitimate alum. Staging carried `evs2001` for `evs2008`
    // for days — no photo, no profile link, no co-pubs, and no signal anywhere.
    it("flags the entry whose CWID matches no WCM scholar", () => {
      renderCard([{ name: "Sam Okafor", cwid: "sao4001" }], ["sao4001"]);
      const notice = screen.getByTestId("manual-mentee-unresolved-0");
      expect(notice.textContent).toContain("No WCM profile matches");
      expect(notice.textContent).toContain("sao4001");
    });

    it("stays SILENT for a CWID that does resolve", () => {
      renderCard([{ name: "Sam Okafor", cwid: "sao4001" }], []);
      expect(screen.queryByTestId("manual-mentee-unresolved-0")).toBeNull();
    });

    it("flags only the offending row in a mixed list", () => {
      renderCard(
        [
          { name: "Rowan Ellis", cwid: "rel2002" },
          { name: "Sam Okafor", cwid: "sao4001" },
        ],
        ["sao4001"],
      );
      expect(screen.queryByTestId("manual-mentee-unresolved-0")).toBeNull();
      expect(screen.getByTestId("manual-mentee-unresolved-1")).toBeTruthy();
    });

    it("says nothing about a CWID-less entry — absent is not unresolved", () => {
      // The population this card exists for. A plain-name entry is working as
      // designed and must never be nagged about a CWID it deliberately lacks.
      renderCard([{ name: "Rowan Ellis" }], ["sao4001"]);
      expect(screen.queryByTestId("manual-mentee-unresolved-0")).toBeNull();
    });

    it("does NOT block editing or removal — the entry is valid and saveable", () => {
      // The notice must read as information, not rejection: an alum with a real
      // CWID and no Scholars profile is a legitimate, permanent state.
      renderCard([{ name: "Sam Okafor", cwid: "sao4001" }], ["sao4001"]);
      expect(screen.getByTestId("manual-mentee-unresolved-0")).toBeTruthy();
      expect(screen.getByTestId("manual-mentee-edit-0").hasAttribute("disabled")).toBe(false);
      expect(screen.getByTestId("manual-mentee-remove-0").hasAttribute("disabled")).toBe(false);
    });

    it("treats an absent prop as nothing-to-flag rather than everything-unresolved", () => {
      renderCard([{ name: "Sam Okafor", cwid: "sao4001" }]);
      expect(screen.queryByTestId("manual-mentee-unresolved-0")).toBeNull();
    });
  });
});
