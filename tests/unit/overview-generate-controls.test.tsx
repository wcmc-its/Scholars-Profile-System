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
    renderControls(); // defaults: research_focus, key_findings, recent_work
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

  it("Methods is checked by default (#875)", () => {
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
    // #875 — methods now sits in the default set between key_findings and recent_work.
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
