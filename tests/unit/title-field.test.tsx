/**
 * `TitleField` (components/edit/title-field.tsx) — the radio-list title picker
 * (design handoff 1a): two-line rows, inapplicable tiers omitted, "Current"
 * on the saved row, Save/Cancel driven by a dirty state, and a header refresh
 * after saving.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

import { TitleField } from "@/components/edit/title-field";
import type { TitleOption } from "@/lib/scholar-title";

const OPTIONS: TitleOption[] = [
  { tier: "working", label: "Working title", value: "Associate Dean for Research" },
  { tier: "chief", label: "Division chief", value: "Chief, Example Division" },
  { tier: "centerHead", label: "Center head", value: null },
  { tier: "primary", label: "Primary title", value: "Professor of Medicine" },
];

function renderField(over: Partial<React.ComponentProps<typeof TitleField>> = {}) {
  return render(
    <TitleField
      cwid="abc1001"
      options={OPTIONS}
      current="Associate Dean for Research"
      hasOverride={false}
      pending={null}
      canSet
      {...over}
    />,
  );
}

const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ primaryTitle: "Professor of Medicine" }),
    }),
  );
});

describe("TitleField — radio list", () => {
  it("renders each applicable tier as a two-line radio row and omits the rest", () => {
    renderField();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    const working = screen.getByTestId("title-option-working");
    expect(working.textContent).toContain("Associate Dean for Research");
    expect(working.textContent).toContain("Working title · Enterprise Directory");
    expect(screen.queryByTestId("title-option-centerHead")).toBeNull();
    expect(screen.queryByText(/on record/)).toBeNull();
  });

  it("explains the working title on its row only", () => {
    renderField();
    const working = screen.getByTestId("title-option-working");
    expect(within(working).getByTestId("working-title-help")).toBeTruthy();
    expect(working.textContent).toContain("Set in the Web Directory for everyday use.");
    expect(screen.getAllByTestId("working-title-help")).toHaveLength(1);
  });

  it("marks the saved row Current and starts clean (Save disabled, no Cancel)", () => {
    renderField();
    expect(within(screen.getByTestId("title-option-working")).getByText("Current")).toBeTruthy();
    expect(screen.getAllByText("Current")).toHaveLength(1);
    expect(save().hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("picking another row makes it dirty; Cancel reverts", () => {
    renderField();
    fireEvent.click(screen.getByTestId("title-option-primary"));
    expect(screen.getByTestId("title-option-primary").getAttribute("aria-checked")).toBe("true");
    expect(save().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Unsaved change")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("title-option-working").getAttribute("aria-checked")).toBe("true");
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("Save posts the chosen title, moves Current, says Saved and refreshes the header", async () => {
    renderField();
    fireEvent.click(screen.getByTestId("title-option-primary"));
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ fieldName: "primaryTitle", value: "Professor of Medicine" });
    expect(within(screen.getByTestId("title-option-primary")).getByText("Current")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a scholar/proxy requests instead of saving", async () => {
    renderField({ canSet: false });
    fireEvent.click(screen.getByTestId("title-option-primary"));
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    await waitFor(() => expect(screen.getByText("Request sent for review.")).toBeTruthy());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.fieldName).toBe("primaryTitleRequest");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("with only one applicable title, shows the plain value (no list)", () => {
    renderField({
      options: OPTIONS.map((o) => (o.tier === "primary" ? o : { ...o, value: null })),
      current: "Professor of Medicine",
    });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Professor of Medicine")).toBeTruthy();
  });
});
