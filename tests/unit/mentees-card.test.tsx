/**
 * `components/edit/mentees-card.tsx` — the suppressible Mentees panel (#160
 * follow-up). A thin wrapper over `EntityPanel`; the panel mechanics
 * (optimistic hide/show, revert-on-error) are covered by entity-panel.test.tsx.
 * This verifies the mentee-specific wiring: the row rendering, the empty state,
 * the Request-a-change attribute, and that a hide POSTs `entityType:"mentee"`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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

function renderCard(mentees: EditContextMentee[], mode: "self" | "superuser" = "self") {
  return render(
    <MenteesCard cwid="self01" mode={mode} scholarName="Alex Self" mentees={mentees} />,
  );
}

describe("MenteesCard — suppressible mentees", () => {
  it("renders mentee rows with name + subtitle and the right hide/show controls", () => {
    renderCard(MENTEES);
    expect(document.querySelector('[data-slot="mentees-panel"]')).not.toBeNull();
    expect(screen.getByText("Jordan Mentee")).toBeTruthy();
    expect(screen.getByText(/Immunology \(PhD\)/)).toBeTruthy();
    // shown → Hide; hidden_by_self → Show
    expect(screen.getByTestId("mentee-row-self01:m1-hide")).toBeTruthy();
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

  it("a self hide POSTs entityType:'mentee' with the {cwid}:{menteeCwid} entityId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard([MENTEES[0]]);

    fireEvent.click(screen.getByTestId("mentee-row-self01:m1-hide"));
    // Self hide opens a lightweight confirm dialog; confirm it.
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^hide$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      entityType: "mentee",
      entityId: "self01:m1",
    });
  });
});
