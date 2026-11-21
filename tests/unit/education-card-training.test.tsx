/** Education panel: postgraduate training rows, Remove on scholar-entered rows
 *  only, and the Add training form's POST body. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { EducationCard } from "@/components/edit/education-card";
import type { EditContextTraining } from "@/lib/api/edit-context";

const training = (over: Partial<EditContextTraining>): EditContextTraining => ({
  externalId: "ASMS-TRAIN-1",
  type: "Residency",
  institution: "University of Pittsburgh Medical Center",
  specialty: "Internal Medicine",
  yearFrom: 2018,
  yearTo: 2021,
  source: "ASMS",
  state: "shown",
  suppressionId: null,
  ...over,
});

function renderCard(trainings: EditContextTraining[]) {
  return render(
    <EducationCard
      cwid="self01"
      mode="self"
      scholarName="Pat Scholar"
      educations={[]}
      trainings={trainings}
      hideYears={false}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("EducationCard — postgraduate training", () => {
  it("lists training rows; only scholar-entered rows can be removed", () => {
    renderCard([
      training({}),
      training({ externalId: "SPS-TRAIN-2", type: "Fellowship", source: "SELF", yearFrom: 2021, yearTo: null }),
    ]);
    expect(screen.getByText("Residency, Internal Medicine")).toBeTruthy();
    expect(screen.getByText(/2018–2021/)).toBeTruthy();
    expect(screen.queryByTestId("training-remove-ASMS-TRAIN-1")).toBeNull();
    expect(screen.getByTestId("training-remove-SPS-TRAIN-2")).toBeTruthy();
  });

  it("Add training posts a create for this scholar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderCard([]);
    fireEvent.click(screen.getByTestId("training-add"));
    const submit = screen.getByTestId("training-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // type + institution required
    fireEvent.change(screen.getByTestId("training-type"), { target: { value: "Fellowship" } });
    fireEvent.change(screen.getByTestId("training-institution"), {
      target: { value: "Massachusetts General Hospital" },
    });
    fireEvent.change(screen.getByTestId("training-year-from"), { target: { value: "2021" } });
    fireEvent.change(screen.getByTestId("training-year-to"), { target: { value: "2024" } });
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/training");
    expect(JSON.parse(init.body)).toEqual({
      action: "create",
      cwid: "self01",
      type: "Fellowship",
      institution: "Massachusetts General Hospital",
      specialty: null,
      yearFrom: 2021,
      yearTo: 2024,
    });
    await waitFor(() => expect(screen.queryByTestId("training-form")).toBeNull());
  });

  it("blocks an end year before the start year", () => {
    renderCard([]);
    fireEvent.click(screen.getByTestId("training-add"));
    fireEvent.change(screen.getByTestId("training-type"), { target: { value: "Residency" } });
    fireEvent.change(screen.getByTestId("training-institution"), { target: { value: "UPMC" } });
    fireEvent.change(screen.getByTestId("training-year-from"), { target: { value: "2021" } });
    fireEvent.change(screen.getByTestId("training-year-to"), { target: { value: "2018" } });
    expect((screen.getByTestId("training-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
