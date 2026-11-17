/**
 * `components/edit/mentees-card.tsx` — the suppressible Mentees panel (#160
 * follow-up). A thin wrapper over `EntityPanel`; the panel mechanics
 * (optimistic hide/show, revert-on-error) are covered by entity-panel.test.tsx.
 * This verifies the mentee-specific wiring: the row rendering, the empty state,
 * the Request-a-change attribute, and that a hide POSTs `entityType:"mentee"`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { MenteesCard } from "@/components/edit/mentees-card";
import type { EditContextMentee } from "@/lib/api/edit-context";

const MENTEES: EditContextMentee[] = [
  {
    externalId: "self01:m1",
    name: "Jordan Mentee",
    subtitle: "Immunology (PhD)",
    state: "shown",
    suppressionId: null,
  },
  {
    externalId: "self01:m2",
    name: "Robin Hidden",
    subtitle: "Postdoc",
    state: "hidden_by_self",
    suppressionId: "sup-m2",
  },
];

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

function renderCard(
  mentees: EditContextMentee[],
  mode: "self" | "superuser" = "self",
  currentPositions?: Record<string, string>,
) {
  return render(
    <MenteesCard
      cwid="self01"
      mode={mode}
      scholarName="Alex Self"
      mentees={mentees}
      currentPositions={currentPositions}
    />,
  );
}

describe("MenteesCard — suppressible mentees", () => {
  it("renders mentee rows with name + subtitle and the right hide/show controls", () => {
    renderCard(MENTEES);
    expect(document.querySelector('[data-slot="mentees-panel"]')).not.toBeNull();
    expect(screen.getByText("Jordan Mentee")).toBeTruthy();
    expect(screen.getByText(/Immunology \(PhD\)/)).toBeTruthy();
    // shown → a select checkbox (hiding is the bulk verb); hidden_by_self → Show
    expect(
      screen.getByRole("checkbox", { name: "Select Jordan Mentee, Immunology (PhD)" }),
    ).toBeTruthy();
    expect(screen.getByTestId("mentee-row-self01:m2-show")).toBeTruthy();
  });

  it("falls back to a 'Program unknown' meta when subtitle is null", () => {
    renderCard([
      { externalId: "self01:m3", name: "No Program", subtitle: null, state: "shown", suppressionId: null },
    ]);
    expect(screen.getByText("Program unknown")).toBeTruthy();
  });

  it("shows the self empty state", () => {
    renderCard([]);
    expect(screen.getByText("You have no recorded mentees.")).toBeTruthy();
  });

  it("shows the superuser empty state", () => {
    renderCard([], "superuser");
    expect(screen.getByText("This scholar has no recorded mentees.")).toBeTruthy();
  });

  it("shows a stored current position, and an Add button on a row without one", () => {
    renderCard(MENTEES, "self", { m1: "Assistant Professor, Example University" });
    expect(screen.getByTestId("mentee-position-self01:m1").textContent).toContain(
      "Now: Assistant Professor, Example University",
    );
    expect(screen.getByTestId("mentee-position-self01:m1-edit").textContent).toBe("Edit");
    expect(screen.getByTestId("mentee-position-self01:m2-edit").textContent).toBe(
      "Add current position",
    );
    // The position stays out of the hide checkbox's accessible name.
    expect(
      screen.getByRole("checkbox", { name: "Select Jordan Mentee, Immunology (PhD)" }),
    ).toBeTruthy();
  });

  it("saving one row POSTs the WHOLE map — other mentees' positions survive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    // `gone9` is a mentee no longer on the roster; its entry must round-trip.
    renderCard(MENTEES, "self", { m2: "Fellow", gone9: "Staff Scientist" });

    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-edit"));
    fireEvent.change(screen.getByTestId("mentee-position-self01:m1-input"), {
      target: { value: "  Group Leader, Example Institute " },
    });
    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/field");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      entityType: "scholar",
      entityId: "self01",
      fieldName: "menteeCurrentPositions",
      value: { m1: "Group Leader, Example Institute", m2: "Fellow", gone9: "Staff Scientist" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("mentee-position-self01:m1").textContent).toContain(
        "Now: Group Leader, Example Institute",
      ),
    );
  });

  it("clearing the input removes that mentee's entry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(MENTEES, "self", { m1: "Fellow", m2: "Staff Scientist" });

    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-edit"));
    fireEvent.change(screen.getByTestId("mentee-position-self01:m1-input"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).value).toEqual({ m2: "Staff Scientist" });
  });

  it("keeps the input open with an error when the save is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: "not_self" }) }),
    );
    renderCard([MENTEES[0]]);

    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-edit"));
    fireEvent.change(screen.getByTestId("mentee-position-self01:m1-input"), {
      target: { value: "Fellow" },
    });
    fireEvent.click(screen.getByTestId("mentee-position-self01:m1-save"));

    expect((await screen.findByRole("alert")).textContent).toContain("couldn’t save");
    expect(screen.getByTestId("mentee-position-self01:m1-input")).toBeTruthy();
  });

  it("a self hide POSTs entityType:'mentee' with the {cwid}:{menteeCwid} entityId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard([MENTEES[0]]);

    // Select the row, then hide the selection from the bar. A self hide is
    // direct — no confirm dialog.
    fireEvent.click(screen.getByRole("checkbox", { name: /^Select Jordan Mentee/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      entityType: "mentee",
      entityId: "self01:m1",
    });
  });
});
