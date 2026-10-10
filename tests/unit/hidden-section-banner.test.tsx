/**
 * `components/edit/hidden-section-banner.tsx` + `sectionVisibility` in
 * `components/edit/edit-page.tsx` — the "hidden on your public profile" notice
 * above an /edit panel whose public section is dark, with one-click Show + Undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { HiddenSectionBanner } from "@/components/edit/hidden-section-banner";
import { sectionVisibility } from "@/components/edit/edit-page";

const SHOW = { fieldName: "hideFunding", value: "false" } as const;
const UNDO = { fieldName: "hideFunding", value: "true" } as const;

beforeEach(() => {
  vi.restoreAllMocks();
  mockRefresh.mockReset();
});

function stubFetch(ok = true) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500 }),
    );
}

const bodyOf = (spy: ReturnType<typeof stubFetch>, i: number) =>
  JSON.parse((spy.mock.calls[i][1] as RequestInit).body as string);

describe("HiddenSectionBanner", () => {
  const props = { cwid: "self01", thirdPerson: false, show: SHOW, undo: UNDO };

  it("renders nothing when the section is visible", () => {
    const { container } = render(<HiddenSectionBanner {...props} hidden={false} canShow />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the notice with 'Show it' for an editor who may change visibility", () => {
    render(<HiddenSectionBanner {...props} hidden canShow />);
    expect(screen.getByText("Hidden on your public profile.")).toBeTruthy();
    expect(screen.getByTestId("hidden-section-show")).toBeTruthy();
  });

  it("omits the button for a delegated editor and speaks in third person", () => {
    render(<HiddenSectionBanner {...props} thirdPerson hidden canShow={false} />);
    expect(screen.getByText("Hidden on their public profile.")).toBeTruthy();
    expect(screen.queryByTestId("hidden-section-show")).toBeNull();
  });

  it("Show writes the show field, then Undo writes it back", async () => {
    const spy = stubFetch();
    const { rerender } = render(<HiddenSectionBanner {...props} hidden canShow />);
    fireEvent.click(screen.getByTestId("hidden-section-show"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, 0)).toEqual({ entityType: "scholar", entityId: "self01", ...SHOW });

    // The server now reports the section visible; Undo must stay on screen.
    rerender(<HiddenSectionBanner {...props} hidden={false} canShow />);
    expect(screen.getByTestId("hidden-section-shown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
    expect(bodyOf(spy, 1)).toEqual({ entityType: "scholar", entityId: "self01", ...UNDO });

    rerender(<HiddenSectionBanner {...props} hidden canShow />);
    expect(screen.getByTestId("hidden-section-banner")).toBeTruthy();
  });

  it("keeps the notice and shows an error when the write fails", async () => {
    stubFetch(false);
    render(<HiddenSectionBanner {...props} hidden canShow />);
    fireEvent.click(screen.getByTestId("hidden-section-show"));
    expect(await screen.findByText(/couldn't update that section/)).toBeTruthy();
    expect(screen.getByTestId("hidden-section-banner")).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("sectionVisibility", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.DATA_SHARING_SECTION;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DATA_SHARING_SECTION;
    else process.env.DATA_SHARING_SECTION = prev;
  });

  it("is null for an attr with no hideable public section", () => {
    expect(sectionVisibility("overview", [])).toBeNull();
    expect(sectionVisibility("publications", ["hideFunding"])).toBeNull();
  });

  it("maps each hideable attr to its Visibility switch", () => {
    expect(sectionVisibility("funding", ["hideFunding"])).toEqual({
      hidden: true,
      show: SHOW,
      undo: UNDO,
    });
    expect(sectionVisibility("funding", [])!.hidden).toBe(false);
    expect(sectionVisibility("mentees", ["hideMentoring"])!.hidden).toBe(true);
    expect(sectionVisibility("education", ["hideEducation"])!.hidden).toBe(true);
    expect(sectionVisibility("technologies", ["hideTechnologies"])!.hidden).toBe(true);
    // hideEducationYears hides no section.
    expect(sectionVisibility("education", ["hideEducationYears"])!.hidden).toBe(false);
  });

  it("Datasets with the env switch off: hidden until the showDatasets opt-in", () => {
    delete process.env.DATA_SHARING_SECTION;
    expect(sectionVisibility("datasets", [])).toEqual({
      hidden: true,
      show: { fieldName: "showDatasets", value: "true" },
      undo: { fieldName: "showDatasets", value: "false" },
    });
    expect(sectionVisibility("datasets", ["showDatasets"])!.hidden).toBe(false);
  });

  it("Datasets with the env switch on: visible until hideDatasets", () => {
    process.env.DATA_SHARING_SECTION = "on";
    expect(sectionVisibility("datasets", [])!.hidden).toBe(false);
    expect(sectionVisibility("datasets", ["hideDatasets"])).toEqual({
      hidden: true,
      show: { fieldName: "hideDatasets", value: "false" },
      undo: { fieldName: "hideDatasets", value: "true" },
    });
    // The opt-in wins, as in lib/api/profile.ts.
    expect(sectionVisibility("datasets", ["hideDatasets", "showDatasets"])!.hidden).toBe(false);
  });
});
