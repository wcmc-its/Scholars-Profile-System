/**
 * #2238 — the profile Funding role chips count funding PROJECTS, the same unit
 * the list renders one row per. Before, "All 9 / PI 7" sat over five rows and
 * no chip state ever produced the count it advertised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { GrantsSection } from "@/components/profile/grants-section";
import type { ProfilePayload } from "@/lib/api/profile";
import { coreProjectNum } from "@/lib/award-number";

type Grant = ProfilePayload["grants"][number];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function grant(awardNumber: string, role: string, endDate: string): Grant {
  return {
    title: `Project ${awardNumber}`,
    role,
    funder: "NIH",
    source: "InfoEd",
    startDate: "2015-01-01",
    endDate,
    isActive: endDate > "2026-01-01",
    awardNumber,
    programType: "Grant",
    primeSponsor: "NIH",
    primeSponsorRaw: null,
    directSponsor: null,
    directSponsorRaw: null,
    mechanism: null,
    nihIc: null,
    isSubaward: false,
    isMultiPi: false,
    coreProjectNum: coreProjectNum(awardNumber),
    applId: null,
    abstract: null,
    abstractSource: null,
    publications: [],
  };
}

// Four award years of one R01 as PI, one K award as PI, one R21 as Key Personnel.
// 6 award rows, 3 projects; PI = 2 projects, KP = 1 project.
const GRANTS: Grant[] = [
  grant("5R01 GM000001-24", "PI", "2028-06-30"),
  grant("3R01 GM000001-22S1", "PI", "2024-06-30"),
  grant("5R01 GM000001-20", "PI", "2022-06-30"),
  grant("5R01 GM000001-16", "PI", "2018-06-30"),
  grant("K23 HL000002", "PI", "2020-06-30"),
  grant("R21 AG000003", "Key Personnel", "2019-06-30"),
];

/** The rendered project rows (active list + completed list), excluding any
 *  nested list inside a row. */
function rowCount(container: HTMLElement): number {
  return container.querySelectorAll(":scope > ul > li, :scope > details > ul > li").length;
}

function chip(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.firstChild?.textContent === label,
  );
  if (!btn) throw new Error(`no chip ${label}`);
  return btn as HTMLButtonElement;
}

const chipCount = (b: HTMLButtonElement) => Number(b.querySelector("span")?.textContent);

describe("GrantsSection — chip counts are project counts (#2238)", () => {
  it("each chip's count equals the rows rendered when it is selected", () => {
    const { container } = render(<GrantsSection grants={GRANTS} />);

    expect(chipCount(chip(container, "All"))).toBe(3);
    expect(rowCount(container)).toBe(3);

    const pi = chip(container, "PI");
    expect(chipCount(pi)).toBe(2);
    fireEvent.click(pi);
    expect(rowCount(container)).toBe(2);

    const kp = chip(container, "KP");
    expect(chipCount(kp)).toBe(1);
    fireEvent.click(kp);
    expect(rowCount(container)).toBe(1);
  });
});
