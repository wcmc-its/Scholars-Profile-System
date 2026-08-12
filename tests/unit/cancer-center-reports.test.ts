/**
 * `lib/edit/cancer-center-reports.ts` — `resolveReportsCenterCode`.
 *
 * Regression coverage for the 2026-08-12 bug: the org chart carries several
 * `kind: "center"` units, most unrelated to the Cancer Center report suite.
 * The default (no `?center=` param) resolution must pick a center that
 * actually has a `CenterProgram` taxonomy — not just the alphabetically-first
 * center by name, which previously landed on an unrelated center and made
 * every report 404/empty-state ("No import cycle found yet", etc.).
 */
import { describe, expect, it, vi } from "vitest";

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

import { resolveReportsCenterCode } from "@/lib/edit/cancer-center-reports";

function fakeDb(
  centers: Array<{ code: string; name: string }>,
  programCenterCodes: string[],
) {
  return {
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    center: { findMany: vi.fn().mockResolvedValue(centers) },
    centerProgram: {
      findMany: vi.fn().mockResolvedValue(programCenterCodes.map((centerCode) => ({ centerCode }))),
    },
  } as never;
}

describe("resolveReportsCenterCode", () => {
  it("skips centers with no program taxonomy and picks the one that has one, even when it sorts after other centers by name", async () => {
    const db = fakeDb(
      [
        { code: "art_center", name: "Center for the Arts" },
        { code: "meyer_cancer_center", name: "Meyer Cancer Center" },
        { code: "zzz_center", name: "Zzz Innovation Center" },
      ],
      ["meyer_cancer_center"],
    );
    const code = await resolveReportsCenterCode(db, undefined);
    expect(code).toBe("meyer_cancer_center");
  });

  it("404s when no center has a program taxonomy at all", async () => {
    const db = fakeDb(
      [
        { code: "art_center", name: "Center for the Arts" },
        { code: "zzz_center", name: "Zzz Innovation Center" },
      ],
      [],
    );
    await expect(resolveReportsCenterCode(db, undefined)).rejects.toThrow("__NOTFOUND__");
  });

  it("honors an explicit ?center= that has a program taxonomy", async () => {
    const db = fakeDb(
      [
        { code: "meyer_cancer_center", name: "Meyer Cancer Center" },
        { code: "second_cancer_center", name: "Second Cancer Center" },
      ],
      ["meyer_cancer_center", "second_cancer_center"],
    );
    const code = await resolveReportsCenterCode(db, "second_cancer_center");
    expect(code).toBe("second_cancer_center");
  });

  it("404s an explicit ?center= that resolves to a real center WITHOUT a program taxonomy — never silently falls back", async () => {
    const db = fakeDb(
      [
        { code: "art_center", name: "Center for the Arts" },
        { code: "meyer_cancer_center", name: "Meyer Cancer Center" },
      ],
      ["meyer_cancer_center"],
    );
    await expect(resolveReportsCenterCode(db, "art_center")).rejects.toThrow("__NOTFOUND__");
  });

  it("404s an explicit ?center= that doesn't match any center at all", async () => {
    const db = fakeDb([{ code: "meyer_cancer_center", name: "Meyer Cancer Center" }], [
      "meyer_cancer_center",
    ]);
    await expect(resolveReportsCenterCode(db, "not_a_real_code")).rejects.toThrow("__NOTFOUND__");
  });
});
