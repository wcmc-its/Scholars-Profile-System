/**
 * Issue #638 — `MeshBoostControl` behavioral tests.
 *
 * Pins the collapsible MeSH boost control that replaces the full-width
 * ConceptChip banner in the publications toolbar:
 *   - Mode-accurate resting heading: strict "Showing pubs for MeSH concept:",
 *     expanded_default "Boosted via MeSH:", expanded_narrow "Narrowed to MeSH
 *     concept:". (The "Boosted" verb is reserved for the re-weight mode.)
 *   - The off-switch is a SEPARATE link (not nested in the chevron trigger),
 *     labelled "Turn off MeSH boosting", pointing at the page-computed href.
 *   - The expanded panel exposes "Narrow to this concept only" (expanded_default
 *     only) + the interpretation slot.
 *   - Default open state: collapsed when concept == query (normalized), open
 *     when they differ. Chevron toggles aria-expanded / aria-controls.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MeshBoostControl } from "@/components/search/mesh-boost-control";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const RESOLUTION: MeshResolution = {
  descriptorUi: "D012734",
  name: "Reproductive Medicine",
  matchedForm: "reproductive medicine",
  confidence: "exact",
  scopeNote: null,
  entryTerms: ["Fertility", "Infertility"],
  curatedTopicAnchors: [],
  descendantUis: ["D012734"],
};

const SLOT = <span data-testid="interp-slot">interpretation</span>;

describe("MeshBoostControl — strict mode", () => {
  it("renders the strict heading + concept name and the broaden off-switch", () => {
    render(
      <MeshBoostControl
        mode="strict"
        resolution={RESOLUTION}
        matchedQuery="reproductive medicine"
        broadenHref="/search?q=reproductive+medicine&type=publications&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    expect(screen.getByText(/Showing pubs for MeSH concept:/)).toBeTruthy();
    expect(screen.getByText("Reproductive Medicine")).toBeTruthy();
    const off = screen.getByRole("link", { name: /turn off mesh boosting/i });
    expect(off.textContent).toMatch(/Search broadly instead/);
    expect(off.getAttribute("href")).toBe(
      "/search?q=reproductive+medicine&type=publications&mesh=off",
    );
    // No "Narrow to this concept only" in strict mode.
    expect(
      screen.queryByRole("link", { name: /narrow to this concept only/i }),
    ).toBeNull();
  });
});

describe("MeshBoostControl — expanded_default mode", () => {
  it("uses the 'Boosted via MeSH:' verb and the 'Don't use MeSH' off-switch", () => {
    render(
      <MeshBoostControl
        mode="expanded_default"
        resolution={RESOLUTION}
        matchedQuery="IVF"
        narrowHref="/search?q=IVF&mesh=strict"
        broadenHref="/search?q=IVF&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    expect(screen.getByText(/Boosted via MeSH:/)).toBeTruthy();
    expect(screen.queryByText(/Showing pubs for MeSH concept/)).toBeNull();
    const off = screen.getByRole("link", { name: /turn off mesh boosting/i });
    expect(off.textContent).toMatch(/Don't use MeSH/);
    expect(off.getAttribute("href")).toBe("/search?q=IVF&mesh=off");
  });

  it("exposes 'Narrow to this concept only' in the panel at narrowHref", () => {
    render(
      <MeshBoostControl
        mode="expanded_default"
        resolution={RESOLUTION}
        matchedQuery="IVF"
        narrowHref="/search?q=IVF&mesh=strict"
        broadenHref="/search?q=IVF&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    // concept (Reproductive Medicine) != query (IVF) → panel defaults open.
    const narrow = screen.getByRole("link", { name: /narrow to this concept only/i });
    expect(narrow.getAttribute("href")).toBe("/search?q=IVF&mesh=strict");
    expect(screen.getByTestId("interp-slot")).toBeTruthy();
  });

  it("defaults OPEN when the concept differs from the query", () => {
    render(
      <MeshBoostControl
        mode="expanded_default"
        resolution={RESOLUTION}
        matchedQuery="IVF"
        narrowHref="/search?q=IVF&mesh=strict"
        broadenHref="/search?q=IVF&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    expect(
      screen.getByRole("button").getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("defaults COLLAPSED when the concept equals the query (normalized)", () => {
    render(
      <MeshBoostControl
        mode="expanded_default"
        resolution={RESOLUTION}
        matchedQuery="  Reproductive   Medicine "
        narrowHref="/search?q=x&mesh=strict"
        broadenHref="/search?q=x&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The chevron trigger controls the panel by id (aria-controls).
    expect(trigger.getAttribute("aria-controls")).toBeTruthy();
    // Toggling opens it.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the off-switch separate from the chevron trigger", () => {
    render(
      <MeshBoostControl
        mode="expanded_default"
        resolution={RESOLUTION}
        matchedQuery="IVF"
        narrowHref="/search?q=IVF&mesh=strict"
        broadenHref="/search?q=IVF&mesh=off"
        interpretationSlot={SLOT}
      />,
    );
    const trigger = screen.getByRole("button");
    const off = screen.getByRole("link", { name: /turn off mesh boosting/i });
    // The off-switch link is not a descendant of the chevron trigger button.
    expect(trigger.contains(off)).toBe(false);
  });
});

describe("MeshBoostControl — expanded_narrow mode", () => {
  it("uses the narrow heading and an 'Expand to related' escape", () => {
    render(
      <MeshBoostControl
        mode="expanded_narrow"
        resolution={RESOLUTION}
        matchedQuery="IVF"
        expandHref="/search?q=IVF"
        interpretationSlot={SLOT}
      />,
    );
    expect(screen.getByText(/Narrowed to MeSH concept:/)).toBeTruthy();
    const escape = screen.getByRole("link", {
      name: /expand to related concepts/i,
    });
    expect(escape.textContent).toMatch(/Expand to related/);
    expect(escape.getAttribute("href")).toBe("/search?q=IVF");
    expect(
      screen.queryByRole("link", { name: /narrow to this concept only/i }),
    ).toBeNull();
  });
});
