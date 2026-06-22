/**
 * `components/edit/overview-generate-controls.tsx` — the #742 generator steering
 * panel. A pure controlled surface: it owns no state, so each test renders it
 * with a `value` and asserts the `onChange` payload when a control is touched.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { OverviewGenerateControls } from "@/components/edit/overview-generate-controls";
import {
  DEFAULT_OVERVIEW_PARAMS,
  OVERVIEW_ELEMENTS,
  OVERVIEW_INSTRUCTIONS_MAX,
  type OverviewParams,
} from "@/lib/edit/overview-params";
import type { OverviewPromptVersionMeta } from "@/lib/edit/overview-prompt-versions";

function renderControls(overrides?: Partial<OverviewParams>) {
  const value: OverviewParams = { ...DEFAULT_OVERVIEW_PARAMS, ...overrides };
  const onChange = vi.fn();
  render(<OverviewGenerateControls value={value} onChange={onChange} />);
  return { value, onChange };
}

describe("OverviewGenerateControls — rendering", () => {
  it("renders a radio per voice / tone / length option", () => {
    renderControls();
    for (const id of ["overview-voice-third", "overview-voice-first"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    for (const id of [
      "overview-tone-formal",
      "overview-tone-neutral",
      "overview-tone-conversational",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    for (const id of [
      "overview-length-short",
      "overview-length-standard",
      "overview-length-extended",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("renders a checkbox per OVERVIEW_ELEMENTS entry, checked iff in value.elements", () => {
    renderControls(); // defaults: research_focus, key_findings, methods, recent_work
    for (const { key } of OVERVIEW_ELEMENTS) {
      const box = screen.getByTestId(`overview-element-${key}`);
      const checked = box.getAttribute("aria-checked") === "true";
      expect(checked).toBe(DEFAULT_OVERVIEW_PARAMS.elements.includes(key));
    }
  });

  it("renders the instructions textarea with the value and a {n}/{MAX} counter", () => {
    renderControls({ instructions: "hello" });
    const ta = screen.getByTestId("overview-instructions") as HTMLTextAreaElement;
    expect(ta.value).toBe("hello");
    expect(ta.getAttribute("maxlength")).toBe(String(OVERVIEW_INSTRUCTIONS_MAX));
    expect(screen.getByTestId("overview-instructions-count").textContent).toBe(
      `5/${OVERVIEW_INSTRUCTIONS_MAX}`,
    );
  });
});

describe("OverviewGenerateControls — onChange", () => {
  it("selecting the First-person voice radio calls onChange with voice:'first'", () => {
    const { value, onChange } = renderControls(); // voice defaults to 'third'
    fireEvent.click(screen.getByTestId("overview-voice-first"));
    expect(onChange).toHaveBeenCalledWith({ ...value, voice: "first" });
  });

  it("selecting a Tone radio calls onChange with the new tone", () => {
    const { value, onChange } = renderControls();
    fireEvent.click(screen.getByTestId("overview-tone-conversational"));
    expect(onChange).toHaveBeenCalledWith({ ...value, tone: "conversational" });
  });

  it("checking an unchecked element adds it (in display order)", () => {
    // `clinical_applications` is NOT in the defaults; checking it appends in
    // canonical order (it sorts between `methods` and `recent_work`).
    const { value, onChange } = renderControls();
    fireEvent.click(screen.getByTestId("overview-element-clinical_applications"));
    const [next] = onChange.mock.calls[0] as [OverviewParams];
    expect(next.elements).toContain("clinical_applications");
    // Canonical display order: research_focus, key_findings, methods,
    // clinical_applications, recent_work.
    expect(next.elements).toEqual([
      "research_focus",
      "key_findings",
      "methods",
      "clinical_applications",
      "recent_work",
    ]);
    // Other params untouched.
    expect(next.voice).toBe(value.voice);
  });

  it("Methods IS checked by default (#886 — source wired to live scholar_family)", () => {
    // #886 — Methods is default-on now that the generator's method source is the
    // live `scholar_family` rollup; `buildOverviewUserPrompt` drops the emphasis
    // when a scholar has no families, so it stays honest.
    renderControls();
    expect(screen.getByTestId("overview-element-methods").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("unchecking a checked element removes it", () => {
    const { onChange } = renderControls(); // research_focus is checked by default
    fireEvent.click(screen.getByTestId("overview-element-research_focus"));
    const [next] = onChange.mock.calls[0] as [OverviewParams];
    expect(next.elements).not.toContain("research_focus");
    expect(next.elements).toEqual(["key_findings", "methods", "recent_work"]);
  });

  it("typing in the instructions textarea calls onChange with the new text", () => {
    const { value, onChange } = renderControls();
    fireEvent.change(screen.getByTestId("overview-instructions"), {
      target: { value: "mention pediatric trials" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...value, instructions: "mention pediatric trials" });
  });

  it("disabled disables the textarea and the radios", () => {
    render(
      <OverviewGenerateControls value={DEFAULT_OVERVIEW_PARAMS} onChange={vi.fn()} disabled />,
    );
    expect((screen.getByTestId("overview-instructions") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("overview-voice-first").hasAttribute("disabled")).toBe(true);
  });
});

describe("OverviewGenerateControls — prompt version selector (superuser / curator)", () => {
  const versions: OverviewPromptVersionMeta[] = [
    {
      id: "v3",
      label: "v3 — keyword-rich narrative",
      description: "The keyword-rich narrative prompt.",
      status: "default",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    },
    {
      id: "v2",
      label: "v2 — concise (legacy)",
      description: "The original concise prompt.",
      status: "deprecated",
    },
  ];

  it("renders the superuser/curator-only callout and the per-draft cost line", () => {
    render(
      <OverviewGenerateControls
        value={{ ...DEFAULT_OVERVIEW_PARAMS, promptVersion: "v3" }}
        onChange={vi.fn()}
        canSelectPromptVersion
        promptVersions={versions}
      />,
    );
    expect(screen.getByText("Visible to superusers and curators only.")).toBeTruthy();
    // The selected version (v3) carries a resolved model, so the cost line renders.
    expect(screen.getByTestId("overview-prompt-version-cost").textContent).toContain("per draft");
  });
});

describe("OverviewGenerateControls — audience tier", () => {
  it("renders a radio per audience tier with the short label", () => {
    renderControls();
    for (const id of [
      "overview-audience-accessible",
      "overview-audience-informed",
      "overview-audience-technical",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // Short labels ride the buttons (General / Informed / Expert).
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Expert")).toBeTruthy();
  });

  it("selecting an audience tier calls onChange with the new audience", () => {
    const { onChange } = renderControls({ audience: "informed" });
    fireEvent.click(screen.getByTestId("overview-audience-technical"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ audience: "technical" }));
  });

  it("wires each audience tier as a Radix tooltip trigger (description on hover)", () => {
    renderControls();
    // Radix Tooltip.Trigger (asChild) stamps `data-state` on the audience segment label,
    // so it is a tooltip trigger; the description-less Voice control does NOT — proving the
    // hover tooltip is wired only where there is a description. (The portaled tooltip text
    // only mounts on hover, which jsdom can't drive without user-event, so we assert wiring.)
    const audienceLabel = screen.getByTestId("overview-audience-accessible").closest("label");
    expect(audienceLabel?.getAttribute("data-state")).toBeTruthy();
    const voiceLabel = screen.getByTestId("overview-voice-third").closest("label");
    expect(voiceLabel?.getAttribute("data-state")).toBeNull();
  });
});
