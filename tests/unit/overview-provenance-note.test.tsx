/**
 * `components/edit/overview-provenance-note.tsx` — the muted "how this bio was
 * produced" line (#742 Phase B). A pure presentation component: each origin maps
 * to a fixed string; `null` provenance renders nothing.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { OverviewProvenanceNote } from "@/components/edit/overview-provenance-note";

const UPDATED_AT = "2026-06-01T12:00:00.000Z";

describe("OverviewProvenanceNote", () => {
  it("renders nothing when provenance is null", () => {
    const { container } = render(<OverviewProvenanceNote provenance={null} />);
    expect(container.querySelector('[data-testid="overview-provenance-note"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("authored → 'written by you'", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "authored", model: null, updatedAt: UPDATED_AT }}
      />,
    );
    expect(screen.getByText("Current bio: written by you.")).toBeTruthy();
  });

  it("generated → 'generated with {model}'", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "generated", model: "openai/gpt", updatedAt: UPDATED_AT }}
      />,
    );
    expect(screen.getByText("Current bio: generated with openai/gpt.")).toBeTruthy();
  });

  it("generated_edited → 'generated with {model}, then edited by you'", () => {
    render(
      <OverviewProvenanceNote
        provenance={{ origin: "generated_edited", model: "google/gemini", updatedAt: UPDATED_AT }}
      />,
    );
    expect(
      screen.getByText("Current bio: generated with google/gemini, then edited by you."),
    ).toBeTruthy();
  });
});
