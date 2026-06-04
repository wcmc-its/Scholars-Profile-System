/**
 * `components/edit/coi-gap-card.tsx` — the self-only "From your publications"
 * panel (`SELF_EDIT_COI_GAP_HINT`).
 *
 * Governance assertions (the adversarial review WILL grep for these): the
 * verbatim `sourceSentence` is always rendered, confidence is a qualitative
 * High/Medium chip (never a percentage or numeric score), the forbidden
 * accusatory vocabulary appears NOWHERE in the rendered output, and an empty
 * candidate list renders nothing scary.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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

  it("renders a High and a Medium qualitative tier chip — no percentages", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-tier-High")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-tier-Medium")).toBeTruthy();
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

  it("offers a Weill Research Gateway review affordance and a dismiss control per row", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // One WRG review affordance per candidate.
    expect(
      screen.getAllByText("Review in the Weill Research Gateway", { selector: "button" }),
    ).toHaveLength(2);
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

  it("renders a calm empty state and no scary copy when there are no candidates", () => {
    render(<CoiGapCard cwid="self01" candidates={[]} />);
    expect(screen.getByTestId("coi-gap-empty")).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const re of FORBIDDEN) {
      expect(text).not.toMatch(re);
    }
  });
});
