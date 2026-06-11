/**
 * `components/edit/coi-gap-card.tsx` — the "From your publications" advisory
 * sub-view (`SELF_EDIT_COI_GAP_HINT`). Each row is ONE relationship, deduped
 * across the scholar's papers and citing every source publication.
 *
 * Governance assertions (the adversarial review WILL grep for these): the
 * verbatim `sourceSentence` of every source is always rendered, confidence is a
 * qualitative tier chip (never a percentage or numeric score), the forbidden
 * accusatory vocabulary appears NOWHERE, the surface is framed as advisory
 * (back-link + reassurance chips, NOT the authoritative "Locked" chip), and
 * "Not relevant" is a reversible personal hide (undo) that fans out to every
 * underlying source, never a silent destructive action.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { CoiGapCard } from "@/components/edit/coi-gap-card";
import type { EditContextCoiGapCandidate } from "@/lib/api/edit-context";

// Two deduped relationships. "procept" is High and cites TWO papers; "neotract"
// is Medium but its single paper is NEWER (2023) — so tier-order and date-order
// disagree, which lets the sort control's effect be observed.
const CANDIDATES: EditContextCoiGapCandidate[] = [
  {
    key: "procept biorobotics",
    entity: "Procept Biorobotics Inc",
    tier: "High",
    newestTs: Date.UTC(2022, 0, 10),
    sources: [
      {
        id: "gap-1b",
        pmid: "34963501",
        sourceSentence: "Stock options in Procept Biorobotics.",
        year: 2022,
      },
      {
        id: "gap-1a",
        pmid: "31508198",
        sourceSentence: "Clinical Research investigator for Procept Aquablation.",
        year: 2019,
      },
    ],
  },
  {
    key: "neotract",
    entity: "Neotract",
    tier: "Medium",
    newestTs: Date.UTC(2023, 5, 1),
    sources: [
      { id: "gap-2", pmid: "30000001", sourceSentence: "Consultant for Neotract Urolift.", year: 2023 },
    ],
  },
];

/** Words that must never appear in any user-facing copy on this surface. */
const FORBIDDEN = [/undisclosed/i, /failed to disclose/i, /\bmissing\b/i, /violation/i, /\bgap\b/i];

/** The rendered row testids, in DOM order. */
function rowOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="coi-gap-panel-list"] > li')).map(
    (li) => li.getAttribute("data-testid") ?? "",
  );
}

describe("CoiGapCard", () => {
  it("cites every source publication with its verbatim sentence and PMID + year", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // Both of the procept sources are shown, plus the neotract one.
    expect(screen.getByTestId("coi-gap-source-gap-1b").textContent).toContain(
      "Stock options in Procept Biorobotics.",
    );
    expect(screen.getByTestId("coi-gap-source-gap-1a").textContent).toContain(
      "Clinical Research investigator for Procept Aquablation.",
    );
    expect(screen.getByTestId("coi-gap-source-gap-2").textContent).toContain(
      "Consultant for Neotract Urolift.",
    );
    // The multi-source relationship advertises its publication count.
    expect(screen.getByTestId("coi-gap-source-count-procept biorobotics").textContent).toContain(
      "2 publications",
    );
    // Each source links to its PubMed record and shows its year.
    const link = screen.getByText("PMID 34963501").closest("a");
    expect(link?.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/34963501/");
    expect(document.body.textContent).toContain("2019");
  });

  it("renders the deduped entity once, labelled by the newest source's raw name", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // The two procept rows collapse to ONE heading, using the 2022 paper's label.
    expect(screen.getAllByText("Procept Biorobotics Inc")).toHaveLength(1);
    expect(screen.queryByText("Procept BioRobotics")).toBeNull();
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

  it("frames the surface as advisory: back-link to COI, two reassurance chips, NO Locked chip", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe("/edit?attr=coi");
    const chips = screen.getByTestId("coi-gap-reassure").textContent ?? "";
    expect(chips).not.toContain("Visible only to you");
    expect(chips).toContain("Not a compliance judgement");
    expect(chips).toContain("Managed in the Gateway, never here");
    expect(document.body.textContent ?? "").not.toContain("Locked — managed at its source");
  });

  it("summarizes the active set by qualitative tier (one row per relationship)", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
      "1 worth reviewing · 1 likely already covered",
    );
  });

  it("offers a Gateway review affordance and a dismiss control per relationship", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // One review + one dismiss PER RELATIONSHIP (not per paper).
    expect(screen.getAllByRole("button", { name: /review in gateway/i })).toHaveLength(2);
    expect(screen.getByTestId("coi-gap-dismiss-procept biorobotics")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-dismiss-neotract")).toBeTruthy();
  });

  it("contains NONE of the forbidden accusatory words", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    const text = document.body.textContent ?? "";
    for (const re of FORBIDDEN) {
      expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
    }
  });

  it("renders a calm summary and hides the sort control when there are no candidates", () => {
    render(<CoiGapCard cwid="self01" candidates={[]} />);
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe("Nothing left to review");
    expect(screen.queryByTestId("coi-gap-sort")).toBeNull();
    const text = document.body.textContent ?? "";
    for (const re of FORBIDDEN) {
      expect(text).not.toMatch(re);
    }
  });

  describe("sort control (operator decision — 3 distinct modes, default newest+confidence)", () => {
    it("defaults to newest+confidence (High first) and reorders to pure-recency on 'Newest'", () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      const select = screen.getByTestId("coi-gap-sort") as HTMLSelectElement;
      expect(select.value).toBe("newest-confidence");
      // Default: High "procept" leads despite neotract being newer.
      expect(rowOrder()).toEqual(["coi-gap-row-procept biorobotics", "coi-gap-row-neotract"]);

      // Pure "Newest": the 2023 Medium "neotract" floats above the 2022 High one.
      fireEvent.change(select, { target: { value: "newest" } });
      expect(rowOrder()).toEqual(["coi-gap-row-neotract", "coi-gap-row-procept biorobotics"]);

      // "Confidence": tier groups again (High first).
      fireEvent.change(select, { target: { value: "confidence" } });
      expect(rowOrder()).toEqual(["coi-gap-row-procept biorobotics", "coi-gap-row-neotract"]);
    });
  });

  describe('"Not relevant" fans out across every source and is reversible', () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("dismissing the multi-paper relationship POSTs dismiss for BOTH sources, flips the row, updates the summary, then undo restores both", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      fireEvent.click(screen.getByTestId("coi-gap-dismiss-procept biorobotics"));

      await screen.findByTestId("coi-gap-undo-procept biorobotics");
      expect(screen.getByText(/marked not relevant/i)).toBeTruthy();
      // Fans out to EVERY underlying candidate id.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1b/dismiss",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1a/dismiss",
        expect.objectContaining({ method: "POST" }),
      );
      // Summary recomputed: the only High relationship is gone.
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe("1 likely already covered");

      // Undo restores the row + calls restore for both sources.
      fireEvent.click(screen.getByTestId("coi-gap-undo-procept biorobotics"));
      await screen.findByTestId("coi-gap-dismiss-procept biorobotics");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1b/restore",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1a/restore",
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe(
        "1 worth reviewing · 1 likely already covered",
      );
    });

    it("rolls the row back to active and shows a retry when any source fails", async () => {
      // First source ok, second fails → the whole relationship rolls back.
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
          .mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) }),
      );
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      fireEvent.click(screen.getByTestId("coi-gap-dismiss-procept biorobotics"));
      // Rolls back to the active dismiss control + surfaces a retry.
      await screen.findByTestId("coi-gap-dismiss-procept biorobotics");
      expect(screen.getByText(/couldn’t update this just now|couldn't update this just now/i)).toBeTruthy();
    });
  });

  describe("superuser mode — reframed copy + the action nag (operator decision)", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("reframes the privacy chip + back-link and never falsely promises 'only you'", () => {
      render(
        <CoiGapCard cwid="self01" mode="superuser" scholarName="Dr. Other" candidates={CANDIDATES} />,
      );
      const chips = screen.getByTestId("coi-gap-reassure").textContent ?? "";
      expect(chips).toContain("Visible to administrators and the scholar");
      expect(chips).not.toContain("Visible only to you");
      expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe(
        "/edit/scholar/self01?attr=coi",
      );
    });

    it("nags before any action — 'Not relevant' opens a confirm and does NOT write until confirmed, then fans out", async () => {
      render(
        <CoiGapCard cwid="self01" mode="superuser" scholarName="Dr. Other" candidates={CANDIDATES} />,
      );
      fireEvent.click(screen.getByTestId("coi-gap-dismiss-procept biorobotics"));
      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // Governance holds inside the nag too — no forbidden accusatory vocabulary.
      const text = document.body.textContent ?? "";
      for (const re of FORBIDDEN) {
        expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
      }
      // Confirming fires the dismiss write for every source.
      fireEvent.click(continueBtn);
      await screen.findByTestId("coi-gap-undo-procept biorobotics");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1b/dismiss",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-1a/dismiss",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
