/**
 * The Faculty Review Tool panel inside `MenteeSuggestionsCard`: match state per
 * row, add-as-mentee carrying the CWID into `manualMentees`, dismiss.
 * Fictional people — this repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { MenteeSuggestionsCard } from "@/components/edit/mentee-suggestions-card";
import type { EditContextFrtMentee } from "@/lib/api/edit-context";

const frt = (
  p: Partial<EditContextFrtMentee> & Pick<EditContextFrtMentee, "id" | "menteeName">,
) => ({
  menteeCwid: null,
  menteeCwidName: null,
  cwidAssigned: false,
  mentoringType: "Research",
  external: false,
  firstReviewYear: 2023,
  lastReviewYear: 2026,
  dismissedAt: null,
  ...p,
});

const ROWS: EditContextFrtMentee[] = [
  frt({ id: 11, menteeName: "Lee Park" }),
  frt({ id: 12, menteeName: "Ana Ruiz", menteeCwid: "anr2002", menteeCwidName: "Ana M. Ruiz" }),
];

function renderCard() {
  render(
    <MenteeSuggestionsCard
      cwid="self01"
      suggestions={[]}
      frtMentees={ROWS}
      manualMentees={[{ name: "Sam Stone" }]}
    />,
  );
}

const body = (i: number) =>
  JSON.parse(
    String(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[i] as [string, RequestInit])[1]
        .body,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("FRT mentee suggestions", () => {
  it("says a name-only row won't show co-publications; a matched row names the person", () => {
    renderCard();
    expect(screen.queryByTestId("mentee-suggestions-panel")).toBeNull(); // no co-author rows
    expect(screen.getByTestId("frt-mentee-match-11").textContent).toContain("Not linked");
    expect(screen.getByTestId("frt-mentee-link-11").textContent).toBe("Link to a WCM person");
    expect(screen.getByTestId("frt-mentee-match-12").textContent).toContain("Ana M. Ruiz");
    expect(screen.getByTestId("frt-mentee-match-12").textContent).toContain("matched by name");
    expect(screen.getByTestId("frt-mentee-link-12").textContent).toBe("Change person");
  });

  it("Add as mentee writes the matched CWID and keeps existing name-only entries", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("frt-mentee-add-12"));
    fireEvent.click(screen.getByTestId("manual-mentee-submit-frt-add-12"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(body(0).value).toEqual([
      { name: "Sam Stone" },
      { name: "Ana M. Ruiz", cwid: "anr2002", programLabel: "Research" },
    ]);
    await waitFor(() => expect(screen.queryByTestId("frt-mentee-12")).toBeNull());
  });

  it("Not a mentee POSTs dismiss and moves the row to the dismissed footer", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("frt-mentee-not-11"));
    await waitFor(() => expect(screen.getByTestId("frt-mentee-dismissed-11")).toBeTruthy());
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "/api/edit/frt-mentees/11",
    );
    expect(body(0)).toEqual({ op: "dismiss" });
  });
});
