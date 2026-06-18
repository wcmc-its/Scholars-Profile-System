/**
 * `components/edit/coi-gap-card.tsx` — #1112 two-view redesign of the "From your
 * publications" advisory (`SELF_EDIT_COI_GAP_HINT`). The card fetches ONE flat
 * mention set (`EditContextCoiGapMention[]`) and pivots it client-side into
 * Organization view (default) and Paper view. The DECISION UNIT is
 * `(pmid, subjectId)`: resolving it clears the mention from the Current list in
 * BOTH views and fans the existing 3-way feedback out to every underlying
 * `candidateId`.
 *
 * Governance assertions (the adversarial review WILL grep for these): confidence
 * is a qualitative marker (never a percentage / numeric score), the forbidden
 * accusatory vocabulary appears NOWHERE, only the matched org(s) + the single
 * subject are marked (never any other name), an unresolved subject reads "unclear"
 * (never guessed self), and every action is a reversible personal hide with Undo.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { CoiGapCard } from "@/components/edit/coi-gap-card";
import type { EditContextCoiGapMention } from "@/lib/api/edit-context";

/** Build a mention with sensible defaults. */
function mention(p: Partial<EditContextCoiGapMention> & Pick<EditContextCoiGapMention, "candidateId" | "pmid">): EditContextCoiGapMention {
  return {
    year: 2024,
    organization: "astrazeneca",
    organizationRaw: "AstraZeneca",
    subjectType: "self",
    subjectMention: "Altorki",
    subjectId: "self",
    clause: "Altorki reports grant funding from AstraZeneca.",
    fullText: "Altorki reports grant funding from AstraZeneca.",
    relationshipKinds: ["grant"],
    confidence: "high",
    status: "current",
    reason: null,
    reviewedAt: null,
    ...p,
  };
}

/**
 * A realistic high-confidence fixture spanning two papers:
 *  - PMID 41679681 (2026): self ("Altorki") names AstraZeneca + Roche.
 *  - PMID 40217113 (2025): co-author ("A Saxena") names AstraZeneca.
 * So AstraZeneca's org card mixes a self mention and a co-author mention — the
 * exact "mixed attribution under one decision" the redesign untangles.
 */
const MENTIONS: EditContextCoiGapMention[] = [
  mention({
    candidateId: "c-az-self",
    pmid: "41679681",
    year: 2026,
    organization: "astrazeneca",
    organizationRaw: "AstraZeneca",
    subjectType: "self",
    subjectMention: "Altorki",
    subjectId: "self",
    clause: "Altorki reports grant funding from AstraZeneca.",
    fullText:
      "Altorki reports grant funding from AstraZeneca and steering committee membership for Roche/Genentech.",
    relationshipKinds: ["grant"],
  }),
  mention({
    candidateId: "c-roche-self",
    pmid: "41679681",
    year: 2026,
    organization: "roche/genentech",
    organizationRaw: "Roche/Genentech",
    subjectType: "self",
    subjectMention: "Altorki",
    subjectId: "self",
    clause: "Altorki … steering committee membership for Roche/Genentech.",
    fullText:
      "Altorki reports grant funding from AstraZeneca and steering committee membership for Roche/Genentech.",
    relationshipKinds: ["steering_committee"],
  }),
  mention({
    candidateId: "c-az-co",
    pmid: "40217113",
    year: 2025,
    organization: "astrazeneca",
    organizationRaw: "AstraZeneca",
    subjectType: "coauthor",
    subjectMention: "A Saxena",
    subjectId: "coauthor:a saxena",
    clause: "A Saxena receives research funding from AstraZeneca.",
    fullText: "A Saxena receives research funding from AstraZeneca.",
    relationshipKinds: ["grant"],
  }),
];

/** A pure-Medium (low-confidence) mention for the lower-confidence expander. */
const LOWER: EditContextCoiGapMention = mention({
  candidateId: "c-low",
  pmid: "29000001",
  year: 2021,
  organization: "boston scientific",
  organizationRaw: "Boston Scientific",
  subjectType: "unknown",
  subjectMention: null,
  subjectId: "unknown:#0",
  clause: "A consulting relationship with Boston Scientific was reported.",
  fullText: "A consulting relationship with Boston Scientific was reported.",
  relationshipKinds: ["consulting"],
  confidence: "low",
});

/** Words that must never appear in any user-facing copy on this surface. */
const FORBIDDEN = [
  /undisclosed/i,
  /failed to disclose/i,
  /\bmissing\b/i,
  /violation/i,
  /\bgap\b/i,
  /\baudit\b/i,
  /\bcompliance\b(?!\sjudgement)/i, // "compliance judgement" reassurance chip is allowed
];

function assertNoForbidden() {
  const text = document.body.textContent ?? "";
  for (const re of FORBIDDEN) {
    expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CoiGapCard #1112 redesign", () => {
  it("defaults to Organization view (Needs nothing — sticky default)", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const list = screen.getByTestId("coi-gap-summary").closest('[data-slot="coi-gap-panel"]');
    expect(list).toBeTruthy();
    // Org cards exist (one per matched org); paper cards do not.
    expect(screen.getByTestId("coi-gap-org-card-astrazeneca")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-org-card-roche/genentech")).toBeTruthy();
    expect(screen.queryByTestId("coi-gap-paper-card-41679681")).toBeNull();
    // The group-by control reports organization checked.
    expect(screen.getByTestId("coi-gap-groupby-organization").getAttribute("aria-checked")).toBe("true");
  });

  it("persists the group-by choice to localStorage and restores it", () => {
    const { unmount } = render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
    expect(window.localStorage.getItem("coi-gap:groupBy")).toBe("paper");
    // Paper cards now render.
    expect(screen.getByTestId("coi-gap-paper-card-41679681")).toBeTruthy();
    unmount();

    // A fresh mount reads the sticky choice and opens directly in Paper view.
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    expect(screen.getByTestId("coi-gap-groupby-paper").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("coi-gap-paper-card-41679681")).toBeTruthy();
  });

  it("counter shows the high-confidence count in softened copy, excludes Medium", () => {
    render(<CoiGapCard cwid="self01" mentions={[...MENTIONS, LOWER]} />);
    // 3 high mentions across 2 decision units (self in 41679681, co-author in
    // 40217113) → 2 from your publications. The Medium row is NOT counted.
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe("2 from your publications");
  });

  it("Organization-view summary line states the attribution split, year range, kinds", () => {
    render(<CoiGapCard cwid="self01" scholarName="Nasser Altorki" mentions={MENTIONS} />);
    const az = screen.getByTestId("coi-gap-org-summary-astrazeneca").textContent ?? "";
    // One self, one co-author named AstraZeneca.
    expect(az).toContain("1 attributed to Altorki, 1 to co-authors");
    expect(az).toContain("grants");
  });

  it("marks ONLY the matched org + the single subject — never any other name (Org view)", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const row = screen.getByTestId("coi-gap-org-row-c-az-co");
    // The org chip is marked with the organization aria-label.
    const orgMark = within(row).getByLabelText("organization: AstraZeneca");
    expect(orgMark.textContent).toBe("AstraZeneca");
    // The co-author subject is marked with a co-author aria-label.
    const coMark = within(row).getByLabelText("co-author: A Saxena");
    expect(coMark.textContent).toBe("A Saxena");
    // Nothing else carries a highlight role: exactly 2 <mark> in the clause line.
    const clauseP = row.querySelector("p");
    expect(clauseP?.querySelectorAll("mark").length).toBe(2);
  });

  it("self subject is bold+underline (you), co-author is a purple chip — accessible labels", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // Self mention row carries a "you" labelled mark.
    const selfRow = screen.getByTestId("coi-gap-org-row-c-az-self");
    expect(within(selfRow).getByLabelText("you").textContent).toBe("Altorki");
    expect(within(selfRow).getByLabelText("you").className).toContain("coi-hl-self");
    // Co-author mention row carries a purple co-author chip.
    const coRow = screen.getByTestId("coi-gap-org-row-c-az-co");
    expect(within(coRow).getByLabelText("co-author: A Saxena").className).toContain("coi-hl-co");
  });

  it("unknown subject renders a dashed 'Subject unclear' tag and marks no name inline", () => {
    render(<CoiGapCard cwid="self01" mentions={[LOWER]} />);
    // The lower expander must be opened to see the row.
    fireEvent.click(screen.getByTestId("coi-gap-lower").querySelector("summary")!);
    expect(screen.getAllByTestId("coi-gap-unclear").length).toBeGreaterThan(0);
    const row = screen.getByTestId("coi-gap-org-row-c-low");
    // The org is marked; no subject mark (unknown marks nothing inline).
    expect(within(row).getByLabelText("organization: Boston Scientific")).toBeTruthy();
    expect(within(row).queryByLabelText("you")).toBeNull();
    expect(within(row).queryByLabelText(/co-author:/)).toBeNull();
  });

  it("a full-statement expand reveals the verbatim text in Organization view", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // The self AstraZeneca row's clause is trimmed; fullText differs → toggle shows.
    fireEvent.click(screen.getByTestId("coi-gap-fulltext-toggle-c-az-self"));
    expect(screen.getByTestId("coi-gap-fulltext-c-az-self").textContent).toContain(
      "steering committee membership for Roche/Genentech",
    );
  });

  it("resolving (pmid, subjectId) clears it in BOTH views and increments set-aside by one", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // Resolve the SELF unit in 41679681 via the AstraZeneca row's compact action
    // (Org-view actions are keyed by the row's candidateId; the decision targets
    // the whole (pmid, subjectId) unit). The resolved unit LEAVES the Current list
    // immediately (spec §2) — both the AstraZeneca self row AND the Roche row.
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    // The Roche org card had ONLY that unit → its card disappears from Current.
    expect(screen.queryByTestId("coi-gap-org-card-roche/genentech")).toBeNull();
    // The AstraZeneca self row is gone from Current, but the co-author row remains.
    expect(screen.queryByTestId("coi-gap-org-row-c-az-self")).toBeNull();
    expect(screen.getByTestId("coi-gap-org-row-c-az-co")).toBeTruthy();
    // Counter: 2 high units → 1 current, 1 set aside.
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
      "1 from your publications · 1 set aside",
    );
    // Switch to Paper view: 41679681's self statement is gone from Current too.
    fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
    expect(screen.queryByTestId("coi-gap-paper-card-41679681")).toBeNull();
    // It IS present under the Set-aside filter, in BOTH views (decision persisted).
    fireEvent.click(screen.getByTestId("coi-gap-filter-set_aside"));
    expect(screen.getByTestId("coi-gap-paper-card-41679681")).toBeTruthy();
    fireEvent.click(screen.getByTestId("coi-gap-groupby-organization"));
    expect(screen.getByTestId("coi-gap-acted-c-az-self")).toBeTruthy();
  });

  it("fans the feedback out to EVERY candidateId sharing the (pmid, subjectId) unit", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    // The resolve toast confirms the write fired (the row left Current view).
    await screen.findByTestId("coi-gap-toast");
    // Both the AstraZeneca AND Roche candidate ids of the self unit are POSTed.
    for (const id of ["c-az-self", "c-roche-self"]) {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/edit/coi-gap/${id}/feedback`,
        expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
      );
    }
    // The co-author unit's candidate was NOT touched.
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/edit/coi-gap/c-az-co/feedback",
      expect.anything(),
    );
  });

  it("a resolve toast reports the org count and offers Undo (aria-live polite)", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    const toast = await screen.findByTestId("coi-gap-toast");
    // The self unit cleared TWO organizations (AstraZeneca + Roche).
    expect(toast.textContent).toContain("covers 2 organizations");
    // The polite live region announces it.
    expect(screen.getByTestId("coi-gap-toast-live").getAttribute("aria-live")).toBe("polite");
    // Undo in the toast restores the unit (re-POSTs /restore for both ids).
    fireEvent.click(screen.getByTestId("coi-gap-toast-undo"));
    for (const id of ["c-az-self", "c-roche-self"]) {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/edit/coi-gap/${id}/restore`,
        expect.objectContaining({ method: "POST" }),
      );
    }
  });

  it("filter chips switch between Current / Set aside / All with softened labels", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    expect(screen.getByTestId("coi-gap-filter-current").textContent).toBe("Current");
    expect(screen.getByTestId("coi-gap-filter-set_aside").textContent).toBe("Set aside");
    expect(screen.getByTestId("coi-gap-filter-all").textContent).toBe("All");
    // Default is Current.
    expect(screen.getByTestId("coi-gap-filter-current").getAttribute("aria-pressed")).toBe("true");
    // Set aside a unit, then the Set-aside filter shows it and Current hides it.
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    fireEvent.click(screen.getByTestId("coi-gap-filter-set_aside"));
    expect(screen.getByTestId("coi-gap-acted-c-az-self")).toBeTruthy();
    fireEvent.click(screen.getByTestId("coi-gap-filter-current"));
    expect(screen.queryByTestId("coi-gap-acted-c-az-self")).toBeNull();
  });

  describe("Paper view", () => {
    it("renders a card per statement with the verbatim fullText and a subject tag", () => {
      render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
      fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
      const card = screen.getByTestId("coi-gap-paper-card-41679681");
      // Verbatim statement is shown (org chips inside).
      expect(card.textContent).toContain("steering committee membership for Roche/Genentech");
      // Single-subject statement → a "you" subject tag.
      expect(screen.getByTestId("coi-gap-paper-subject-41679681").textContent).toContain("you");
      // The footer hint covers all the orgs in that statement.
      expect(screen.getByTestId("coi-gap-paper-hint-41679681::self").textContent).toBe(
        "Covers all 2 organizations",
      );
    });

    it("a co-author statement shows the purple subject tag and full-label footer actions", () => {
      render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
      fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
      const card = screen.getByTestId("coi-gap-paper-card-40217113");
      expect(within(card).getByText("co-author · A Saxena")).toBeTruthy();
      // Full canonical labels in Paper footer (not the compact short forms).
      expect(
        screen.getByTestId("coi-gap-choice-invalid-40217113::coauthor:a saxena").textContent,
      ).toBe("Not a valid suggestion");
    });

    it("multi-subject statements split into independently-decidable blocks", () => {
      // One statement (pmid 50000000) names BOTH the scholar and a co-author.
      const multi: EditContextCoiGapMention[] = [
        mention({
          candidateId: "m-self",
          pmid: "50000000",
          organization: "pfizer",
          organizationRaw: "Pfizer",
          subjectType: "self",
          subjectMention: "Altorki",
          subjectId: "self",
          clause: "Altorki consults for Pfizer.",
          fullText: "Altorki consults for Pfizer. B Lee reports grants from Merck.",
          relationshipKinds: ["consulting"],
        }),
        mention({
          candidateId: "m-co",
          pmid: "50000000",
          organization: "merck",
          organizationRaw: "Merck",
          subjectType: "coauthor",
          subjectMention: "B Lee",
          subjectId: "coauthor:b lee",
          clause: "B Lee reports grants from Merck.",
          fullText: "Altorki consults for Pfizer. B Lee reports grants from Merck.",
          relationshipKinds: ["grant"],
        }),
      ];
      render(<CoiGapCard cwid="self01" mentions={multi} />);
      fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
      // Two blocks, each with its own footer actions.
      expect(screen.getByTestId("coi-gap-paper-block-50000000::self")).toBeTruthy();
      expect(screen.getByTestId("coi-gap-paper-block-50000000::coauthor:b lee")).toBeTruthy();
      // Deciding the co-author block alone leaves the self block Current: the
      // co-author block leaves the Current list, the self block stays actionable
      // (the card collapses to its single remaining subject, still with choices).
      fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-50000000::coauthor:b lee"));
      expect(screen.queryByTestId("coi-gap-paper-block-50000000::coauthor:b lee")).toBeNull();
      expect(screen.getByTestId("coi-gap-choices-50000000::self")).toBeTruthy();
      // The co-author decision IS recorded — visible under the All filter.
      fireEvent.click(screen.getByTestId("coi-gap-filter-all"));
      expect(screen.getByTestId("coi-gap-acted-50000000::coauthor:b lee")).toBeTruthy();
    });
  });

  it("lower-confidence (Medium) renders into the same two-view structure, collapsed + flagged", () => {
    render(<CoiGapCard cwid="self01" mentions={[...MENTIONS, LOWER]} />);
    const lower = screen.getByTestId("coi-gap-lower");
    expect(lower.tagName).toBe("DETAILS");
    expect((lower as HTMLDetailsElement).open).toBe(false);
    expect(lower.querySelector("summary")?.textContent).toContain("Show 1 lower-confidence match");
    // Opening it reveals the Boston Scientific org card with a lower-confidence flag.
    fireEvent.click(lower.querySelector("summary")!);
    const card = screen.getByTestId("coi-gap-org-card-boston scientific");
    expect(card.textContent).toContain("lower confidence");
    expect(card.className).toContain("border-dashed");
  });

  it("frames the surface as advisory: back-link, two reassurance chips, NO Locked chip", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe("/edit?attr=coi");
    const chips = screen.getByTestId("coi-gap-reassure").textContent ?? "";
    expect(chips).toContain("Not a compliance judgement");
    expect(chips).toContain("Managed in the Gateway, never here");
    expect(chips).not.toContain("Visible only to you");
    expect(document.body.textContent ?? "").not.toContain("Locked — managed at its source");
  });

  it("uses the softened service copy (courtesy framing, no to-do vibe)", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("A courtesy heads-up");
    expect(text).toContain("Nothing to fix here");
    expect(screen.getByTestId("coi-gap-helper").textContent).toContain(
      "This is a courtesy list, not a to-do",
    );
    // Non-task filter labels, not "Needs review".
    expect(text).not.toContain("Needs review");
    expect(text).not.toContain("reviewed");
  });

  it("never surfaces a percentage / numeric score, and no forbidden vocabulary", () => {
    render(<CoiGapCard cwid="self01" mentions={[...MENTIONS, LOWER]} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\b0\.\d/);
    assertNoForbidden();
  });

  describe("superuser mode", () => {
    it("reframes copy + back-link to the scholar's name, never promises 'only you'", () => {
      render(<CoiGapCard cwid="self01" mode="superuser" scholarName="Nasser Altorki" mentions={MENTIONS} />);
      const chips = screen.getByTestId("coi-gap-reassure").textContent ?? "";
      expect(chips).toContain("Visible to administrators and the scholar");
      expect(chips).not.toContain("Visible only to you");
      expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe(
        "/edit/scholar/self01?attr=coi",
      );
      // Counter uses the "their" voice.
      expect(screen.getByTestId("coi-gap-summary").textContent).toContain("their publications");
    });

    it("nags before any response — opens a confirm and does NOT write until confirmed", async () => {
      render(<CoiGapCard cwid="self01" mode="superuser" scholarName="Nasser Altorki" mentions={MENTIONS} />);
      fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      assertNoForbidden();
      fireEvent.click(continueBtn);
      await screen.findByTestId("coi-gap-toast");
      for (const id of ["c-az-self", "c-roche-self"]) {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          `/api/edit/coi-gap/${id}/feedback`,
          expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
        );
      }
    });
  });

  it("rolls a unit back to Current and surfaces a retry when any source fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
        .mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) }),
    );
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    // Rolls back to the active choices + surfaces a retry. The unit spans two org
    // rows (AstraZeneca + Roche), so the retry shows on each affected row.
    const retries = await screen.findAllByText(
      /couldn’t update this just now|couldn't update this just now/i,
    );
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("coi-gap-choices-c-az-self")).toBeTruthy();
  });

  it("a set-aside mention is shown for an already-responded (persisted) row", () => {
    const persisted: EditContextCoiGapMention[] = [
      mention({
        candidateId: "c-done",
        pmid: "60000000",
        organization: "novartis",
        organizationRaw: "Novartis",
        status: "set_aside",
        reason: "historical",
        reviewedAt: "2026-05-01",
      }),
    ];
    render(<CoiGapCard cwid="self01" mentions={persisted} />);
    // Default Current filter hides it; switching to Set aside shows the line.
    // (Org-view row testids are candidate-scoped.)
    expect(screen.queryByTestId("coi-gap-acted-c-done")).toBeNull();
    fireEvent.click(screen.getByTestId("coi-gap-filter-set_aside"));
    expect(screen.getByTestId("coi-gap-acted-c-done").textContent).toContain(
      "Historically true, not currently valid",
    );
  });
});
