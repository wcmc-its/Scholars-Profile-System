/**
 * Issue #259 §1.11 — `ConceptChip` is the pub-tab affordance that surfaces
 * when a query resolves to a MeSH descriptor. This file pins:
 *
 *   - The chip's two-line copy: "Showing pubs for MeSH concept: {name}"
 *     and "Matched your search for "{matchedQuery}" · Search broadly instead ✕".
 *   - Scope-note rendering uses a `<dfn title="...">` (browser-native
 *     hover/long-press tooltip + AT semantics) ONLY when scopeNote is
 *     non-null. Descriptors without scope notes get a plain `<span>` so
 *     screen readers don't announce an empty tooltip target.
 *   - The "Search broadly instead" link points at the href the page
 *     computed; the chip doesn't synthesize it on its own.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConceptChip } from "@/components/search/concept-chip";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const RESOLUTION_WITH_SCOPE: MeshResolution = {
  descriptorUi: "D057286",
  name: "Electronic Health Records",
  matchedForm: "electronic health records",
  confidence: "exact",
  scopeNote: "Media that store digital health information for individuals.",
  entryTerms: ["EHR", "EMR"],
  curatedTopicAnchors: ["digital-health", "informatics"],
  // §5.4.2 — chip rendering doesn't depend on this field; self-only fixture
  // keeps the invariant (length >= 1, first element === descriptorUi) honest.
  descendantUis: ["D057286"],
};

const RESOLUTION_NO_SCOPE: MeshResolution = {
  ...RESOLUTION_WITH_SCOPE,
  scopeNote: null,
};

describe("ConceptChip", () => {
  it("renders the primary line with the descriptor name", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    expect(screen.getByText(/Showing pubs for MeSH concept/i)).toBeTruthy();
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();
  });

  it("surfaces the scope note in a HoverTooltip on focus (dark-pill aesthetic)", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const name = screen.getByText("Electronic Health Records");
    // Tooltip is not in the DOM until interaction (HoverTooltip lazy-renders).
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Focusing the name shows the tooltip immediately (no 200ms delay path).
    fireEvent.focus(name);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe(
      "Media that store digital health information for individuals.",
    );
  });

  it("mouse-enter also shows the tooltip immediately (no 200ms delay for §1.11)", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const name = screen.getByText("Electronic Health Records");
    fireEvent.mouseEnter(name.parentElement!); // HoverTooltip wraps the name
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("renders a plain <span> with no tooltip when scopeNote is null", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_NO_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const node = screen.getByText("Electronic Health Records");
    expect(node.tagName.toLowerCase()).toBe("span");
    // No HoverTooltip wrapping → focus/hover produces nothing.
    fireEvent.focus(node);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders the matched query in the secondary line, wrapped in curly quotes", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    // The chip renders the user's original query (not resolution.matchedForm)
    // so the line reads naturally even when the resolution came from an
    // entry-term match like "EHR" → "Electronic Health Records".
    const matched = screen.getByText("“EHR”"); // “EHR”
    expect(matched).toBeTruthy();
  });

  it("renders the broaden link at the provided href (not synthesized in the component)", () => {
    render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&type=publications&mesh=off"
      />,
    );
    const link = screen.getByRole("link", { name: /search broadly instead/i });
    expect(link.getAttribute("href")).toBe(
      "/search?q=EHR&type=publications&mesh=off",
    );
  });

  it("declares an accessible label on the chip surface", () => {
    const { container } = render(
      <ConceptChip
        mode="strict"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe(
      "Search refined by MeSH concept",
    );
  });
});

/**
 * Issue #259 §6.1 — `expanded_default` mode renders the new copy and two
 * affordances ("Narrow to this concept only" + "Don't use MeSH ✕").
 */
describe("ConceptChip — expanded_default mode (§6.1)", () => {
  it("renders the 'Boosted by MeSH concept' heading", () => {
    render(
      <ConceptChip
        mode="expanded_default"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        narrowHref="/search?q=EHR&mesh=strict"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    expect(screen.getByText(/Boosted by MeSH concept/i)).toBeTruthy();
    expect(screen.queryByText(/Showing pubs for MeSH concept/i)).toBeNull();
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();
  });

  it("renders the narrow link at narrowHref", () => {
    render(
      <ConceptChip
        mode="expanded_default"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        narrowHref="/search?q=EHR&mesh=strict"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const narrow = screen.getByRole("link", {
      name: /narrow to this concept only/i,
    });
    expect(narrow.getAttribute("href")).toBe("/search?q=EHR&mesh=strict");
  });

  it("renders the broaden link at broadenHref with 'Don't use MeSH ✕' copy", () => {
    render(
      <ConceptChip
        mode="expanded_default"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        narrowHref="/search?q=EHR&mesh=strict"
        broadenHref="/search?q=EHR&mesh=off"
      />,
    );
    const broaden = screen.getByRole("link", { name: /don.?t use MeSH/i });
    expect(broaden.getAttribute("href")).toBe("/search?q=EHR&mesh=off");
    // The strict-mode "Search broadly instead" copy must not appear.
    expect(
      screen.queryByRole("link", { name: /search broadly instead/i }),
    ).toBeNull();
  });
});

/**
 * Issue #259 §6.1 — `expanded_narrow` mode renders the narrow heading and
 * a single "Expand to related ✕" affordance.
 */
describe("ConceptChip — expanded_narrow mode (§6.1)", () => {
  it("renders the 'Narrowed to MeSH concept' heading", () => {
    render(
      <ConceptChip
        mode="expanded_narrow"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        expandHref="/search?q=EHR"
      />,
    );
    expect(screen.getByText(/Narrowed to MeSH concept/i)).toBeTruthy();
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();
  });

  it("renders the expand link at expandHref with 'Expand to related ✕' copy", () => {
    render(
      <ConceptChip
        mode="expanded_narrow"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        expandHref="/search?q=EHR"
      />,
    );
    const expand = screen.getByRole("link", { name: /expand to related/i });
    expect(expand.getAttribute("href")).toBe("/search?q=EHR");
    // Neither narrow nor broaden affordances appear in this mode.
    expect(
      screen.queryByRole("link", { name: /narrow to this concept only/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /don.?t use MeSH/i })).toBeNull();
  });

  it("preserves the scope-note tooltip on the descriptor name", () => {
    render(
      <ConceptChip
        mode="expanded_narrow"
        resolution={RESOLUTION_WITH_SCOPE}
        matchedQuery="EHR"
        expandHref="/search?q=EHR"
      />,
    );
    const name = screen.getByText("Electronic Health Records");
    fireEvent.focus(name);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Media that store digital health information for individuals.",
    );
  });
});
