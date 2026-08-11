/**
 * `components/edit/datasets-card.tsx` — list / optimistic hide-show / admin-
 * removed inline text (#2348). Mirrors the subset of
 * `publications-card.test.tsx` that applies — no reject / notice / sole-author
 * dialog, since datasets have none of those.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { DatasetsCard } from "@/components/edit/datasets-card";
import type { EditContextDataset } from "@/lib/api/edit-context";

const CWID = "self01";

function dataset(overrides: Partial<EditContextDataset>): EditContextDataset {
  return {
    datasetId: "ds-1",
    repository: "GEO",
    accessionOrDoi: "GSE12345",
    resourceType: "Dataset",
    dataType: "RNA-seq",
    depositYear: 2023,
    accessModel: "open",
    confidence: "high",
    authorPosition: "first",
    state: "shown",
    suppressionId: null,
    ...overrides,
  };
}

function stubFetch(body: object, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("DatasetsCard — empty state + rows", () => {
  it("renders the empty-state copy with zero datasets", () => {
    render(<DatasetsCard cwid={CWID} datasets={[]} />);
    expect(
      screen.getByText("No dataset deposits are currently associated with your profile."),
    ).toBeTruthy();
  });

  it("renders a row with repository, accession link, data type, year, and author position", () => {
    render(<DatasetsCard cwid={CWID} datasets={[dataset({})]} />);
    const row = screen.getByTestId("dataset-row-ds-1");
    expect(row.textContent).toContain("GEO");
    expect(row.textContent).toContain("GSE12345");
    expect(row.textContent).toContain("RNA-seq");
    expect(row.textContent).toContain("2023");
    expect(row.textContent).toContain("first");
    // A GEO accession resolves to a real link (reuses the profile's resolver).
    const link = screen.getByRole("link", { name: "GSE12345" });
    expect(link.getAttribute("href")).toBe(
      "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE12345",
    );
  });
});

describe("DatasetsCard — row states", () => {
  it("a 'shown' row has the Hide button", () => {
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ state: "shown" })]} />);
    expect(screen.getByTestId("dataset-hide-ds-1")).toBeTruthy();
    expect(screen.queryByTestId("dataset-show-ds-1")).toBeNull();
  });

  it("a 'hidden_by_self' row has the Show button + Hidden badge", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    expect(screen.getByTestId("dataset-show-ds-1")).toBeTruthy();
    expect(screen.queryByTestId("dataset-hide-ds-1")).toBeNull();
    expect(screen.getByText("Hidden")).toBeTruthy();
  });

  it("a 'removed_by_admin' row has the inline destructive text and NO control", () => {
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ state: "removed_by_admin" })]} />);
    expect(screen.getByText("Removed by an administrator")).toBeTruthy();
    expect(screen.queryByTestId("dataset-hide-ds-1")).toBeNull();
    expect(screen.queryByTestId("dataset-show-ds-1")).toBeNull();
  });
});

describe("DatasetsCard — optimistic hide", () => {
  it("hide POSTs to /api/edit/suppress with the per-contributor body", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ state: "shown" })]} />);
    fireEvent.click(screen.getByTestId("dataset-hide-ds-1"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "dataset_deposit",
      entityId: "ds-1",
      contributorCwid: CWID,
    });
    // Optimistic flip — the Show button appears.
    await waitFor(() => expect(screen.getByTestId("dataset-show-ds-1")).toBeTruthy());
  });

  it("hide failure reverts the row and renders an inline error", async () => {
    stubFetch({ ok: false, error: "write_failed" }, 500);
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ state: "shown" })]} />);
    fireEvent.click(screen.getByTestId("dataset-hide-ds-1"));
    await waitFor(() =>
      expect(screen.getByText("We couldn't hide this dataset. Please try again.")).toBeTruthy(),
    );
    // Reverted — the Hide button is back.
    expect(await screen.findByTestId("dataset-hide-ds-1")).toBeTruthy();
  });
});

describe("DatasetsCard — show (revoke)", () => {
  it("show POSTs to /api/edit/revoke with the suppression's id", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-a" });
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("dataset-show-ds-1"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse(opts.body as string)).toEqual({ suppressionId: "sup-a" });
  });

  it("show failure reverts to hidden_by_self and renders an inline error", async () => {
    stubFetch({ ok: false, error: "write_failed" }, 500);
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("dataset-show-ds-1"));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't restore this dataset. Please try again."),
      ).toBeTruthy(),
    );
    // Reverted — the Show button is back.
    expect(await screen.findByTestId("dataset-show-ds-1")).toBeTruthy();
  });
});
