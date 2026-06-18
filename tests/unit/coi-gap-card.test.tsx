/**
 * `components/edit/coi-gap-card.tsx` — #1112 two-view redesign of the "From your
 * publications" advisory (`SELF_EDIT_COI_GAP_HINT`). The card fetches ONE flat
 * mention set (`EditContextCoiGapMention[]`) and pivots it client-side into
 * Organization view (default) and Paper view. Decisions are atomic at the MENTION
 * (`candidateId` = one paper × one org): an Organization-view row resolves ONLY
 * that company; a Paper-view footer batches the statement's currently-current
 * companies. A mention resolved in one view shows resolved in the other.
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
 *  - PMID 40217113 (2025): co-author ("A Saxena") names AstraZeneca — kept in the
 *    fixture but NEVER surfaced: this surface is the scholar's OWN relationships,
 *    so co-author-attributed mentions are filtered out.
 * So AstraZeneca's org card shows only the scholar's own mention.
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

  it("counter shows the high self-mention count in softened copy; excludes Medium + co-authors", () => {
    render(<CoiGapCard cwid="self01" mentions={[...MENTIONS, LOWER]} />);
    // 2 surfaced high mentions (AZ-self, Roche-self). The co-author (AZ) mention
    // and the Medium row are both excluded.
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe("2 from your publications");
  });

  it("action buttons use the full canonical (dev) labels — no compact variants", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // Organization-view row buttons read the SAME as dev (not "Update COI" etc.).
    expect(screen.getByTestId("coi-gap-choice-will_disclose-c-az-self").textContent).toBe(
      "I intend to update my COI statement",
    );
    expect(screen.getByTestId("coi-gap-choice-historical-c-az-self").textContent).toBe(
      "Historically true but not currently valid",
    );
    expect(screen.getByTestId("coi-gap-choice-invalid-c-az-self").textContent).toBe(
      "Not a valid suggestion",
    );
    expect(document.body.textContent ?? "").not.toContain("Update COI");
    expect(document.body.textContent ?? "").not.toContain("No longer current");
  });

  it("Organization-view summary line states the attribution split, year range, kinds", () => {
    render(<CoiGapCard cwid="self01" scholarName="Nasser Altorki" mentions={MENTIONS} />);
    const az = screen.getByTestId("coi-gap-org-summary-astrazeneca").textContent ?? "";
    // Only the scholar's own mention is surfaced (the co-author one is filtered).
    expect(az).toContain("1 attributed to Altorki");
    expect(az).not.toContain("co-author");
    expect(az).toContain("grants");
  });

  it("marks ONLY the matched org + the single subject — never any other name (Org view)", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const row = screen.getByTestId("coi-gap-org-row-c-az-self");
    // The org chip is marked with the organization aria-label.
    const orgMark = within(row).getByLabelText("organization: AstraZeneca");
    expect(orgMark.textContent).toBe("AstraZeneca");
    // The scholar's own subject is marked with a "you" aria-label.
    const selfMark = within(row).getByLabelText("you");
    expect(selfMark.textContent).toBe("Altorki");
    // Nothing else carries a highlight role: exactly 2 <mark> in the clause line.
    const clauseP = row.querySelector("p");
    expect(clauseP?.querySelectorAll("mark").length).toBe(2);
  });

  it("the subject uses the 'person' highlight, the org uses the 'company' highlight", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const selfRow = screen.getByTestId("coi-gap-org-row-c-az-self");
    const selfMark = within(selfRow).getByLabelText("you");
    expect(selfMark.textContent).toBe("Altorki");
    expect(selfMark.className).toContain("coi-hl-person");
    expect(within(selfRow).getByLabelText("organization: AstraZeneca").className).toContain(
      "coi-hl-org",
    );
  });

  it("renders a company/person key", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    const key = screen.getByTestId("coi-gap-key");
    expect(key.textContent).toContain("company");
    expect(key.textContent).toContain("person");
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

  it("Org-view action resolves ONLY that company — the paper's other orgs stay Current", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // Resolve AstraZeneca-in-41679681 (the self mention). It must NOT touch Roche,
    // which shares the same paper + subject.
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    await screen.findByTestId("coi-gap-toast");
    // Roche is a DIFFERENT company in the same paper → still Current.
    expect(screen.getByTestId("coi-gap-org-card-roche/genentech")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-org-row-c-roche-self")).toBeTruthy();
    // The AstraZeneca self row left Current.
    expect(screen.queryByTestId("coi-gap-org-row-c-az-self")).toBeNull();
    // Only that ONE candidate was POSTed — never Roche.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/edit/coi-gap/c-az-self/feedback",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/edit/coi-gap/c-roche-self/feedback",
      expect.anything(),
    );
    // Counter: 2 surfaced high mentions → 1 current, 1 set aside.
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
      "1 from your publications · 1 set aside",
    );
  });

  it("the Org-view decision persists into Paper view (cross-view) at the company grain", () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    // Switch to Paper view: 41679681 still shows (Roche still Current) but now the
    // footer covers only the ONE remaining company, not two.
    fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
    expect(screen.getByTestId("coi-gap-paper-hint-41679681::self").textContent).toBe(
      "Covers all 1 organization",
    );
    // And the set-aside AZ mention surfaces under the Set-aside filter, Org view.
    fireEvent.click(screen.getByTestId("coi-gap-filter-set_aside"));
    fireEvent.click(screen.getByTestId("coi-gap-groupby-organization"));
    expect(screen.getByTestId("coi-gap-acted-c-az-self")).toBeTruthy();
  });

  it("Paper-view footer resolves ALL of a statement's current companies at once", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
    // The 41679681 self statement footer covers both AZ + Roche.
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-41679681::self"));
    await screen.findByTestId("coi-gap-toast");
    // BOTH companies of that statement are POSTed.
    for (const id of ["c-az-self", "c-roche-self"]) {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/edit/coi-gap/${id}/feedback`,
        expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
      );
    }
    // Statement leaves Current; whole paper gone from Current view.
    expect(screen.queryByTestId("coi-gap-paper-card-41679681")).toBeNull();
  });

  it("a resolve toast reports the org count and offers Undo (aria-live polite)", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    // An Org-row action covers exactly ONE company.
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    const toast = await screen.findByTestId("coi-gap-toast");
    expect(toast.textContent).toContain("covers 1 organization");
    expect(screen.getByTestId("coi-gap-toast-live").getAttribute("aria-live")).toBe("polite");
    // Undo restores exactly that one company.
    fireEvent.click(screen.getByTestId("coi-gap-toast-undo"));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/edit/coi-gap/c-az-self/restore",
      expect.objectContaining({ method: "POST" }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/edit/coi-gap/c-roche-self/restore",
      expect.anything(),
    );
  });

  it("a Paper-view footer toast reports the multi-org breadth", async () => {
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-41679681::self"));
    const toast = await screen.findByTestId("coi-gap-toast");
    expect(toast.textContent).toContain("covers 2 organizations");
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

    it("a co-author-only statement is NOT surfaced (scholar's own relationships only)", () => {
      render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
      fireEvent.click(screen.getByTestId("coi-gap-groupby-paper"));
      // PMID 40217113 is a co-author ("A Saxena") statement → no card, no name.
      expect(screen.queryByTestId("coi-gap-paper-card-40217113")).toBeNull();
      expect(document.body.textContent ?? "").not.toContain("A Saxena");
      expect(document.body.textContent ?? "").not.toContain("co-author");
    });

    it("a mixed paper (self + co-author subjects) surfaces ONLY the self block", () => {
      // One statement (pmid 50000000) names BOTH the scholar and a co-author; only
      // the scholar's own block is surfaced (the co-author block is dropped).
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
      // Renders as a SINGLE-subject (self) statement — no co-author block/actions.
      expect(screen.getByTestId("coi-gap-paper-card-50000000")).toBeTruthy();
      expect(screen.getByTestId("coi-gap-paper-subject-50000000").textContent).toContain("you");
      expect(screen.queryByTestId("coi-gap-paper-block-50000000::coauthor:b lee")).toBeNull();
      expect(screen.queryByTestId("coi-gap-choices-50000000::coauthor:b lee")).toBeNull();
      // Footer covers only the scholar's own company (Pfizer), not the co-author's.
      expect(screen.getByTestId("coi-gap-paper-hint-50000000::self").textContent).toBe(
        "Covers all 1 organization",
      );
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
      // Only that one company is POSTed (Org-row grain), even through the nag.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/c-az-self/feedback",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
      );
      expect(globalThis.fetch).not.toHaveBeenCalledWith(
        "/api/edit/coi-gap/c-roche-self/feedback",
        expect.anything(),
      );
    });
  });

  it("rolls a mention back to Current and surfaces a retry when the POST fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) }),
    );
    render(<CoiGapCard cwid="self01" mentions={MENTIONS} />);
    fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-c-az-self"));
    // Rolls back to the active choices + surfaces a retry on that row.
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
