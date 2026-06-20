/**
 * GrantRecs Phase 3 — the "Grants for me" `/edit` rail item + panel.
 *
 * Covers (1) the `SELF_EDIT_GRANT_RECS` flag, (2) the rail-gating rule in
 * `visibleAttrKeys` (self/superuser only, flag-gated — mirrors the coi-gap /
 * highlights gating), and (3) the `GrantRecsCard` render states (results with
 * distinct per-axis meters, empty, error) + the sort re-query.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { isGrantRecsEnabled } from "@/lib/edit/grant-recs";
import { visibleAttrKeys } from "@/components/edit/edit-page";
import { GrantRecsCard } from "@/components/edit/grant-recs-card";

const OPP = {
  opportunityId: "DEMO-1",
  title: "Biomedical Informatics Research",
  sponsor: "NIH NLM",
  dueDate: "2026-08-01",
  status: "open",
  axes: { topicAffinity: 0.7, stageAppeal: 0.8, meshOverlap: 0.1, deadlineProximity: 0.9 },
  defaultScore: 1.05,
};

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe("isGrantRecsEnabled — SELF_EDIT_GRANT_RECS", () => {
  const prev = process.env.SELF_EDIT_GRANT_RECS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SELF_EDIT_GRANT_RECS;
    else process.env.SELF_EDIT_GRANT_RECS = prev;
  });

  it("is on only for the literal 'on'", () => {
    process.env.SELF_EDIT_GRANT_RECS = "on";
    expect(isGrantRecsEnabled()).toBe(true);
    process.env.SELF_EDIT_GRANT_RECS = "true"; // not the magic value
    expect(isGrantRecsEnabled()).toBe(false);
    delete process.env.SELF_EDIT_GRANT_RECS;
    expect(isGrantRecsEnabled()).toBe(false);
  });
});

describe("visibleAttrKeys — grant-recs rail gating", () => {
  it("hides grant-recs when the flag is off", () => {
    expect(visibleAttrKeys("self", false, false, false, false)).not.toContain("grant-recs");
  });
  it("shows grant-recs on self + superuser when the flag is on", () => {
    expect(visibleAttrKeys("self", false, false, false, true)).toContain("grant-recs");
    expect(visibleAttrKeys("superuser", false, false, false, true)).toContain("grant-recs");
  });
  it("never shows grant-recs to a proxy / unit-admin even with the flag on", () => {
    expect(visibleAttrKeys("proxy", false, false, false, true)).not.toContain("grant-recs");
    expect(visibleAttrKeys("unit-admin", false, false, false, true)).not.toContain("grant-recs");
  });
});

describe("GrantRecsCard", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("renders ranked opportunities with the distinct per-axis meters + sort chips", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ results: [OPP] })));
    render(<GrantRecsCard cwid="thc2015" />);

    expect(await screen.findByText("Biomedical Informatics Research")).toBeTruthy();
    expect(screen.getByText("1.05")).toBeTruthy(); // default-blend fit
    // distinct axes are surfaced as labelled meters
    for (const axis of ["topic", "stage", "mesh", "deadline"]) {
      expect(screen.getByText(axis)).toBeTruthy();
    }
    // sort chips re-query
    expect(screen.getByText("Fit")).toBeTruthy();
    expect(screen.getByText("Deadline")).toBeTruthy();
    expect(screen.getByText("Stage")).toBeTruthy();
  });

  it("re-fetches with the chosen sort when a chip is clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ results: [OPP] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GrantRecsCard cwid="thc2015" />);
    await screen.findByText("Biomedical Informatics Research");

    fireEvent.click(screen.getByText("Deadline"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sort=deadline"))).toBe(true),
    );
  });

  it("renders an empty state when there are no matches (never an empty heading flash for the owner)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ results: [] })));
    render(<GrantRecsCard cwid="nobody" />);
    expect(await screen.findByText(/No matching opportunities yet/i)).toBeTruthy();
  });

  it("renders an error state when the route fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response));
    render(<GrantRecsCard cwid="thc2015" />);
    expect(await screen.findByText(/unavailable right now/i)).toBeTruthy();
  });
});
