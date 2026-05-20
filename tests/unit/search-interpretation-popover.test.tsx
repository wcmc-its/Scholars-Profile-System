/**
 * Issue #265 Phase 1 — `SearchInterpretationPopover` behavioral tests.
 *
 * Pins:
 *   - Trigger renders the state-stable label "Search interpretation" in
 *     both `mesh-expanded` and `free-text` states.
 *   - Click-to-toggle opens / closes the popover; ESC closes.
 *   - Mesh-expanded state renders the descriptor name + UI, scope note
 *     (when present), entry-term list (capped at 12 with a "Show all N"
 *     toggle), and the NLM MeSH browser link with the correct target.
 *   - Free-text state has no browser link.
 *   - Telemetry beacons fire on open + on browser-link click, with the
 *     contract the analytics handler expects.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { SearchInterpretationPopover } from "@/components/search/search-interpretation-popover";
import type { SearchInterpretation } from "@/lib/api/search-interpretation";

const MESH_EXPANDED: SearchInterpretation = {
  mode: "mesh-expanded",
  meshMatches: [
    {
      descriptorId: "D057286",
      name: "Electronic Health Records",
      entryTerms: ["EHR", "EMR", "Electronic Medical Records"],
      scopeNote:
        "Media that store digital health information for individuals.",
      confidence: "exact",
    },
  ],
};

const FREE_TEXT: SearchInterpretation = {
  mode: "free-text",
  meshMatches: [],
};

function withSendBeaconSpy(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => true);
  Object.defineProperty(window.navigator, "sendBeacon", {
    configurable: true,
    value: spy,
  });
  return spy;
}

describe("SearchInterpretationPopover — trigger", () => {
  it("renders the trigger with the state-stable label in mesh-expanded", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Search interpretation",
    });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the trigger with the state-stable label in free-text", () => {
    render(
      <SearchInterpretationPopover interpretation={FREE_TEXT} q="sprezzatura" />,
    );
    expect(
      screen.getByRole("button", { name: "Search interpretation" }),
    ).toBeTruthy();
  });
});

describe("SearchInterpretationPopover — mesh-expanded content", () => {
  beforeEach(() => {
    withSendBeaconSpy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens on click and renders the descriptor name + UI", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();
    expect(screen.getByText("(D057286)")).toBeTruthy();
  });

  it("renders the scope note when present", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(
      screen.getByText(
        "Media that store digital health information for individuals.",
      ),
    ).toBeTruthy();
  });

  it("does not render the scope note when null", () => {
    const interpretation: SearchInterpretation = {
      mode: "mesh-expanded",
      meshMatches: [{ ...MESH_EXPANDED.meshMatches[0], scopeNote: null }],
    };
    render(
      <SearchInterpretationPopover interpretation={interpretation} q="x" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.queryByText(/Media that store/)).toBeNull();
  });

  it("renders the entry-term list inline (under cap)", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(
      screen.getByText("EHR, EMR, Electronic Medical Records"),
    ).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("collapses entry terms above the cap and expands on toggle", () => {
    const manyTerms = Array.from({ length: 15 }, (_, i) => `Term${i + 1}`);
    const interpretation: SearchInterpretation = {
      mode: "mesh-expanded",
      meshMatches: [{ ...MESH_EXPANDED.meshMatches[0], entryTerms: manyTerms }],
    };
    render(
      <SearchInterpretationPopover interpretation={interpretation} q="x" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );

    expect(screen.getByText(/Term12/)).toBeTruthy();
    expect(screen.queryByText(/Term13/)).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show all 15" });
    fireEvent.click(toggle);

    expect(screen.getByText(/Term13/)).toBeTruthy();
    expect(screen.getByText(/Term15/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
  });

  it("renders an `entry-term` confidence sub-line only when the match was via an entry term", () => {
    const exact = render(
      <SearchInterpretationPopover interpretation={MESH_EXPANDED} q="x" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.queryByText(/via an entry term/i)).toBeNull();
    exact.unmount();

    const entryTermInterpretation: SearchInterpretation = {
      mode: "mesh-expanded",
      meshMatches: [
        { ...MESH_EXPANDED.meshMatches[0], confidence: "entry-term" },
      ],
    };
    render(
      <SearchInterpretationPopover
        interpretation={entryTermInterpretation}
        q="ehr"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.getByText(/via an entry term/i)).toBeTruthy();
  });

  it("renders the NLM MeSH browser link with target=_blank and rel=noopener noreferrer", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    const link = screen.getByRole("link", {
      name: /View in MeSH browser/i,
    });
    expect(link.getAttribute("href")).toBe(
      "https://meshb.nlm.nih.gov/record/ui?ui=D057286",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("SearchInterpretationPopover — close behavior", () => {
  beforeEach(() => {
    withSendBeaconSpy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes on ESC and the descriptor name leaves the DOM", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Search interpretation",
    });
    fireEvent.click(trigger);
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByText("Electronic Health Records")).toBeNull();
  });

  it("closes on a second click of the trigger (toggle semantics)", () => {
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Search interpretation",
    });
    fireEvent.click(trigger);
    expect(screen.getByText("Electronic Health Records")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByText("Electronic Health Records")).toBeNull();
  });
});

describe("SearchInterpretationPopover — free-text content", () => {
  beforeEach(() => {
    withSendBeaconSpy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens on click and renders the no-match explainer with the raw query", () => {
    render(
      <SearchInterpretationPopover interpretation={FREE_TEXT} q="sprezzatura" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.getByText(/No MeSH concept matched/i)).toBeTruthy();
    expect(screen.getByText("sprezzatura")).toBeTruthy();
    expect(
      screen.getByText(/title, abstract, journal, and author/i),
    ).toBeTruthy();
  });

  it("has no NLM browser link in the free-text state", () => {
    render(
      <SearchInterpretationPopover interpretation={FREE_TEXT} q="sprezzatura" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );
    expect(screen.queryByRole("link", { name: /MeSH browser/i })).toBeNull();
  });
});

describe("SearchInterpretationPopover — telemetry", () => {
  it("fires `search_popover_opened` with mode + descriptorId on open (mesh-expanded)", () => {
    const beacon = withSendBeaconSpy();
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0];
    expect(url).toBe("/api/analytics");
    const payload = JSON.parse(body as string);
    expect(payload.event).toBe("search_popover_opened");
    expect(payload.q).toBe("electronic health records");
    expect(payload.mode).toBe("mesh-expanded");
    expect(payload.descriptorId).toBe("D057286");
    expect(typeof payload.ts).toBe("number");

    vi.restoreAllMocks();
  });

  it("fires `search_popover_opened` with mode=free-text and null descriptorId in free-text", () => {
    const beacon = withSendBeaconSpy();
    render(
      <SearchInterpretationPopover interpretation={FREE_TEXT} q="sprezzatura" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );

    const payload = JSON.parse(beacon.mock.calls[0][1] as string);
    expect(payload.event).toBe("search_popover_opened");
    expect(payload.mode).toBe("free-text");
    expect(payload.descriptorId).toBeNull();

    vi.restoreAllMocks();
  });

  it("does not fire on close transition (open-only beacon)", () => {
    const beacon = withSendBeaconSpy();
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Search interpretation",
    });
    fireEvent.click(trigger);
    expect(beacon).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(trigger);
    });
    expect(beacon).toHaveBeenCalledTimes(1); // unchanged

    vi.restoreAllMocks();
  });

  it("fires `search_popover_mesh_browser_clicked` with descriptorId on NLM link click", () => {
    const beacon = withSendBeaconSpy();
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Search interpretation" }),
    );

    const link = screen.getByRole("link", { name: /View in MeSH browser/i });
    fireEvent.click(link);

    const browserCall = beacon.mock.calls.find(
      ([, body]) =>
        JSON.parse(body as string).event ===
        "search_popover_mesh_browser_clicked",
    );
    expect(browserCall).toBeTruthy();
    const payload = JSON.parse(browserCall![1] as string);
    expect(payload.q).toBe("electronic health records");
    expect(payload.descriptorId).toBe("D057286");

    vi.restoreAllMocks();
  });

  it("does not throw if `navigator.sendBeacon` is missing", () => {
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: undefined,
    });
    render(
      <SearchInterpretationPopover
        interpretation={MESH_EXPANDED}
        q="electronic health records"
      />,
    );
    expect(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Search interpretation" }),
      );
    }).not.toThrow();
  });
});
