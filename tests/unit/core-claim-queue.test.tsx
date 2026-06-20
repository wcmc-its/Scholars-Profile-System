/**
 * The per-core review queue client component (components/edit/core-claim-queue).
 * Renders candidate evidence and posts confirm/reject to /api/edit/core-claim with
 * optimistic local state. fetch is mocked — no DB/network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "30418319",
    title: "Advanced MRI of the brain",
    journal: "NeuroImage",
    year: 2021,
    authorsString: "Ballon D, Dyke J",
    likelihood: 0.82,
    status: "candidate",
    coauthors: ["djb2001"],
    ackAlias: "CBIC",
    ackSnippet: "processed at the Citigroup Biomedical Imaging Center",
    llmScore: 7,
    ...over,
  };
}

const CORE = { id: "2", name: "Biomedical Imaging" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoreClaimQueue", () => {
  it("renders a candidate with its evidence chips", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
    expect(screen.getByText("82% likely")).toBeTruthy();
    expect(screen.getByText("Named: CBIC")).toBeTruthy();
    expect(screen.getByText("1 core-staff co-author")).toBeTruthy();
    expect(screen.getByText("LLM 7/10")).toBeTruthy();
  });

  it("posts a claim and moves the row out of the review list on Confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim");
    expect(JSON.parse(init.body)).toEqual({ pmid: "30418319", coreId: "2", status: "claimed" });

    // the confirmed row leaves "To review" (its Confirm button is gone)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull(),
    );
  });

  it("surfaces an error and keeps the row when the POST is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "not_core_owner" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not_core_owner"),
    );
    // still reviewable — the Confirm button is still present
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
  });
});
