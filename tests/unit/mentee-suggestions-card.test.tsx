/**
 * `components/edit/mentee-suggestions-card.tsx` — the #2634 "Mentees › From your
 * publications" sub-view. Partition (default list vs the three collapsed
 * footers), the per-row evidence rendering (PMID link / Scopus text, byline from
 * ranks, full-title toggle), and the three writes (dismiss with a reason,
 * restore, add-as-mentee = the WHOLE manualMentees array + the new entry).
 *
 * Fictional people and PMIDs — this repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { MenteeSuggestionsCard, bylineOf } from "@/components/edit/mentee-suggestions-card";
import type { EditContextMenteeSuggestion } from "@/lib/api/edit-context";

const LONG_TITLE =
  "Single-cell atlas of neonatal immune development in preterm infants: a longitudinal cohort study of 412 very-low-birth-weight neonates across three NICUs";

function row(
  p: Partial<EditContextMenteeSuggestion> &
    Pick<EditContextMenteeSuggestion, "id" | "menteeCwid" | "menteeName">,
): EditContextMenteeSuggestion {
  return {
    menteeTitle: null,
    menteeUnit: "Pediatrics",
    kind: "postdoc",
    tier: "presumptive",
    nCoPubs: 2,
    nMentorLastAuthor: 1,
    firstYear: 2023,
    lastYear: 2026,
    menteeFirstPublishedYear: 2021,
    strong: false,
    dismissedAt: null,
    dismissReason: null,
    evidence: [],
    ...p,
  };
}

const ROWS: EditContextMenteeSuggestion[] = [
  // Ambiguous, listed FIRST in the input so the strong-first sort is observable.
  row({
    id: 2,
    menteeCwid: "wez4003",
    menteeName: "Wei Zhang",
    menteeTitle: "Research Associate",
    menteeUnit: "Medicine",
    kind: "research_staff",
    tier: "ambiguous",
    nCoPubs: 12,
    nMentorLastAuthor: 6,
    firstYear: 2015,
    menteeFirstPublishedYear: 2009,
  }),
  row({
    id: 1,
    menteeCwid: "pxr4012",
    menteeName: "Priya Raman",
    menteeTitle: "Postdoctoral Associate",
    nCoPubs: 7,
    nMentorLastAuthor: 5,
    strong: true,
    evidence: [
      {
        id: "41022331",
        year: 2026,
        title: LONG_TITLE,
        journal: "J Clin Invest",
        menteeRank: 1,
        mentorRank: 9,
        total: 9,
      },
      {
        id: "40118872",
        year: 2025,
        title: "Maternal antibody transfer in preterm infants",
        journal: "Nat Med",
        menteeRank: 1,
        mentorRank: 7,
        total: 7,
      },
      {
        id: "SCOPUS:105037533819",
        year: 2025,
        title: "Cytomegalovirus reactivation and outcomes",
        journal: "Pediatrics",
        menteeRank: 2,
        mentorRank: 3,
        total: 8,
      },
      {
        id: "39001122",
        year: 2024,
        title: "A fourth paper",
        journal: "J Pediatr",
        menteeRank: 1,
        mentorRank: 5,
        total: 5,
      },
    ],
  }),
  // Unknown tier → collapsed footer, never the default list.
  row({
    id: 3,
    menteeCwid: "sxo4009",
    menteeName: "Sam Okafor",
    kind: "collaborator",
    tier: "unknown",
    nCoPubs: 3,
  }),
  // One co-authored paper → "weaker matches" footer.
  row({
    id: 4,
    menteeCwid: "lxp4001",
    menteeName: "Lee Park",
    kind: "doctoral",
    nCoPubs: 1,
    nMentorLastAuthor: 1,
  }),
  // Already dismissed → "dismissed" footer with Restore.
  row({
    id: 5,
    menteeCwid: "kao4007",
    menteeName: "Kate Ojo",
    kind: "volunteer",
    dismissedAt: "2026-09-01T00:00:00.000Z",
    dismissReason: "colleague",
  }),
];

function renderCard(over: Partial<React.ComponentProps<typeof MenteeSuggestionsCard>> = {}) {
  return render(
    <MenteeSuggestionsCard
      cwid="self01"
      mode="self"
      scholarName="Alex Self"
      suggestions={ROWS}
      manualMentees={[
        { name: "Rowan Ellis", cwid: "rce4001", programLabel: "Visiting student", year: 2024 },
      ]}
      {...over}
    />,
  );
}

function postedBody(i = 0): { url: string; body: unknown } {
  const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[i] as [
    string,
    RequestInit,
  ];
  return { url, body: JSON.parse(String(init.body)) };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("MenteeSuggestionsCard", () => {
  it("default list = presumptive/ambiguous with ≥2 co-pubs, strong first; the rest collapse into three footers", () => {
    renderCard();
    const list = within(screen.getByTestId("mentee-suggestions-list"));
    const items = list
      .getAllByRole("listitem")
      .filter(
        (li) =>
          li.dataset.testid?.startsWith("mentee-suggestion-") &&
          /^\d+$/.test(li.dataset.testid.slice("mentee-suggestion-".length)),
      );
    expect(items.map((li) => li.dataset.testid)).toEqual([
      "mentee-suggestion-1",
      "mentee-suggestion-2",
    ]);
    expect(list.getByTestId("mentee-suggestion-strong-1").textContent).toBe("Strong match");
    expect(list.queryByTestId("mentee-suggestion-strong-2")).toBeNull();
    // Ambiguous tier shows the ED title on the right and the staff-role hint.
    expect(list.getByTestId("mentee-suggestion-title-2").textContent).toBe("Research Associate");
    expect(list.getByTestId("mentee-suggestion-hint-2").textContent).toMatch(/may be a colleague/);
    expect(list.queryByTestId("mentee-suggestion-hint-1")).toBeNull();
    // Evidence line.
    expect(list.getByTestId("mentee-suggestion-evidence-1").textContent).toBe(
      "7 co-authored · 5 with you as last author · 2023–2026",
    );
    // Footers hold the unknown-tier, weak, and dismissed rows.
    expect(
      within(screen.getByTestId("mentee-suggestions-unknown")).getByTestId("mentee-suggestion-3"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("mentee-suggestions-unknown").querySelector("summary")?.textContent,
    ).toMatch(/1 other co-author whose career stage/);
    expect(
      within(screen.getByTestId("mentee-suggestions-weak")).getByTestId("mentee-suggestion-4"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("mentee-suggestions-weak").querySelector("summary")?.textContent,
    ).toBe("1 weaker match (1 co-authored paper each)");
    expect(
      within(screen.getByTestId("mentee-suggestions-dismissed")).getByTestId(
        "mentee-suggestion-dismissed-5",
      ).textContent,
    ).toContain("Colleague or collaborator");
  });

  it("evidence: first 3 pubs + Show more, PMID link vs Scopus text, byline from ranks, full-title toggle", () => {
    renderCard();
    const pubs = within(screen.getByTestId("mentee-suggestion-pubs-1"));
    expect(pubs.queryByTestId("mentee-suggestion-copubs-link-1")).toBeNull();
    expect(pubs.getByTestId("mentee-suggestion-pub-link-41022331").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/41022331/",
    );
    expect(pubs.getByTestId("mentee-suggestion-pub-SCOPUS:105037533819").textContent).toContain(
      "Scopus 105037533819",
    );
    expect(pubs.queryByTestId("mentee-suggestion-pub-link-SCOPUS:105037533819")).toBeNull();
    expect(pubs.getByTestId("mentee-suggestion-pub-41022331").textContent).toContain(
      "Raman 1st of 9 · you last",
    );
    expect(pubs.getByTestId("mentee-suggestion-pub-SCOPUS:105037533819").textContent).toContain(
      "Raman 2nd of 8 · you 3rd",
    );
    // Only the long title gets the toggle; it flips the label and drops the clamp.
    const title = pubs.getByTestId("mentee-suggestion-pub-title-41022331");
    expect(title.className).toContain("line-clamp-2");
    const toggle = pubs.getByTestId("mentee-suggestion-pub-toggle-41022331");
    // A toggle INSIDE the clamped block is clipped by the overflow it exists to
    // reveal (verifier's headless-Chromium probe); it must be a sibling.
    expect(title.contains(toggle)).toBe(false);
    expect(toggle.textContent).toBe("[full ›]");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("[less ‹]");
    expect(pubs.getByTestId("mentee-suggestion-pub-title-41022331").className).not.toContain(
      "line-clamp-2",
    );
    expect(pubs.queryByTestId("mentee-suggestion-pub-toggle-40118872")).toBeNull();
    // 4 evidence rows → 3 shown, "Show 1 more" reveals the fourth.
    expect(pubs.queryByTestId("mentee-suggestion-pub-39001122")).toBeNull();
    fireEvent.click(pubs.getByTestId("mentee-suggestion-more-1"));
    expect(pubs.getByTestId("mentee-suggestion-pub-39001122")).toBeTruthy();
  });

  it("Not a mentee → chosen reason is POSTed to /dismiss and the row moves to the dismissed footer", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("mentee-suggestion-not-2"));
    const dismiss = screen.getByTestId("mentee-suggestion-dismiss-2") as HTMLButtonElement;
    expect(dismiss.disabled).toBe(true); // no reason chosen yet
    fireEvent.click(screen.getByTestId("mentee-suggestion-reason-never_worked-2"));
    fireEvent.click(dismiss);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({
      url: "/api/edit/mentee-suggestions/2/dismiss",
      body: { reason: "never_worked" },
    });
    expect(
      within(screen.getByTestId("mentee-suggestions-list")).queryByTestId("mentee-suggestion-2"),
    ).toBeNull();
    expect(screen.getByTestId("mentee-suggestion-dismissed-2").textContent).toContain(
      "We never worked together",
    );
  });

  it("Restore POSTs to /restore and the row returns to the default list", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("mentee-suggestion-restore-5"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(postedBody().url).toBe("/api/edit/mentee-suggestions/5/restore");
    expect(
      within(screen.getByTestId("mentee-suggestions-list")).getByTestId("mentee-suggestion-5"),
    ).toBeTruthy();
    expect(screen.queryByTestId("mentee-suggestions-dismissed")).toBeNull();
  });

  it("Add as mentee → prefilled form; Save POSTs the WHOLE manualMentees array plus the new entry", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("mentee-suggestion-add-1"));
    const form = within(screen.getByTestId("mentee-suggestion-add-form-1"));
    expect((form.getByTestId("manual-mentee-cwid-sugg-1") as HTMLInputElement).value).toBe(
      "pxr4012",
    );
    expect((form.getByTestId("manual-mentee-name-sugg-1") as HTMLInputElement).value).toBe(
      "Priya Raman",
    );
    expect((form.getByTestId("manual-mentee-program-sugg-1") as HTMLInputElement).value).toBe(
      "Postdoctoral Associate",
    );
    expect((form.getByTestId("manual-mentee-year-sugg-1") as HTMLInputElement).value).toBe("");
    fireEvent.click(form.getByTestId("manual-mentee-submit-sugg-1"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({
      url: "/api/edit/field",
      body: {
        entityType: "scholar",
        entityId: "self01",
        fieldName: "manualMentees",
        value: [
          { name: "Rowan Ellis", cwid: "rce4001", programLabel: "Visiting student", year: 2024 },
          { name: "Priya Raman", cwid: "pxr4012", programLabel: "Postdoctoral Associate" },
        ],
      },
    });
    // The added row leaves the list (the server re-render excludes it for good).
    await waitFor(() =>
      expect(
        within(screen.getByTestId("mentee-suggestions-list")).queryByTestId("mentee-suggestion-1"),
      ).toBeNull(),
    );
    // A second add BEFORE router.refresh() re-renders the prop must still carry
    // the first add — a full-array write from the stale prop would drop Priya.
    fireEvent.click(screen.getByTestId("mentee-suggestion-add-2"));
    fireEvent.click(
      within(screen.getByTestId("mentee-suggestion-add-form-2")).getByTestId(
        "manual-mentee-submit-sugg-2",
      ),
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    const second = postedBody(1).body as { value: Array<{ cwid?: string }> };
    expect(second.value.map((v) => v.cwid)).toEqual(["rce4001", "pxr4012", "wez4003"]);
  });

  it("a failed dismiss rolls the row back and shows inline error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: "write_failed" }) }),
    );
    renderCard();
    fireEvent.click(screen.getByTestId("mentee-suggestion-not-2"));
    fireEvent.click(screen.getByTestId("mentee-suggestion-reason-colleague-2"));
    fireEvent.click(screen.getByTestId("mentee-suggestion-dismiss-2"));
    await waitFor(() => expect(screen.getByTestId("mentee-suggestion-error-2")).toBeTruthy());
    expect(
      within(screen.getByTestId("mentee-suggestions-list")).getByTestId("mentee-suggestion-2"),
    ).toBeTruthy();
  });

  it("superuser mode: third-person copy, 'Add for {name}', byline uses the scholar's surname", () => {
    renderCard({ mode: "superuser", cwid: "other7" });
    expect(screen.getByTestId("mentee-suggestions-back").getAttribute("href")).toBe(
      "/edit/scholar/other7?attr=mentees",
    );
    expect(screen.getByTestId("mentee-suggestion-add-1").textContent).toBe("Add for Alex Self");
    expect(screen.getByTestId("mentee-suggestion-evidence-1").textContent).toContain(
      "5 with Self as last author",
    );
    expect(screen.getByTestId("mentee-suggestion-pub-41022331").textContent).toContain(
      "Raman 1st of 9 · Self last",
    );
  });

  it("bylineOf: ordinal positions, 'last' when the mentor closes the byline", () => {
    const e = {
      id: "1",
      year: null,
      title: null,
      journal: null,
      menteeRank: 2,
      mentorRank: 11,
      total: 12,
    };
    expect(bylineOf(e, "Raman", "you")).toBe("Raman 2nd of 12 · you 11th");
    expect(bylineOf({ ...e, mentorRank: 12 }, "Raman", "you")).toBe("Raman 2nd of 12 · you last");
  });
});
