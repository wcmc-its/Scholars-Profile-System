import { describe, expect, it } from "vitest";

import {
  csvCell,
  daysOpen,
  isActionable,
  missingField,
  nextGapStatus,
  toCsv,
  type GapReportRow,
} from "@/lib/grant-date-gap";

describe("missingField", () => {
  const d = new Date("2024-01-01");
  it("names which side is absent", () => {
    expect(missingField(null, null)).toBe("both");
    expect(missingField(null, d)).toBe("start");
    expect(missingField(d, null)).toBe("end");
  });

  it("returns null when the period is complete", () => {
    expect(missingField(d, d)).toBeNull();
  });
});

describe("nextGapStatus", () => {
  it("resolves once InfoEd supplies a period", () => {
    expect(
      nextGapStatus("open", { stillUndated: false, backfilled: false }),
    ).toBe("resolved");
    expect(
      nextGapStatus("backfilled", { stillUndated: false, backfilled: true }),
    ).toBe("resolved");
  });

  it("keeps a backfilled award OPEN for the source fix", () => {
    // The governing rule. If a RePORTER backfill closed the gap, InfoEd would
    // stay wrong permanently and the non-NIH awards RePORTER cannot reach would
    // never be fixed by anyone.
    const status = nextGapStatus("open", {
      stillUndated: true,
      backfilled: true,
    });
    expect(status).toBe("backfilled");
    expect(isActionable(status)).toBe(true);
  });

  it("never re-nags a dismissed award", () => {
    // Dismissal is the human judgement that this award legitimately has no
    // period. Re-surfacing it is what makes a recipient stop reading the list.
    for (const input of [
      { stillUndated: true, backfilled: false },
      { stillUndated: true, backfilled: true },
      { stillUndated: false, backfilled: false },
    ]) {
      expect(nextGapStatus("dismissed", input)).toBe("dismissed");
    }
  });

  it("reopens a resolved award if the source loses the dates again", () => {
    expect(
      nextGapStatus("resolved", { stillUndated: true, backfilled: false }),
    ).toBe("open");
  });

  it("opens on first sight", () => {
    expect(nextGapStatus(null, { stillUndated: true, backfilled: false })).toBe(
      "open",
    );
  });
});

describe("isActionable", () => {
  it("counts backfilled as still needing OSRA, resolved/dismissed as not", () => {
    expect(isActionable("open")).toBe(true);
    expect(isActionable("backfilled")).toBe(true);
    expect(isActionable("resolved")).toBe(false);
    expect(isActionable("dismissed")).toBe(false);
  });
});

describe("csvCell", () => {
  it("quotes separators, quotes and newlines", () => {
    expect(csvCell("R01 CA123456")).toBe("R01 CA123456");
    expect(csvCell("Medicine, Division of")).toBe('"Medicine, Division of"');
    expect(csvCell('The "Big" Foundation')).toBe('"The ""Big"" Foundation"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("renders null and undefined as empty, not the literal string", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("daysOpen", () => {
  it("floors to whole days and never goes negative", () => {
    const first = new Date("2026-01-01T00:00:00Z");
    expect(daysOpen(first, new Date("2026-01-31T12:00:00Z"))).toBe(30);
    expect(daysOpen(first, new Date("2025-12-01T00:00:00Z"))).toBe(0);
  });
});

describe("toCsv", () => {
  const row = (over: Partial<GapReportRow>): GapReportRow => ({
    cwid: "abc1234",
    scholarName: "Test Scholar",
    accountNumber: "0000000001",
    awardNumber: "R01 CA123456",
    title: "A study of things",
    sponsor: "NCI",
    projectStatus: "Expired Award",
    programType: "Grant",
    unitName: "Medicine",
    missingField: "both",
    status: "open",
    backfillSource: null,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    daysOpen: 10,
    ...over,
  });

  it("sorts active awards first, then longest-open", () => {
    const csv = toCsv([
      row({ accountNumber: "expired", projectStatus: "Expired Award", daysOpen: 900 }),
      row({ accountNumber: "active-new", projectStatus: "Active Award", daysOpen: 1 }),
      row({ accountNumber: "active-old", projectStatus: "Active Award", daysOpen: 400 }),
      row({ accountNumber: "inproc", projectStatus: "In Process", daysOpen: 50 }),
    ]);
    const accounts = csv
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[2]);
    // An undated ACTIVE award is what a faculty member notices, so it leads
    // regardless of age.
    expect(accounts).toEqual(["active-old", "active-new", "inproc", "expired"]);
  });

  it("emits a header even with no rows", () => {
    expect(toCsv([])).toBe(
      "cwid,scholar_name,account_number,award_number,title,sponsor,project_status," +
        "program_type,unit_name,missing_field,gap_status,backfill_source,first_seen,days_open",
    );
  });

  it("quotes a title containing a comma so the row stays aligned", () => {
    // Grant titles are the most comma-dense field in the file, and 74% of these
    // awards have no award number — a row that shifts by one column is a row
    // nobody can act on.
    const csv = toCsv([row({ title: "Aging, synapses, and disease" })]);
    expect(csv).toContain('"Aging, synapses, and disease"');
    expect(csv.split("\n")).toHaveLength(2);
    // Parsed CSV-aware, the row still has exactly the header's field count.
    const fields = csv.split("\n")[1].match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
    expect(fields.filter((f) => f.endsWith(",")).length + 1).toBe(
      csv.split("\n")[0].split(",").length,
    );
  });

  it("keeps a comma-bearing unit on one field", () => {
    const csv = toCsv([row({ unitName: "Medicine, Division of Cardiology" })]);
    expect(csv).toContain('"Medicine, Division of Cardiology"');
    expect(csv.split("\n")).toHaveLength(2);
  });
});
