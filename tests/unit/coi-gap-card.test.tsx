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
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { CoiGapCard } from "@/components/edit/coi-gap-card";
import type {
  EditContextCoiGapCandidate,
  EditContextCoiGapReviewed,
} from "@/lib/api/edit-context";

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

// Pure-Medium ACTIVE relationships — the "lower-confidence" expander payload.
// Partitioned upstream into its OWN array (never the High `candidates` list), so
// the surface must tuck it behind a collapsed <details> rather than fronting it.
const LOWER: EditContextCoiGapCandidate[] = [
  {
    key: "boston scientific",
    entity: "Boston Scientific Corp",
    tier: "Medium",
    newestTs: Date.UTC(2021, 2, 15),
    sources: [
      {
        id: "lo-1",
        pmid: "29000001",
        sourceSentence: "Co-author reports a consulting relationship with Boston Scientific.",
        year: 2021,
      },
    ],
  },
];

// Fully-acted relationships — the settled "Reviewed" history. The scholar's own
// recorded `reason` + action `reviewedAt` are the ONLY formerly-starved fields
// allowed to cross to the client, and ONLY here (score/status/attribution/
// category still never do).
const REVIEWED: EditContextCoiGapReviewed[] = [
  {
    key: "medtronic",
    entity: "Medtronic Inc",
    tier: "High",
    newestTs: Date.UTC(2020, 7, 3),
    reason: "historical",
    reviewedAt: "2026-05-20",
    sources: [
      {
        id: "rv-1",
        pmid: "27000001",
        sourceSentence: "Former advisory board member, Medtronic.",
        year: 2020,
      },
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

  it("summarizes ONLY the High active list (Medium/Reviewed counts live in their own labels)", () => {
    // One High ("procept") + one Medium ("neotract") row in the active list; the
    // top summary tracks the High worth-reviewing count only — it does NOT fold in
    // the Medium "likely covered" tally (that now lives in the lower-confidence
    // expander, not this line).
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    expect(screen.getByTestId("coi-gap-summary").textContent).toBe("1 worth reviewing");
  });

  it("offers a Gateway review affordance and the neutral 3-way response per relationship", () => {
    render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
    // One review affordance PER RELATIONSHIP (not per paper).
    expect(screen.getAllByRole("button", { name: /review in gateway/i })).toHaveLength(2);
    // Each relationship offers all three responses, by their verbatim labels.
    expect(screen.getByTestId("coi-gap-choices-procept biorobotics")).toBeTruthy();
    expect(screen.getByTestId("coi-gap-choice-will_disclose-procept biorobotics").textContent).toBe(
      "I intend to update my COI statement",
    );
    expect(screen.getByTestId("coi-gap-choice-historical-procept biorobotics").textContent).toBe(
      "Historically true but not currently valid",
    );
    expect(screen.getByTestId("coi-gap-choice-invalid-procept biorobotics").textContent).toBe(
      "Not a valid suggestion",
    );
    expect(screen.getByTestId("coi-gap-choices-neotract")).toBeTruthy();
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

  describe("the 3-way response fans out across every source and is reversible", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("recording 'Not relevant' (invalid) POSTs /feedback{reason:invalid} for BOTH sources, flips the row, updates the summary, then undo restores both", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-procept biorobotics"));

      await screen.findByTestId("coi-gap-undo-procept biorobotics");
      // The recorded reason is shown in place.
      expect(screen.getByTestId("coi-gap-acted-procept biorobotics").textContent).toBe(
        "Not a valid suggestion",
      );
      // Fans out to EVERY underlying candidate id with the chosen reason.
      for (const id of ["gap-1b", "gap-1a"]) {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          `/api/edit/coi-gap/${id}/feedback`,
          expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
        );
      }
      // Summary recomputed: the only High relationship is gone, and the line
      // tracks the High worth-reviewing count only (the Medium row never figured
      // into it), so it falls back to the calm empty state.
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe("Nothing left to review");

      // Undo restores the row + calls /restore for both sources.
      fireEvent.click(screen.getByTestId("coi-gap-undo-procept biorobotics"));
      await screen.findByTestId("coi-gap-choices-procept biorobotics");
      for (const id of ["gap-1b", "gap-1a"]) {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          `/api/edit/coi-gap/${id}/restore`,
          expect.objectContaining({ method: "POST" }),
        );
      }
      expect(screen.getByTestId("coi-gap-summary").textContent).toBe("1 worth reviewing");
    });

    it("'I intend to update my COI statement' (will_disclose) POSTs /feedback{reason:will_disclose} and shows the recorded label", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      fireEvent.click(screen.getByTestId("coi-gap-choice-will_disclose-neotract"));
      await screen.findByTestId("coi-gap-undo-neotract");
      expect(screen.getByTestId("coi-gap-acted-neotract").textContent).toBe(
        "Will update COI statement",
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/gap-2/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reason: "will_disclose" }),
        }),
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
      fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-procept biorobotics"));
      // Rolls back to the active choices + surfaces a retry.
      await screen.findByTestId("coi-gap-choices-procept biorobotics");
      expect(
        screen.getByText(/couldn’t update this just now|couldn't update this just now/i),
      ).toBeTruthy();
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

    it("nags before any response — choosing a reason opens a confirm and does NOT write until confirmed, then fans out", async () => {
      render(
        <CoiGapCard cwid="self01" mode="superuser" scholarName="Dr. Other" candidates={CANDIDATES} />,
      );
      fireEvent.click(screen.getByTestId("coi-gap-choice-invalid-procept biorobotics"));
      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // Governance holds inside the nag too — no forbidden accusatory vocabulary.
      const text = document.body.textContent ?? "";
      for (const re of FORBIDDEN) {
        expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
      }
      // Confirming fires the feedback write for every source.
      fireEvent.click(continueBtn);
      await screen.findByTestId("coi-gap-undo-procept biorobotics");
      for (const id of ["gap-1b", "gap-1a"]) {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          `/api/edit/coi-gap/${id}/feedback`,
          expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
        );
      }
    });
  });

  // ── NEW SURFACE 1 ─ the lower-confidence (pure-Medium active) expander ──────
  describe("lower-confidence expander (Medium-tier active, collapsed by default)", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("does not render the expander when there are no lower-confidence matches", () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      expect(screen.queryByTestId("coi-gap-lower")).toBeNull();
    });

    it("renders a NATIVE collapsed <details> labelled with the count and the muted caveat", () => {
      render(<CoiGapCard cwid="self01" candidates={[CANDIDATES[0]]} lowerCandidates={LOWER} />);
      const lower = screen.getByTestId("coi-gap-lower");
      // It is a native disclosure widget, collapsed by default (no `open` attr).
      expect(lower.tagName).toBe("DETAILS");
      expect((lower as HTMLDetailsElement).open).toBe(false);
      // Summary advertises the count with correct (singular) pluralization.
      expect(lower.querySelector("summary")?.textContent).toContain("Show 1 lower-confidence match");
      // The one muted caveat line frames these as weaker / a co-author's disclosure.
      expect(lower.textContent).toContain(
        "These are weaker matches — often a co-author’s disclosure rather than your own.",
      );
    });

    it("pluralizes the summary for multiple lower-confidence matches", () => {
      const twoLower: EditContextCoiGapCandidate[] = [
        LOWER[0],
        { ...LOWER[0], key: "abbott", entity: "Abbott Labs" },
      ];
      render(<CoiGapCard cwid="self01" candidates={[CANDIDATES[0]]} lowerCandidates={twoLower} />);
      expect(screen.getByTestId("coi-gap-lower").querySelector("summary")?.textContent).toContain(
        "Show 2 lower-confidence matches",
      );
    });

    it("shows the SAME active-row markup inside: verbatim sentence, choices, Gateway review", () => {
      render(<CoiGapCard cwid="self01" candidates={[CANDIDATES[0]]} lowerCandidates={LOWER} />);
      const lower = screen.getByTestId("coi-gap-lower");
      // The verbatim source sentence is rendered (governance — always shown).
      expect(screen.getByTestId("coi-gap-source-lo-1").textContent).toContain(
        "Co-author reports a consulting relationship with Boston Scientific.",
      );
      // The Medium chip reads the green "Likely covered", never a percentage.
      expect(within(lower).getByTestId("coi-gap-tier-Medium").textContent).toBe("Likely covered");
      // All three neutral responses are offered for the Medium row, by verbatim label.
      expect(within(lower).getByTestId("coi-gap-choices-boston scientific")).toBeTruthy();
      expect(
        within(lower).getByTestId("coi-gap-choice-will_disclose-boston scientific").textContent,
      ).toBe("I intend to update my COI statement");
      expect(
        within(lower).getByTestId("coi-gap-choice-historical-boston scientific").textContent,
      ).toBe("Historically true but not currently valid");
      expect(within(lower).getByTestId("coi-gap-choice-invalid-boston scientific").textContent).toBe(
        "Not a valid suggestion",
      );
      // And it carries its own Gateway-review affordance (routes to WRG, not an
      // in-app COI edit). The custom trigger renders by name, not a testid.
      expect(within(lower).getByRole("button", { name: /review in gateway/i })).toBeTruthy();
    });

    it("acting on a Medium row POSTs /feedback for its source(s) and flips the row in place", async () => {
      render(<CoiGapCard cwid="self01" candidates={[CANDIDATES[0]]} lowerCandidates={LOWER} />);
      fireEvent.click(screen.getByTestId("coi-gap-choice-historical-boston scientific"));
      await screen.findByTestId("coi-gap-undo-boston scientific");
      expect(screen.getByTestId("coi-gap-acted-boston scientific").textContent).toBe(
        "Historically true, not currently valid",
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/lo-1/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reason: "historical" }),
        }),
      );
    });
  });

  // ── NEW SURFACE 2 ─ the settled "Reviewed" (current-state) section ──────────
  describe("Reviewed section (settled history — change-of-mind + undo, never a nag)", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("does not render the section when nothing has been reviewed", () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} />);
      expect(screen.queryByTestId("coi-gap-reviewed")).toBeNull();
    });

    it("renders a collapsed <details> with the count, the recorded reason label and the date", () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} reviewed={REVIEWED} />);
      const section = screen.getByTestId("coi-gap-reviewed");
      expect(section.tagName).toBe("DETAILS");
      expect((section as HTMLDetailsElement).open).toBe(false);
      expect(section.querySelector("summary")?.textContent).toBe("Reviewed (1)");
      // The recorded response (its settled ACTED label) and the action date show.
      expect(screen.getByTestId("coi-gap-reviewed-reason-medtronic").textContent).toBe(
        "Historically true, not currently valid",
      );
      expect(screen.getByTestId("coi-gap-reviewed-date-medtronic").textContent).toContain(
        "2026-05-20",
      );
      // It is SETTLED history — no amber "worth reviewing" nag in this section.
      expect(section.textContent).not.toContain("Worth reviewing");
    });

    it("'Change response' reveals the three choices and re-picking POSTs /feedback with the NEW reason", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} reviewed={REVIEWED} />);
      // Choices are hidden until "Change response" is clicked.
      expect(screen.queryByTestId("coi-gap-reviewed-choice-invalid-medtronic")).toBeNull();
      fireEvent.click(screen.getByTestId("coi-gap-reviewed-change-medtronic"));
      const repick = await screen.findByTestId("coi-gap-reviewed-choice-invalid-medtronic");
      fireEvent.click(repick);
      // Re-pick files the NEW reason via /feedback for the source.
      await screen.findByText(/^Not a valid suggestion$/, {
        selector: '[data-testid="coi-gap-reviewed-reason-medtronic"]',
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/rv-1/feedback",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
      );
      // The change-of-mind keeps the row in Reviewed, with the updated label in place.
      expect(screen.getByTestId("coi-gap-reviewed-reason-medtronic").textContent).toBe(
        "Not a valid suggestion",
      );
      expect(screen.getByTestId("coi-gap-reviewed-row-medtronic")).toBeTruthy();
    });

    it("'Undo' POSTs /restore and replaces the row body with a 'moved back' confirmation", async () => {
      render(<CoiGapCard cwid="self01" candidates={CANDIDATES} reviewed={REVIEWED} />);
      fireEvent.click(screen.getByTestId("coi-gap-reviewed-undo-medtronic"));
      await screen.findByText("Moved back to your review.");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/rv-1/restore",
        expect.objectContaining({ method: "POST" }),
      );
      // The settled reason label is gone — the row now reads as moved back.
      expect(screen.queryByTestId("coi-gap-reviewed-reason-medtronic")).toBeNull();
    });
  });

  // ── superuser nag also gates BOTH new surfaces' change-of-mind + undo ────────
  describe("superuser mode — the nag gates Reviewed change-of-mind AND undo", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("a reviewed change-of-mind opens the confirm and does NOT write until confirmed", async () => {
      render(
        <CoiGapCard
          cwid="self01"
          mode="superuser"
          scholarName="Dr. Other"
          candidates={CANDIDATES}
          reviewed={REVIEWED}
        />,
      );
      fireEvent.click(screen.getByTestId("coi-gap-reviewed-change-medtronic"));
      fireEvent.click(screen.getByTestId("coi-gap-reviewed-choice-invalid-medtronic"));
      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      // The nag holds the write back.
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // Governance holds inside the nag — no forbidden accusatory vocabulary.
      const nagText = document.body.textContent ?? "";
      for (const re of FORBIDDEN) {
        expect(nagText, `forbidden word matched: ${re}`).not.toMatch(re);
      }
      // Confirming fires the new reason for the source.
      fireEvent.click(continueBtn);
      await waitFor(() =>
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "/api/edit/coi-gap/rv-1/feedback",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "invalid" }) }),
        ),
      );
    });

    it("a reviewed Undo opens the confirm and only restores after confirmation", async () => {
      render(
        <CoiGapCard
          cwid="self01"
          mode="superuser"
          scholarName="Dr. Other"
          candidates={CANDIDATES}
          reviewed={REVIEWED}
        />,
      );
      fireEvent.click(screen.getByTestId("coi-gap-reviewed-undo-medtronic"));
      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      fireEvent.click(continueBtn);
      await screen.findByText("Moved back to your review.");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/edit/coi-gap/rv-1/restore",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  // ── GOVERNANCE across the two NEW surfaces ──────────────────────────────────
  describe("governance holds across the lower-confidence + Reviewed surfaces", () => {
    it("always renders the verbatim source sentence for an expanded Medium row", () => {
      render(<CoiGapCard cwid="self01" candidates={[CANDIDATES[0]]} lowerCandidates={LOWER} />);
      expect(screen.getByTestId("coi-gap-source-lo-1").textContent).toContain(
        "Co-author reports a consulting relationship with Boston Scientific.",
      );
    });

    it("never surfaces a numeric/percentage score on the new surfaces", () => {
      render(
        <CoiGapCard
          cwid="self01"
          candidates={[CANDIDATES[0]]}
          lowerCandidates={LOWER}
          reviewed={REVIEWED}
        />,
      );
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/%/);
      // No bare 0.NN style relevance score crosses to the client.
      expect(text).not.toMatch(/\b0\.\d/);
    });

    it("contains NONE of the forbidden accusatory words with both new surfaces present", () => {
      render(
        <CoiGapCard
          cwid="self01"
          candidates={[CANDIDATES[0]]}
          lowerCandidates={LOWER}
          reviewed={REVIEWED}
        />,
      );
      const text = document.body.textContent ?? "";
      for (const re of FORBIDDEN) {
        expect(text, `forbidden word matched: ${re}`).not.toMatch(re);
      }
    });
  });
});
