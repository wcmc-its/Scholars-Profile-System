import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stored: null as string | null, fail: false }));
vi.mock("@/lib/etl-state", () => ({
  getPatentDataTo: vi.fn(async () => {
    if (h.fail) throw new Error("no such column");
    return h.stored;
  }),
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { describePatentCitationCriteria, loadPatentDataEnd, parsePatentCitationParams, patentDataEndLabel } from "@/lib/edit/patent-citations-report";

describe("where the patent data ends", () => {
  beforeEach(() => {
    h.stored = null;
    h.fail = false;
  });
  it("prints a stored date as the Criteria sheets do", () => {
    expect(patentDataEndLabel("2026-06-30")).toBe("30 June 2026");
    expect(patentDataEndLabel("2025-12-31")).toBe("31 December 2025");
  });
  it("follows the date the refresh stored", async () => {
    h.stored = "2026-06-30";
    expect(await loadPatentDataEnd()).toBe("30 June 2026");
  });
  it("falls back to the 2026-11-26 load's end when nothing is stored or the read fails", async () => {
    expect(await loadPatentDataEnd()).toBe("31 December 2025");
    h.fail = true;
    expect(await loadPatentDataEnd()).toBe("31 December 2025");
  });
  it("puts it in report 25's Criteria sheet", () => {
    const rows = new Map(describePatentCitationCriteria(parsePatentCitationParams(new URLSearchParams()), new Date(0), new Map(), "30 June 2026"));
    expect(rows.get("Reading the numbers")).toContain("The patent data ends at 30 June 2026.");
  });
});
