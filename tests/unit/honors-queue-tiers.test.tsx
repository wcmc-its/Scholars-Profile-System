/**
 * `components/edit/honors-queue.tsx` — honor tiers. Possible opens on reliable
 * matches; "All matches" widens it; a tier chip narrows to one tier; the card's
 * tier select POSTs every row of the line to /api/edit/honor/tier. All names
 * are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { HonorsQueue } from "@/components/edit/honors-queue";
import type { HonorQueueGroup, HonorQueueRow, HonorSourcesSummary } from "@/lib/edit/honor-queue";

function row(over: Partial<HonorQueueRow>): HonorQueueRow {
  return {
    id: "h1",
    cwid: "zzz1001",
    slug: null,
    scholarName: "Ada Example",
    roleLabel: "Full-time faculty",
    roleCategory: "full_time_faculty",
    title: "Professor of Testing",
    department: "Testing",
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "Invented Academy",
    year: 2024,
    tier: 5,
    tierOverridden: false,
    source: "SEED",
    sourceRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decidedByName: null,
    rejectionReason: null,
    superseded: false,
    competingCwids: [],
    evidence: null,
    ...over,
  };
}

function grp(
  key: string,
  rows: HonorQueueRow[],
  rosterMatchedName: string | null = null,
): HonorQueueGroup {
  return {
    key,
    rows,
    rosterMatchedName,
    contested: new Set(rows.map((r) => r.cwid)).size > 1,
    reliable: true,
  };
}

const NO_SOURCES: HonorSourcesSummary = { sources: [], runs: [], lists: [] };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sure = grp("sure", [row({ id: "s1", name: "Grand Prize", tier: 1 })], "Ada Example");
const unsure = {
  ...grp("unsure", [row({ id: "u1", name: "Society Medal", tier: 5 })], "Ada Q. Example"),
  reliable: false,
};

function renderQueue(readOnly = false) {
  return render(
    <HonorsQueue
      pending={[sure, unsure]}
      approved={[]}
      rejected={[]}
      userAsserted={[]}
      sources={NO_SOURCES}
      readOnly={readOnly}
    />,
  );
}

describe("HonorsQueue — tiers and reliability", () => {
  it("opens on reliable matches and widens to all", () => {
    renderQueue();
    expect(screen.queryByText("Grand Prize")).not.toBeNull();
    expect(screen.queryByText("Society Medal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All matches 2/ }));
    expect(screen.queryByText("Society Medal")).not.toBeNull();
  });

  it("narrows to one tier with a chip", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /All matches/ }));
    fireEvent.click(screen.getByRole("button", { name: /^5 · / }));
    expect(screen.queryByText("Grand Prize")).toBeNull();
    expect(screen.queryByText("Society Medal")).not.toBeNull();
  });

  it("posts a tier change for the line and shows it", async () => {
    renderQueue();
    const select = screen.getByLabelText("Honor tier") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/honor/tier");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ids: ["s1"], tier: 3 });
    await waitFor(() =>
      expect((screen.getByLabelText("Honor tier") as HTMLSelectElement).value).toBe("3"),
    );
  });

  it("shows the tier as text, with no select, to an observer", () => {
    renderQueue(true);
    expect(screen.queryByLabelText("Honor tier")).toBeNull();
    expect(screen.queryByText(/Tier 1 · Pinnacle prizes/)).not.toBeNull();
  });
});
