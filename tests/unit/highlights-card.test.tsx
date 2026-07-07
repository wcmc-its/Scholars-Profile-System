/**
 * `components/edit/highlights-card.tsx` — the redesigned Highlights editor (#895
 * UI on top of the #836 data/API). Covers the automatic/manual toggle, the
 * read-only automatic preview, search + sort, the MAX cap, and that Save/Reset
 * hit the existing self-edit endpoints with the preserved contract.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { HighlightsCard } from "@/components/edit/highlights-card";
import type { EditContextHighlights } from "@/lib/api/edit-context";
import { MAX_SELECTED_HIGHLIGHTS as MAX } from "@/lib/edit/validators";

// Five shown pubs; impact + year deliberately diverge so the two sort modes
// produce different orders. (Academic Article relabels to "Research Article".)
const PICKABLE: EditContextHighlights["pickable"] = [
  { pmid: "1", title: "Alpha study on cells", journal: "Cell", year: 2024, impact: 95, publicationType: "Academic Article" },
  { pmid: "2", title: "Beta review of methods", journal: "Nature", year: 2020, impact: 80, publicationType: "Review" },
  { pmid: "3", title: "Gamma trial results", journal: "Lancet", year: 2022, impact: 70, publicationType: "Clinical Trial" },
  { pmid: "4", title: "Delta editorial note", journal: "JAMA", year: 2023, impact: 30, publicationType: "Editorial Article" },
  { pmid: "5", title: "Epsilon letter piece", journal: "BMJ", year: 2025, impact: 10, publicationType: "Letter" },
];

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

function makeHighlights(overrides?: Partial<EditContextHighlights>): EditContextHighlights {
  return {
    manualEnabled: false,
    manualPmids: [],
    aiPmids: ["1", "2", "3"],
    pickable: PICKABLE,
    ...overrides,
  };
}

function renderCard(highlights: EditContextHighlights, mode: "self" | "superuser" = "self") {
  return render(
    <HighlightsCard cwid="self01" mode={mode} scholarName="Alex Self" highlights={highlights} />,
  );
}

function firstRowPmid(): string | null {
  const first = screen
    .getByTestId("highlights-picker")
    .querySelector("[data-testid^='highlights-row-']");
  return first?.getAttribute("data-testid")?.replace("highlights-row-", "") ?? null;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("HighlightsCard — #895 redesigned editor", () => {
  it("renders the automatic preview by default: switch ON, AI top-3 counter, read-only rows, none dimmed", () => {
    renderCard(makeHighlights());
    expect(screen.getByTestId("highlights-auto-switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("highlights-status").textContent).toContain("Automatic.");
    // Counter reflects the AI picks in automatic mode (aiPmids has 3).
    expect(screen.getByTestId("highlights-counter").textContent).toBe(`${MAX} of ${MAX} selected`);
    expect(screen.getByTestId("highlights-opt-in").textContent).toBe("Choose manually");
    // Read-only preview: rows are not interactive, and nothing is greyed out.
    expect(screen.getByTestId("highlights-row-1").getAttribute("role")).toBeNull();
    expect(screen.getByTestId("highlights-row-1").className).not.toContain("opacity-50");
    expect(screen.getByTestId("highlights-row-4").className).not.toContain("opacity-50");
  });

  it("shows the publication type (relabeled) and impact per row", () => {
    renderCard(makeHighlights());
    const row1 = screen.getByTestId("highlights-row-1");
    expect(row1.textContent).toContain("Research Article"); // Academic Article → Research Article
    expect(row1.textContent).toContain("Impact:");
    expect(row1.textContent).toContain("95");
  });

  it("entering manual mode reveals the editable picker seeded from the AI set, with the counter", () => {
    renderCard(makeHighlights());
    fireEvent.click(screen.getByTestId("highlights-opt-in"));
    expect(screen.getByTestId("highlights-auto-switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("highlights-counter").textContent).toBe(`${MAX} of ${MAX} selected`);
    const row1 = screen.getByTestId("highlights-row-1");
    expect(row1.getAttribute("role")).toBe("button");
    expect(row1.getAttribute("aria-pressed")).toBe("true"); // seeded from aiPmids
  });

  it("filters rows by title, journal, or PMID", () => {
    renderCard(makeHighlights());
    fireEvent.change(screen.getByTestId("highlights-search"), { target: { value: "lancet" } });
    expect(screen.getByTestId("highlights-row-3")).toBeTruthy(); // journal = Lancet
    expect(screen.queryByTestId("highlights-row-1")).toBeNull();
    // PMID match
    fireEvent.change(screen.getByTestId("highlights-search"), { target: { value: "5" } });
    expect(screen.getByTestId("highlights-row-5")).toBeTruthy();
    expect(screen.queryByTestId("highlights-row-1")).toBeNull();
  });

  it("sorts by Impact (default) and by Most recent", () => {
    renderCard(makeHighlights());
    expect(firstRowPmid()).toBe("1"); // impact 95 leads
    fireEvent.change(screen.getByTestId("highlights-sort"), { target: { value: "recent" } });
    expect(firstRowPmid()).toBe("5"); // year 2025 leads
  });

  it("caps the manual selection at MAX — an extra pick is a no-op", () => {
    renderCard(makeHighlights({ manualEnabled: true, manualPmids: ["1", "2", "3"] }));
    expect(screen.getByTestId("highlights-counter").textContent).toBe(`${MAX} of ${MAX} selected`);
    const row4 = screen.getByTestId("highlights-row-4");
    expect(row4.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row4);
    expect(screen.getByTestId("highlights-counter").textContent).toBe(`${MAX} of ${MAX} selected`);
  });

  it("saves the ordered selection to /api/edit/field and confirms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(makeHighlights({ aiPmids: ["1"] }));
    fireEvent.click(screen.getByTestId("highlights-opt-in")); // manual, seeded ["1"]
    fireEvent.click(screen.getByTestId("highlights-row-3")); // → ["1","3"]
    fireEvent.click(screen.getByTestId("highlights-row-2")); // → ["1","3","2"]
    const save = screen.getByTestId("highlights-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/field");
    expect(JSON.parse(init.body as string)).toEqual({
      entityType: "scholar",
      entityId: "self01",
      fieldName: "selectedHighlightPmids",
      value: ["1", "3", "2"],
    });
    await waitFor(() => expect(screen.getByTestId("highlights-saved")).toBeTruthy());
  });

  it("reset to automatic clears the override via /api/edit/clear-field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(makeHighlights({ manualEnabled: true, manualPmids: ["1"] }));
    expect(screen.getByTestId("highlights-opt-in").textContent).toBe("Reset to automatic");
    fireEvent.click(screen.getByTestId("highlights-opt-in"));
    // The destructive clear is now gated behind the confirm dialog.
    fireEvent.click(await screen.findByRole("button", { name: "Discard and reset" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/clear-field");
    expect(JSON.parse(init.body as string)).toEqual({
      entityType: "scholar",
      entityId: "self01",
      fieldName: "selectedHighlightPmids",
    });
    await waitFor(() =>
      expect(screen.getByTestId("highlights-auto-switch").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("surfaces an error when the save fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(makeHighlights({ aiPmids: ["1"] }));
    fireEvent.click(screen.getByTestId("highlights-opt-in")); // manual, seeded + dirty
    fireEvent.click(screen.getByTestId("highlights-save"));
    await waitFor(() => expect(screen.getByText(/weren't saved/)).toBeTruthy());
  });

  it("shows the empty state (not the picker) when there are no displayed publications", () => {
    renderCard(makeHighlights({ pickable: [] }));
    expect(screen.queryByTestId("highlights-picker")).toBeNull();
    expect(screen.getByText(/nothing to highlight/)).toBeTruthy();
  });

  // 2026-07-07 review fix: flipping back to automatic destroyed a persisted
  // manual selection with no confirmation. The destructive clear must now be
  // gated behind the dialog — no server write happens on the bare toggle.
  it("does NOT clear the saved manual selection until the reset is confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(makeHighlights({ manualEnabled: true, manualPmids: ["1"] }));

    // The bare "Reset to automatic" toggle opens the dialog but writes nothing.
    fireEvent.click(screen.getByTestId("highlights-opt-in"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Discard and reset" })).toBeTruthy();

    // Only confirming issues the clear-field POST.
    fireEvent.click(screen.getByRole("button", { name: "Discard and reset" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/clear-field");
  });
});
