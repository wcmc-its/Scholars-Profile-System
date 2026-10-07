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
  suggestedCwid: null,
  suggestedCwidName: null,
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

  it("FRT panel leads; a co-author who is also an FRT mentee shows once, on the FRT row", () => {
    const coauthor = (id: number, menteeCwid: string, menteeName: string) => ({
      id,
      menteeCwid,
      menteeName,
      menteeTitle: null,
      menteeUnit: null,
      kind: "postdoc" as const,
      tier: "presumptive" as const,
      nCoPubs: 3,
      nMentorLastAuthor: 1,
      firstYear: 2023,
      lastYear: 2025,
      menteeFirstPublishedYear: 2020,
      strong: false,
      dismissedAt: null,
      dismissReason: null,
      evidence: [],
    });
    const { container } = render(
      <MenteeSuggestionsCard
        cwid="self01"
        suggestions={[coauthor(1, "anr2002", "Ana Ruiz"), coauthor(2, "oth3003", "Omar Other")]}
        frtMentees={ROWS}
        manualMentees={[]}
      />,
    );
    const panels = [...container.querySelectorAll("[data-slot$='-panel']")].map((e) =>
      e.getAttribute("data-slot"),
    );
    expect(panels).toEqual(["frt-mentee-suggestions-panel", "mentee-suggestions-panel"]);
    // One h2#panel-heading per page; the second panel carries its own id.
    expect(container.querySelectorAll("#panel-heading")).toHaveLength(1);
    expect(container.querySelector("#mentee-suggestions-coauthor-heading")).not.toBeNull();
    expect(screen.queryByTestId("mentee-suggestion-1")).toBeNull(); // folded into FRT row 12
    expect(screen.getByTestId("mentee-suggestion-2")).toBeTruthy();
    expect(screen.getByTestId("frt-mentee-coauthor-12").textContent).toBe(
      "Also a co-author: 3 co-authored publications",
    );
    expect(screen.queryByTestId("frt-mentee-coauthor-11")).toBeNull();
  });

  it("offers a nickname-only match as a one-click link, never as already linked", async () => {
    render(
      <MenteeSuggestionsCard
        cwid="self01"
        suggestions={[]}
        frtMentees={[
          ...ROWS,
          frt({
            id: 14,
            menteeName: "Bob Wexley",
            suggestedCwid: "zzf0001",
            suggestedCwidName: "Robert Wexley",
          }),
        ]}
        manualMentees={[]}
      />,
    );
    expect(screen.queryByTestId("frt-mentee-suggested-11")).toBeNull();
    expect(screen.getByTestId("frt-mentee-match-14").textContent).toContain("Not linked");
    expect(
      within(screen.getByTestId("frt-mentees-unlinked")).getByTestId("frt-mentee-14"),
    ).toBeTruthy();
    expect(screen.getByTestId("frt-mentee-suggested-14").textContent).toContain(
      "Possible match: Robert Wexley zzf0001 · nickname match",
    );
    fireEvent.click(screen.getByTestId("frt-mentee-suggested-link-14"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(body(0)).toEqual({ op: "assign", cwid: "zzf0001" });
    await waitFor(() =>
      expect(screen.getByTestId("frt-mentee-match-14").textContent).toContain("Robert Wexley"),
    );
    expect(screen.queryByTestId("frt-mentee-suggested-14")).toBeNull();
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
