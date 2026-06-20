/**
 * `components/edit/overview-versions-panel.tsx` — the "Previous drafts" history
 * list (#742 Phase B). A pure presentation component: it renders one row per
 * generation and fires `onLoad` / `onUseSettings`; the parent owns the fetch and
 * the seed. An empty list renders nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  OverviewVersionsPanel,
  summarizeParams,
} from "@/components/edit/overview-versions-panel";
import { DEFAULT_OVERVIEW_PARAMS, type OverviewParams } from "@/lib/edit/overview-params";

// PARAMS_A pins v2 (so its key_findings label reads "Key findings & significance");
// PARAMS_B is v3 — together they cover both version label paths.
const PARAMS_A: OverviewParams = {
  voice: "third",
  tone: "formal",
  length: "standard",
  elements: ["research_focus", "key_findings"],
  instructions: "",
  promptVersion: "v2",
};

const PARAMS_B: OverviewParams = {
  voice: "first",
  tone: "conversational",
  length: "short",
  elements: [],
  instructions: "be brief",
  promptVersion: "v3",
};

const GENERATIONS = [
  {
    id: "gen-1",
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    promptVersion: "v2",
    params: PARAMS_A,
    createdAt: "2026-06-01T12:00:00.000Z",
    text: "<p>First draft.</p>",
  },
  {
    id: "gen-2",
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    promptVersion: "v3",
    params: PARAMS_B,
    createdAt: "2026-06-02T09:30:00.000Z",
    text: "<p>Second draft.</p>",
  },
];

describe("OverviewVersionsPanel", () => {
  it("renders nothing when the list is empty", () => {
    const { container } = render(
      <OverviewVersionsPanel generations={[]} onLoad={vi.fn()} onUseSettings={vi.fn()} />,
    );
    expect(container.querySelector('[data-testid="overview-versions-panel"]')).toBeNull();
  });

  it("renders one row per generation with the count in the summary", () => {
    render(
      <OverviewVersionsPanel
        generations={GENERATIONS}
        onLoad={vi.fn()}
        onUseSettings={vi.fn()}
      />,
    );
    expect(screen.getByTestId("overview-versions-panel")).toBeTruthy();
    expect(screen.getByText("Previous drafts (2)")).toBeTruthy();
    expect(screen.getByTestId("overview-version-gen-1")).toBeTruthy();
    expect(screen.getByTestId("overview-version-gen-2")).toBeTruthy();
  });

  it("shows the model and a one-line params summary on each row", () => {
    render(
      <OverviewVersionsPanel
        generations={GENERATIONS}
        onLoad={vi.fn()}
        onUseSettings={vi.fn()}
      />,
    );
    // Row 1: third/formal/standard + the two element labels (v2 labelling).
    expect(
      screen.getByText("Third · Formal · Standard · Research focus, Key findings & significance"),
    ).toBeTruthy();
    // Row 2: no elements → just voice/tone/length.
    expect(screen.getByText("First · Conversational · Short")).toBeTruthy();
  });

  it("shows the prompt version + humanized model on each row (#742)", () => {
    render(
      <OverviewVersionsPanel generations={GENERATIONS} onLoad={vi.fn()} onUseSettings={vi.fn()} />,
    );
    // The metadata line concatenates timestamp · version · humanized model.
    const row1 = screen.getByTestId("overview-version-gen-1").textContent ?? "";
    expect(row1).toContain("v2");
    expect(row1).toContain("Claude Sonnet 4.5");
    const row2 = screen.getByTestId("overview-version-gen-2").textContent ?? "";
    expect(row2).toContain("v3");
  });

  it("Load draft fires onLoad with the full generation row", () => {
    const onLoad = vi.fn();
    render(
      <OverviewVersionsPanel
        generations={GENERATIONS}
        onLoad={onLoad}
        onUseSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-version-load-gen-2"));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(GENERATIONS[1]);
  });

  it("Use these settings fires onUseSettings with the row's params", () => {
    const onUseSettings = vi.fn();
    render(
      <OverviewVersionsPanel
        generations={GENERATIONS}
        onLoad={vi.fn()}
        onUseSettings={onUseSettings}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-version-use-settings-gen-1"));
    expect(onUseSettings).toHaveBeenCalledTimes(1);
    expect(onUseSettings).toHaveBeenCalledWith(PARAMS_A);
  });

  it("disables both row buttons when disabled", () => {
    render(
      <OverviewVersionsPanel
        generations={GENERATIONS}
        onLoad={vi.fn()}
        onUseSettings={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByTestId("overview-version-load-gen-1").hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("overview-version-use-settings-gen-1").hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("summarizeParams", () => {
  it("capitalizes voice/tone/length and lists element labels", () => {
    expect(summarizeParams(PARAMS_A)).toBe(
      "Third · Formal · Standard · Research focus, Key findings & significance",
    );
  });

  it("omits the element segment when no themes are emphasized", () => {
    expect(summarizeParams(PARAMS_B)).toBe("First · Conversational · Short");
  });

  it("renders the default params (v3 default — key_findings reads 'Findings & their implications')", () => {
    // #886 — Methods is default-on now that its source is the live scholar_family
    // rollup; the default set is the four core themes (methods sorts before recent).
    // #742 — the default version is v3, which renames the key_findings theme label.
    expect(summarizeParams(DEFAULT_OVERVIEW_PARAMS)).toBe(
      "Third · Formal · Standard · Research focus, Findings & their implications, Methods, Recent work",
    );
  });
});
