/**
 * Nci2aCard — the NCI Table 2A review panel.
 *
 *  - loads via GET on mount, renders the row shape (PI, project, $, badges);
 *  - an "AI-suggested" badge on an `llm`-sourced value, "Confirmed" on
 *    `human`, none on `membership` (existing data, not a judgment call);
 *  - editing the Cancer-Relevant % input and blurring PATCHes
 *    `{cancerRelevantPercent}` and re-fetches;
 *  - changing the Program select PATCHes `{allocations:[{programCode,...}]}`;
 *  - empty state when the center has no import cycle yet.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { Nci2aCard } from "@/components/edit/cancer-center-nci-2a-card";

const PAYLOAD = {
  cycle: "osra-2026-07-14",
  programs: [
    { code: "CB", label: "Cancer Biology" },
    { code: "CGE", label: "Cancer Genetics & Epigenetics" },
  ],
  awards: [
    {
      id: "award-1",
      pi: "Test, PI",
      specificFundingSource: "National Cancer Institute",
      projectNumber: "5 R01 CA000000-01",
      projectTitle: "A cancer project",
      projectStartDate: "2024-01-01",
      projectEndDate: "2028-12-31",
      annualProjectDirectCosts: 200000,
      cancerRelevantPercent: 90,
      cancerRelevantPercentSource: "llm",
      cancerRelevantRationale: "because the title says so",
      cancerRelevantAnnualProjectDc: 180000,
      allocations: [
        { id: "alloc-1", programCode: "CB", programLabel: "Cancer Biology", programPercent: 100, source: "membership", annualProgramDirectCosts: 180000 },
      ],
    },
  ],
};

function mockFetch() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init) {
      // GET
      return { ok: true, json: async () => PAYLOAD };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("Nci2aCard", () => {
  it("loads and renders the row", async () => {
    mockFetch();
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());
    expect(screen.getByText(/A cancer project/)).toBeTruthy();
    expect(screen.getByText("$200,000")).toBeTruthy();
  });

  it("shows the AI-suggested badge for the llm-sourced percent, none for the membership-sourced allocation", async () => {
    mockFetch();
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());
    expect(screen.getByText("AI-suggested")).toBeTruthy(); // percent, source=llm
    expect(screen.queryByText("Confirmed")).toBeNull(); // allocation, source=membership
  });

  it("PATCHes cancerRelevantPercent on blur when the value changed", async () => {
    const fetchMock = mockFetch();
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());

    const input = screen.getByDisplayValue("90") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/edit/center/meyer_cancer_center/nci-2a/award-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ cancerRelevantPercent: 45 }),
        }),
      ),
    );
  });

  it("does NOT patch when the percent is unchanged", async () => {
    const fetchMock = mockFetch();
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());

    const input = screen.getByDisplayValue("90") as HTMLInputElement;
    fireEvent.blur(input);

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET
  });

  it("does NOT patch a 0% on a not-yet-inferred (null) row from an empty blur", async () => {
    // Regression: Number("") === 0, not NaN — a not-yet-inferred row renders
    // an empty input, and tabbing through it (no digit typed) must never
    // silently confirm a real 0% on a federal reporting artifact.
    const nullPercentPayload = {
      ...PAYLOAD,
      awards: [{ ...PAYLOAD.awards[0], cancerRelevantPercent: null, cancerRelevantPercentSource: "llm" }],
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => nullPercentPayload }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.blur(input);

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET — no PATCH
  });

  it("PATCHes allocations when the program select changes", async () => {
    const fetchMock = mockFetch();
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText("Test, PI")).toBeTruthy());

    const select = screen.getByDisplayValue("CB — Cancer Biology") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "CGE" } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/edit/center/meyer_cancer_center/nci-2a/award-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ allocations: [{ programCode: "CGE", programPercent: 100 }] }),
        }),
      ),
    );
  });

  it("shows an empty-cycle message when there are no awards yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cycle: null, programs: [], awards: [] }) }),
    );
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText(/No import cycle found yet/)).toBeTruthy());
  });

  it("shows an error message on a failed load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    render(<Nci2aCard centerCode="meyer_cancer_center" />);
    await waitFor(() => expect(screen.getByText(/Failed to load/)).toBeTruthy());
  });
});
