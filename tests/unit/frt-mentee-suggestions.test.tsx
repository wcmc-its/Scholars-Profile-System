/**
 * The Faculty Review Tool panel inside `MenteeSuggestionsCard`: match state per
 * row, add-as-mentee carrying the CWID into `manualMentees`, dismiss.
 * Fictional people — this repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

  it("groups rows: linked, then not linked, then outside WCM collapsed; no filter on a short list", () => {
    render(
      <MenteeSuggestionsCard
        cwid="self01"
        suggestions={[]}
        frtMentees={[...ROWS, frt({ id: 13, menteeName: "Kim Lopez", external: true })]}
        manualMentees={[]}
      />,
    );
    expect(
      within(screen.getByTestId("frt-mentees-linked")).getByTestId("frt-mentee-12"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("frt-mentees-unlinked")).getByTestId("frt-mentee-11"),
    ).toBeTruthy();
    const outside = screen.getByTestId("frt-mentees-outside") as HTMLDetailsElement;
    expect(outside.open).toBe(false);
    expect(outside.textContent).toContain("1 outside WCM");
    expect(within(outside).getByTestId("frt-mentee-13")).toBeTruthy();
    expect(screen.queryByTestId("frt-mentees-filter")).toBeNull();
  });

  it("over 15 rows: a name filter narrows every group, matching the linked person's name too", () => {
    const many = Array.from({ length: 16 }, (_, i) =>
      frt({ id: 100 + i, menteeName: `Person ${i}`, external: i % 2 === 0 }),
    );
    render(
      <MenteeSuggestionsCard
        cwid="self01"
        suggestions={[]}
        frtMentees={[
          ...many,
          frt({
            id: 12,
            menteeName: "A. Ruiz",
            menteeCwid: "anr2002",
            menteeCwidName: "Ana M. Ruiz",
          }),
        ]}
        manualMentees={[]}
      />,
    );
    const filter = screen.getByTestId("frt-mentees-filter");
    fireEvent.change(filter, { target: { value: "ana m" } });
    expect(screen.getByTestId("frt-mentee-12")).toBeTruthy();
    expect(screen.queryByTestId("frt-mentee-101")).toBeNull();
    fireEvent.change(filter, { target: { value: "person 1" } });
    expect(screen.getByTestId("frt-mentee-101")).toBeTruthy(); // not linked
    expect((screen.getByTestId("frt-mentees-outside") as HTMLDetailsElement).open).toBe(true);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByTestId("frt-mentees-no-match")).toBeTruthy();
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
