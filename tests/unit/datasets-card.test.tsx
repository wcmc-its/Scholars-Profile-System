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
    title: null,
    provenance: "fulltext-scan",
    pmids: ["36711842"],
    authorPosition: "first",
    state: "shown",
    suppressionId: null,
    hiddenAt: null,
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

describe("DatasetsCard — title + citation line (s-index-ui-proposal.html §5 follow-up)", () => {
  it("appends the title to the headline when present, omits it when absent", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ title: "Single-cell RNA-seq of human cardiac fibroblasts" })]}
      />,
    );
    expect(screen.getByTestId("dataset-row-ds-1").textContent).toContain(
      "GSE12345 — Single-cell RNA-seq of human cardiac fibroblasts",
    );
  });

  it("renders From PMID (role) · method, confidence — the mockup's exact §5 line shape", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ pmids: ["36711842"], authorPosition: "last", provenance: "fulltext-scan", confidence: "high" })]}
      />,
    );
    expect(screen.getByTestId("dataset-row-ds-1").textContent).toContain(
      "From PMID 36711842 (you are last author) · full-text scan, high confidence",
    );
  });

  it("notes extra citing pmids without dropping the first", () => {
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ pmids: ["1", "2", "3"] })]} />);
    expect(screen.getByTestId("dataset-row-ds-1").textContent).toContain(
      "From PMID 1 (+2 more)",
    );
  });

  it("databank provenance maps to the DataBankList label, confidence omitted when null", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ provenance: "databank", confidence: null, pmids: [] })]}
      />,
    );
    const text = screen.getByTestId("dataset-row-ds-1").textContent ?? "";
    expect(text).toContain("You are first author · DataBankList");
    expect(text).not.toContain("confidence");
  });
});

describe("DatasetsCard — row states", () => {
  it("a 'shown' row has the 'Not mine · Remove' button", () => {
    render(<DatasetsCard cwid={CWID} datasets={[dataset({ state: "shown" })]} />);
    const btn = screen.getByTestId("dataset-hide-ds-1");
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("Not mine");
    expect(screen.queryByTestId("dataset-show-ds-1")).toBeNull();
  });

  it("a 'hidden_by_self' row has the Restore button + an accurate removal note, dated when hiddenAt is known", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[
          dataset({ state: "hidden_by_self", suppressionId: "sup-a", hiddenAt: "2026-08-03T12:00:00.000Z" }),
        ]}
      />,
    );
    const restore = screen.getByTestId("dataset-show-ds-1");
    expect(restore.textContent).toContain("Restore");
    expect(screen.queryByTestId("dataset-hide-ds-1")).toBeNull();
    const text = screen.getByTestId("dataset-row-ds-1").textContent ?? "";
    expect(text).toContain("Removed by you on Aug 3 · kept out of your public profile");
    // Never the mockup's aspirational claims — nothing today reads
    // suppressions back into reports or the extraction ruleset.
    expect(text).not.toContain("reports");
    expect(text).not.toContain("ruleset");
  });

  it("omits the date but still shows the removal note when hiddenAt is unknown", () => {
    render(
      <DatasetsCard
        cwid={CWID}
        datasets={[dataset({ state: "hidden_by_self", suppressionId: "sup-a", hiddenAt: null })]}
      />,
    );
    expect(screen.getByText("Removed by you · kept out of your public profile")).toBeTruthy();
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
