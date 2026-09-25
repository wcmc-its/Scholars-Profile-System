/**
 * `components/edit/honors-queue.tsx` — the 2026-09 redesign. Pins the behaviour
 * the new layout carries: Possible is the default tab; a contested line's single
 * Approve stays disabled until a candidate is picked, then POSTs that candidate;
 * a decided card stays in place with its outcome; the read-only tabs group by
 * scholar / award / none and filter by the search box. All names are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { buildListSections, HonorsQueue, rosterSourceUrl } from "@/components/edit/honors-queue";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";

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
    prestige: 0,
    source: "SEED",
    sourceRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
    competingCwids: [],
    ...over,
  };
}

function grp(
  key: string,
  rows: HonorQueueRow[],
  rosterMatchedName: string | null = null,
): HonorQueueGroup {
  return { key, rows, rosterMatchedName, contested: new Set(rows.map((r) => r.cwid)).size > 1 };
}

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

const contested = grp(
  "roster|B. Sample|2023",
  [
    row({
      id: "c1",
      cwid: "zzz2001",
      scholarName: "Bo Sample",
      name: "Investigator",
      organization: "Invented Institute",
    }),
    row({
      id: "c2",
      cwid: "zzz2002",
      scholarName: "Bea Sample",
      name: "Investigator",
      organization: "Invented Institute",
    }),
  ],
  "B. Sample",
);
const single = grp("single", [row({ id: "s1" })], "Ada Example");

describe("HonorsQueue redesign — Possible", () => {
  it("opens on Possible with an amber count and the tab note", () => {
    const { container } = render(
      <HonorsQueue pending={[single, contested]} approved={[]} rejected={[]} userAsserted={[]} />,
    );
    const tab = screen.getByRole("tab", { name: /Possible/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(within(tab).getByText("3").className).toContain("bg-apollo-amber-tint");
    expect(container.querySelector('[data-slot="honors-tab-note"]')?.textContent).toBe(
      "3 honors awaiting a decision, including 1 where more than one person matches the same award.",
    );
    expect(screen.getByText("Listed as “B. Sample”")).toBeTruthy();
  });

  it("contested: Approve is blocked until a pick, then approves the picked candidate", async () => {
    const { container } = render(
      <HonorsQueue pending={[contested]} approved={[]} rejected={[]} userAsserted={[]} />,
    );
    const card = container.querySelector('[data-slot="honor-group-contested"]') as HTMLElement;
    const blocked = within(card).getByRole("button", {
      name: "Pick a scholar to approve",
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(within(card).getByRole("button", { name: "None of these" })).toBeTruthy();

    fireEvent.click(within(card).getByRole("radio", { name: "Bea Sample" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve for Bea Sample" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "c2", decision: "approve" });
    await waitFor(() => expect(within(card).getByText("Approved for Bea Sample")).toBeTruthy());
    // The card stays; its actions go away; the Possible count drops.
    expect(within(card).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(screen.getByRole("tab", { name: /Possible/ })).getByText("0")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("single: Reject posts a reject and marks the card Rejected", async () => {
    const { container } = render(
      <HonorsQueue pending={[single]} approved={[]} rejected={[]} userAsserted={[]} />,
    );
    const card = container.querySelector('[data-slot="honor-group"]') as HTMLElement;
    expect(within(card).getByRole("button", { name: "Approve for Ada Example" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(within(card).getByText("Rejected")).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "s1", decision: "reject" });
  });
});

describe("HonorsQueue redesign — read-only tabs", () => {
  const known = [
    grp("k1", [
      row({
        id: "k1",
        cwid: "zzz3001",
        scholarName: "Cy Zed",
        name: "Fellow",
        organization: "Made-up Society",
      }),
    ]),
    grp("k2", [
      row({
        id: "k2",
        cwid: "zzz3002",
        scholarName: "Di Alpha, MD",
        name: "Member",
        organization: "Invented Academy",
      }),
    ]),
    grp("k3", [
      row({
        id: "k3",
        cwid: "zzz3002",
        scholarName: "Di Alpha, MD",
        name: "Fellow",
        organization: "Made-up Society",
      }),
    ]),
  ];

  it("Known groups by scholar by default, A–Z by surname, and search narrows it", () => {
    const { container } = render(
      <HonorsQueue pending={[]} approved={known} rejected={[]} userAsserted={[]} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    const headings = [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Di Alpha, MD", "Cy Zed"]);
    expect(container.querySelector('[data-slot="honors-list-footer"]')?.textContent).toBe(
      "Showing 3 of 3 honors.",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search honors" }), {
      target: { value: "invented" },
    });
    expect(
      [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map((h) => h.textContent),
    ).toEqual(["Di Alpha, MD"]);
  });

  it("Award grouping puts the biggest honor first", () => {
    const { container } = render(
      <HonorsQueue pending={[]} approved={known} rejected={[]} userAsserted={[]} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    fireEvent.click(screen.getByRole("button", { name: "Award" }));
    const headings = [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Fellow", "Member"]);
  });
});

describe("buildListSections", () => {
  const rows = [
    row({ id: "a", cwid: "zzz1", scholarName: "Eve Young", decidedAt: "2026-01-01T00:00:00.000Z" }),
    row({ id: "b", cwid: "zzz2", scholarName: "Al Brown", decidedAt: "2026-03-01T00:00:00.000Z" }),
    row({
      id: "c",
      cwid: "zzz1",
      scholarName: "Eve Young",
      name: "Fellow",
      decidedAt: "2026-02-01T00:00:00.000Z",
    }),
  ];
  it("none → one unheaded section, newest decision first", () => {
    const secs = buildListSections(rows, "none");
    expect(secs).toHaveLength(1);
    expect(secs[0].label).toBeNull();
    expect(secs[0].rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("scholar → one section per cwid, with an honor count", () => {
    const secs = buildListSections(rows, "scholar");
    expect(secs.map((s) => [s.label, s.sub])).toEqual([
      ["Al Brown", "1 honor"],
      ["Eve Young", "2 honors"],
    ]);
  });
  it("award → keyed on honor + organization", () => {
    const secs = buildListSections(rows, "award");
    expect(secs.map((s) => s.sub)).toEqual([
      "Invented Academy · 2 scholars",
      "Invented Academy · 1 scholar",
    ]);
  });
});

describe("rosterSourceUrl", () => {
  it("links only an http(s) roster segment", () => {
    expect(rosterSourceUrl("https://example.org/roster|A. Person|2020")).toBe(
      "https://example.org/roster",
    );
    expect(rosterSourceUrl("asci|A. Person|2020")).toBeNull();
    expect(rosterSourceUrl(null)).toBeNull();
  });
});
