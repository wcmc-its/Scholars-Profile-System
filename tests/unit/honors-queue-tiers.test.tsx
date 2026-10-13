/**
 * `components/edit/honors-queue.tsx` — the split review (2026-10-13 mockup):
 * Possible opens on strong matches; the Match and Tier selects narrow it; the
 * review pane's tier select POSTs the line; J/K move, A approves, X selects and
 * the bulk bar decides the selection; flags warn on a duplicate. All names are
 * invented.
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

const QUOTE = "“Dr. Ada Example of Weill Cornell Medicine has won the Grand Prize.”";
/** Strong: listed name, quote names her, Weill Cornell, the award. */
const sure = grp(
  "sure",
  [row({ id: "s1", name: "Grand Prize", tier: 1, year: 2024, evidence: QUOTE })],
  "Ada Example",
);
/** Weak: the quote names neither her nor the award nor Weill Cornell. */
const unsure = grp(
  "unsure",
  [row({ id: "u1", name: "Society Medal", tier: 5, evidence: "“A colleague was honored.”" })],
  "Ada Q. Example",
);

function renderQueue(opts: { readOnly?: boolean; approved?: HonorQueueGroup[] } = {}) {
  return render(
    <HonorsQueue
      pending={[sure, unsure]}
      approved={opts.approved ?? []}
      rejected={[]}
      userAsserted={[]}
      sources={NO_SOURCES}
      readOnly={opts.readOnly}
    />,
  );
}
const sel = (c: HTMLElement, slot: string) =>
  c.querySelector(`[data-slot="${slot}"] select`) as HTMLSelectElement;
const listRows = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-slot="honor-review-row"]')].map((r) => r.getAttribute("data-row"));

describe("HonorsQueue — split review", () => {
  it("opens on strong matches; Match widens; Tier narrows", () => {
    const { container } = renderQueue();
    expect(listRows(container)).toEqual(["sure"]);
    fireEvent.change(sel(container, "honors-match-filter"), { target: { value: "all" } });
    expect(listRows(container)).toEqual(["sure", "unsure"]);
    fireEvent.change(sel(container, "honors-tier-filter"), { target: { value: "5" } });
    expect(listRows(container)).toEqual(["unsure"]);
  });

  it("shows the match checklist and highlights the quote", () => {
    const { container } = renderQueue();
    const signals = container.querySelector('[data-slot="honor-signals"]')!.textContent;
    expect(signals).toContain("Quote names the scholar");
    expect(signals).toContain("Quote mentions Weill Cornell");
    expect(signals).toContain("Quote names this award");
    const marks = [...container.querySelectorAll('[data-slot="honor-evidence"] mark')].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(
      expect.arrayContaining(["Ada Example", "Weill Cornell Medicine", "Grand Prize"]),
    );
  });

  it("posts a tier change for the focused line", async () => {
    renderQueue();
    fireEvent.change(screen.getByLabelText("Honor tier"), { target: { value: "3" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/honor/tier");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ids: ["s1"], tier: 3 });
  });

  it("keyboard: J moves, A approves the focused line", async () => {
    const { container } = renderQueue();
    fireEvent.change(sel(container, "honors-match-filter"), { target: { value: "all" } });
    fireEvent.keyDown(window, { key: "j" });
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-row")).toBe(
      "unsure",
    );
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "u1", decision: "approve" });
  });

  it("X selects; the bulk bar approves the selection", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { container } = renderQueue();
    fireEvent.change(sel(container, "honors-match-filter"), { target: { value: "all" } });
    fireEvent.click(screen.getByLabelText("Select all shown"));
    const bar = container.querySelector('[data-slot="honors-bulk-bar"]') as HTMLElement;
    expect(bar.textContent).toContain("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Approve 2" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).id)).toEqual(["s1", "u1"]);
    await waitFor(() => expect(screen.getByText("Approved 2 honors.")).toBeTruthy());
  });

  it("flags an honor already on the profile, and lists the profile", () => {
    const published = grp("pub", [row({ id: "p1", name: "Grand Prize", tier: 1 })], null);
    const { container } = renderQueue({ approved: [published] });
    expect(container.querySelector('[data-slot="honor-flag"]')?.textContent).toContain(
      "Already on profile.",
    );
    expect(container.querySelector('[data-slot="honor-on-profile"]')?.textContent).toContain(
      "Grand Prize",
    );
  });

  it("an observer sees the tier as text and no decision controls", () => {
    renderQueue({ readOnly: true });
    expect(screen.queryByLabelText("Honor tier")).toBeNull();
    expect(screen.getByText(/Tier 1 · Pinnacle prizes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve|Reject/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
