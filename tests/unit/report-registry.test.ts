/**
 * `lib/edit/report-registry.ts` — the registry the dynamic report page
 * dispatches on. Protects: every `REPORT_KEYS` entry has a def whose `n` is
 * its own key (a copy-pasted entry with the wrong `n` would render the wrong
 * header over the right body); `unitKindsFor` is exactly what
 * `REPORT_NUMBERS_BY_KIND` says — pinned as a literal AND re-derived from the
 * real record, so a widening there shows up here as a deliberate edit;
 * person-gated defs keyed on `MENTORED_PUBS_REPORT` / `HIGH_IMPACT_PUBS_REPORT`;
 * report 10 (Display titles) is retired — no key, no def, no grantable
 * `report_access` key (it is the Titles queue now); and the
 * drift guard — `app/edit/reports/` holds no numeric directory. The seven
 * `app/edit/reports/{1..7}/page.tsx` were deleted when the dynamic page
 * landed; a static segment beats `[report]`, so any one of them coming back
 * would silently shadow the registry for that number, redirect and all.
 *
 * `@/lib/db` is mocked: the registry imports the bodies, which import
 * loaders that construct Prisma at module scope.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { REPORT_NUMBERS_BY_KIND, type ReportableUnitKind } from "@/lib/edit/cancer-center-reports";
import {
  HIGH_IMPACT_PUBS_REPORT,
  isGrantableReportKey,
  MENTORED_PUBS_REPORT,
  REPORT_ACCESS_SCOPE_OPTIONS,
} from "@/lib/edit/report-access";
import { isReportKey, REPORT_KEYS, REPORT_META_DEFAULTS, type ReportKey } from "@/lib/edit/report-meta";
import { REPORTS, unitKindsFor } from "@/lib/edit/report-registry";

describe("REPORTS", () => {
  it("has a def for every REPORT_KEYS entry, each with its own key as `n`, and nothing else", () => {
    expect(Object.keys(REPORTS).sort()).toEqual([...REPORT_KEYS].sort());
    for (const key of REPORT_KEYS) {
      expect(REPORTS[key].n).toBe(key);
      expect(typeof REPORTS[key].render).toBe("function");
    }
  });

  it("reports 1–6 are unit-gated; 7 and 9 person-gated on their keys; 8 is admin-gated", () => {
    const person = REPORT_KEYS.filter((k) => REPORTS[k].gate === "person");
    expect(person).toEqual(["7", "9"]);
    const nine = REPORTS["9"];
    expect(nine.gate === "person" && nine.accessKey).toBe(HIGH_IMPACT_PUBS_REPORT);
    expect(REPORTS["8"].gate).toBe("admin");
    const seven = REPORTS["7"];
    expect(seven.gate === "person" && seven.accessKey).toBe(MENTORED_PUBS_REPORT);
    for (const key of ["1", "2", "3", "4", "5", "6"] as const) {
      expect(REPORTS[key].gate).toBe("unit");
    }
  });
});

describe("report 10 (Display titles) is retired to the Titles queue", () => {
  it("has no key, no def and no default metadata", () => {
    expect(REPORT_KEYS).not.toContain("10");
    expect(isReportKey("10")).toBe(false);
    expect(Object.keys(REPORTS)).not.toContain("10");
    expect(Object.keys(REPORT_META_DEFAULTS)).not.toContain("10");
    expect(Object.values(REPORT_META_DEFAULTS).map((m) => m.slug)).not.toContain("display-titles");
  });

  it("is no longer a grantable report_access key", () => {
    expect(Object.keys(REPORT_ACCESS_SCOPE_OPTIONS)).not.toContain("display-titles");
    expect(isGrantableReportKey("display-titles")).toBe(false);
    expect(isGrantableReportKey(HIGH_IMPACT_PUBS_REPORT)).toBe(true);
  });
});

describe("unitKindsFor", () => {
  it("is REPORT_NUMBERS_BY_KIND, per report — the pinned literal", () => {
    const expected: Record<ReportKey, readonly ReportableUnitKind[]> = {
      "1": ["center"],
      "2": ["center"],
      "3": ["center", "department", "division", "core"],
      "4": ["center"],
      "5": ["center"],
      "6": ["center", "department", "division", "core"],
      // Report 7 is person-gated, 8 administrator-gated; no kind lists them.
      "7": [],
      "8": [],
      "9": [],
    };
    for (const key of REPORT_KEYS) {
      expect(unitKindsFor(key)).toEqual(expected[key]);
    }
  });

  it("…and the same re-derived from the real record (a widening there must land in the literal above)", () => {
    for (const key of REPORT_KEYS) {
      const derived = (Object.keys(REPORT_NUMBERS_BY_KIND) as ReportableUnitKind[]).filter((kind) =>
        (REPORT_NUMBERS_BY_KIND[kind] as readonly number[]).includes(Number(key)),
      );
      expect(unitKindsFor(key)).toEqual(derived);
    }
    // `center` first: reports 1/2/4/5 hand the resolver exactly its own default.
    expect(unitKindsFor("1")).toEqual(["center"]);
  });
});

describe("drift guard — app/edit/reports/", () => {
  it("holds no numeric directory (the seven static pages must not come back)", () => {
    const dir = path.resolve(__dirname, "../../app/edit/reports");
    const entries = readdirSync(dir, { withFileTypes: true });
    const numeric = entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name);
    expect(numeric).toEqual([]);
    // The one dynamic segment IS there.
    expect(entries.some((e) => e.isDirectory() && e.name === "[report]")).toBe(true);
  });
});
