/**
 * `components/edit/coi-gap-card.tsx` — the self-only "From your publications"
 * advisory sub-view (`SELF_EDIT_COI_GAP_HINT`).
 *
 * Governance assertions (the adversarial review WILL grep for these): the
 * verbatim `sourceSentence` is always rendered, confidence is a qualitative
 * tier chip (never a percentage or numeric score), the forbidden accusatory
 * vocabulary appears NOWHERE, the surface is framed as advisory (back-link +
 * reassurance chips, NOT the authoritative "Locked" chip), and "Not relevant"
 * is a reversible personal hide (undo), never a silent destructive action.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { CoiGapCard } from "@/components/edit/coi-gap-card";
import type { EditContextCoiGapCandidate } from "@/lib/api/edit-context";

const CANDIDATES: EditContextCoiGapCandidate[] = [
  {
    id: "gap-1",
    pmid: "31508198",
    entity: "Procept BioRobotics",
    tier: "High",
    sourceSentence: "Clinical Research investigator for Procept Aquablation and Neotract Urolift.",
  },
  {
    id: "gap-2",
    pmid: "30000001",
    entity: "Neotract",
    tier: "Medium",
    sourceSentence: "Consultant for Neotract Urolift.",
  },
];

/** Words that must never appear in any user-facing copy on this surface. */
const FORBIDDEN = [/undisclosed/i, /failed to disclose/i, /\bmissing\b/i, /violation/i, /\bgap\b/i];

describe("CoiGapCard", () => {
  it("renders the verbatim source sentence for each candidate", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-source-gap-1").textContent).toContain(
      "Clinical Research investigator for Procept Aquablation and Neotract Urolift.",
    );
    expect(screen.getByTestId("coi-gap-source-gap-2").textContent).toContain(
      "Consultant for Neotract Urolift.",
    );
  });

  it("renders qualitative tier chips — amber 'Worth reviewing' / green 'Likely covered', no percentages", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-tier-High").textContent).toBe("Worth reviewing");
    expect(screen.getByTestId("coi-gap-tier-Medium").textContent).toBe("Likely covered");
    // No percentage / numeric score anywhere.
    const root = document.body.textContent ?? "";
    expect(root).not.toMatch(/%/);
    expect(root).not.toMatch(/0\.\d/);
  });

  it("links each candidate to its PubMed record", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    const link = screen.getByText("PMID 31508198").closest("a");
    expect(link?.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/31508198/");
  });

  it("frames the surface as advisory: back-link to COI, three reassurance chips, NO Locked chip", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // Nested under Conflicts of Interest — the back-link returns to the parent.
    expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe("/edit?attr=coi");
    const chips = screen.getByTestId("coi-gap-reassure").textContent ?? "";
    expect(chips).toContain("Visible only to you");
    expect(chips).toContain("Not a compliance judgement");
    expect(chips).toContain("Managed in the Gateway, never here");
    // A derived SUGGESTION must NOT wear the authoritative "Locked — managed at
    // its source" chip — that would imply the list is ground truth.
    expect(document.body.textContent ?? "").not.toContain("Locked — managed at its source");
  });

  it("summarizes the active set by qualitative tier", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
      "1 worth reviewing · 1 likely already covered",
    );
  });

  it("offers a Gateway review affordance and a dismiss control per row", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getAllByRole("button", { name: /review in gateway/i })).toHaveLength(2);
    expect(screen.getByTestId("coi-gap-dismiss-gap-1")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-dismiss-gap-2")).toBeTruthy();
  });

  it("contains NONE of the forbidden accusatory words", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    const text = document.body.textContent ?? "";
    for (const re of FORBIDDEN) {
      expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
    }
  });

  it("renders a calm summary and no scary copy when there are no candidates", () => {
    render(<CoiGapCard cwid="self01" candidates={[]} />);
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe("Nothing left to review");
    const text = document.body.textContent ?? "";
    for (const re of FORBIDDEN) {
      expect(text).not.toMatch(re);
    }
  });

  describe('"Not relevant" is a reversible personal hide', () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("dismiss → inline 'marked not relevant' + undo, with the summary updating live, then undo restores", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      // gap-1 is the only High; dismissing it drops the "worth reviewing" count.
      fireEvent.click(screen.getByTestId("coi-gap-dismiss-gap-1"));

      await screen.findByTestId("coi-gap-undo-gap-1");
      expect(screen.getByText(/marked not relevant/i)).toBeTruthy();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1/dismiss",
        expect.objectContaining({ method: "POST" }),
      );
      // Summary recomputed: the High row is gone → only the Medium remains.
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe("1 likely already covered");

      // Undo restores the row + calls the restore endpoint.
      fireEvent.click(screen.getByTestId("coi-gap-undo-gap-1"));
      await screen.findByTestId("coi-gap-dismiss-gap-1");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1/restore",
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
        "1 worth reviewing · 1 likely already covered",
      );
    });
  });
});
