/**
 * `components/edit/overview-provenance-note.tsx` — the muted "how this bio was
 * produced" line (#742 Phase B) + the "Last updated {date}" clause and the
 * imported-bio fallback (#1077). A pure presentation component.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { OverviewProvenanceNote } from "@/components/edit/overview-provenance-note";

// Noon UTC → the same calendar day (Jun 1, 2026) in every US timezone, so the
// formatted date is stable regardless of where the test runs.
const UPDATED_AT = "2026-06-01T12:00:00.000Z";

function noteText(): string {
  return screen.getByTestId("overview-provenance-note").textContent ?? "";
}

describe("OverviewProvenanceNote", () => {
  it("renders nothing when provenance is null and no overview exists", () => {
    const { container } = render(<OverviewProvenanceNote provenance={null} />);
    expect(container.querySelector('[data-testid="overview-provenance-note"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("authored → 'written by you' + last-updated date", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "authored", model: null, updatedAt: UPDATED_AT }}
      />,
    );
    const text = noteText();
    expect(text).toContain("Current overview: written by you");
    expect(text).toContain("Last updated");
    expect(text).toContain("Jun 1, 2026");
  });

  it("generated → 'generated with {model}' + last-updated date", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "generated", model: "openai/gpt", updatedAt: UPDATED_AT }}
      />,
    );
    const text = noteText();
    expect(text).toContain("Current overview: generated with openai/gpt");
    expect(text).toContain("Last updated Jun 1, 2026");
  });

  it("generated_edited → 'generated with {model}, then edited by you' + date", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "generated_edited", model: "google/gemini", updatedAt: UPDATED_AT }}
      />,
    );
    const text = noteText();
    expect(text).toContain("Current overview: generated with google/gemini, then edited by you");
    expect(text).toContain("Last updated Jun 1, 2026");
  });

  // #1077 follow-up — superuser-on-behalf reframing: never "by you" (which would
  // read as the superuser), the method stated neutrally instead.
  it("superuser authored → 'written manually', never 'by you'", () => {
    render(
      <OverviewProvenanceNote
        mode="superuser"
        provenance={{ origin: "authored", model: null, updatedAt: UPDATED_AT }}
      />,
    );
    const text = noteText();
    expect(text).toContain("Current overview: written manually");
    expect(text).toContain("Last updated Jun 1, 2026");
    expect(text).not.toContain("by you");
  });

  it("superuser generated_edited → 'then edited manually', never 'by you'", () => {
    render(
      <OverviewProvenanceNote
        mode="superuser"
        provenance={{ origin: "generated_edited", model: "google/gemini", updatedAt: UPDATED_AT }}
      />,
    );
    const text = noteText();
    expect(text).toContain("generated with google/gemini, then edited manually");
    expect(text).not.toContain("by you");
  });

  it("superuser generated → identical to self (no person in the copy)", () => {
    render(
      <OverviewProvenanceNote
        mode="superuser"
        provenance={{ origin: "generated", model: "openai/gpt", updatedAt: UPDATED_AT }}
      />,
    );
    expect(noteText()).toContain("Current overview: generated with openai/gpt");
  });

  // #1077 — imported-bio fallback: no provenance row, but a bio exists and the
  // read has resolved → label it honestly, with no fabricated date.
  it("no provenance + saved overview + loaded → imported-bio label", () => {
    render(<OverviewProvenanceNote provenance={null} loaded hasSavedOverview />);
    const text = noteText();
    expect(text).toContain("Imported from the previous profile system");
    expect(text).toContain("not yet edited here");
    expect(text).not.toContain("Last updated");
  });

  it("no provenance + saved overview but NOT yet loaded → renders nothing (no flash)", () => {
    const { container } = render(
      <OverviewProvenanceNote provenance={null} loaded={false} hasSavedOverview />,
    );
    expect(container.querySelector('[data-testid="overview-provenance-note"]')).toBeNull();
  });

  it("no provenance + no saved overview → renders nothing", () => {
    const { container } = render(
      <OverviewProvenanceNote provenance={null} loaded hasSavedOverview={false} />,
    );
    expect(container.querySelector('[data-testid="overview-provenance-note"]')).toBeNull();
  });
});
