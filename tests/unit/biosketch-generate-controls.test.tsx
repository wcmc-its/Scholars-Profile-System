/**
 * #2653 v8 — `BiosketchGenerateControls`: the role-on-the-application select + the contribution
 * line render ONLY for a Personal Statement under a version that takes them (v8); v7 and
 * Contributions mode hide both. A controlled surface: the select reports the role through
 * `onChange`, and the placeholder option clears it back to null.
 *
 * Assertions are scoped to the component root (`container.querySelector`), never document.body.
 * Native DOM assertions (no jest-dom in `tests/setup.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { BiosketchGenerateControls } from "@/components/edit/biosketch-generate-controls";
import { normalizeBiosketchParams, type BiosketchParams } from "@/lib/edit/biosketch-params";

function renderControls(over: Record<string, unknown>) {
  const onChange = vi.fn();
  const value = normalizeBiosketchParams(over);
  const { container } = render(
    <BiosketchGenerateControls
      value={value}
      onChange={onChange}
      model="test-model"
      label=""
      onLabelChange={vi.fn()}
      labelMax={120}
    />,
  );
  const root = container.querySelector('[data-slot="biosketch-generate-controls"]')!;
  return { root, onChange, value };
}

const PS = { mode: "personal_statement", projectTitle: "T", aims: "A" };

describe("BiosketchGenerateControls — role on the application (#2653 v8)", () => {
  it("renders the role select + contribution line for a v8 Personal Statement, above the title", () => {
    const { root } = renderControls({ ...PS, promptVersion: "v8" });
    const role = root.querySelector<HTMLSelectElement>(
      '[data-testid="biosketch-application-role"]',
    );
    const line = root.querySelector<HTMLInputElement>(
      '[data-testid="biosketch-contribution-line"]',
    );
    const title = root.querySelector('[data-testid="biosketch-project-title"]');
    expect(role).not.toBeNull();
    expect(line).not.toBeNull();
    expect(title).not.toBeNull();
    // eight roles + the placeholder, in registry order
    expect(Array.from(role!.options).map((o) => o.value)).toEqual([
      "",
      "pd_pi",
      "mpi",
      "co_investigator",
      "mentor_sponsor",
      "collaborator_consultant",
      "core_director",
      "other_significant_contributor",
      "candidate",
    ]);
    expect(role!.getAttribute("aria-required")).toBe("true");
    expect(line!.getAttribute("maxlength")).toBe("200");
    // DOM order: role precedes the project title
    expect(role!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.querySelector('[data-testid="biosketch-statement-hint"]')!.textContent).toContain(
      "All three are required. The statement argues your fitness for this project in this role.",
    );
  });

  it("hides both under v7, and in Contributions mode under v8", () => {
    const v7 = renderControls({ ...PS, promptVersion: "v7" });
    expect(v7.root.querySelector('[data-testid="biosketch-application-role"]')).toBeNull();
    expect(v7.root.querySelector('[data-testid="biosketch-contribution-line"]')).toBeNull();
    expect(
      v7.root.querySelector('[data-testid="biosketch-statement-hint"]')!.textContent,
    ).toContain("Both are required.");
    const contributions = renderControls({ mode: "contributions", promptVersion: "v8" });
    expect(
      contributions.root.querySelector('[data-testid="biosketch-application-role"]'),
    ).toBeNull();
  });

  it("reports the chosen role and the contribution line through onChange; the placeholder clears", () => {
    const { root, onChange, value } = renderControls({ ...PS, promptVersion: "v8" });
    const role = root.querySelector<HTMLSelectElement>(
      '[data-testid="biosketch-application-role"]',
    )!;
    fireEvent.change(role, { target: { value: "mentor_sponsor" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, applicationRole: "mentor_sponsor" });
    fireEvent.change(role, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, applicationRole: null });
    const line = root.querySelector<HTMLInputElement>(
      '[data-testid="biosketch-contribution-line"]',
    )!;
    fireEvent.change(line, { target: { value: "run the assays" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining<Partial<BiosketchParams>>({ contributionLine: "run the assays" }),
    );
  });

  it("shows the persisted role as selected", () => {
    const { root } = renderControls({ ...PS, promptVersion: "v8", applicationRole: "candidate" });
    const role = root.querySelector<HTMLSelectElement>(
      '[data-testid="biosketch-application-role"]',
    )!;
    expect(role.value).toBe("candidate");
  });
});
