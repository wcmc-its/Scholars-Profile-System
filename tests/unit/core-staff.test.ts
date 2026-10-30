/**
 * Curated core staff loader (lib/api/core-staff), against a fake, injectable
 * Prisma-shaped client and directory lookup (no DB, no LDAP). Fake CWIDs only.
 */
import { describe, expect, it, vi } from "vitest";

// The default ED lookup must never reach a directory from a test.
vi.mock("@/lib/sources/ldap", () => ({
  fetchDirectoryPeopleByCwid: vi.fn().mockRejectedValue(new Error("not in tests")),
}));

import { loadCoreStaff, type CoreStaffLookup } from "@/lib/api/core-staff";

const T1 = new Date("2026-10-01T00:00:00Z");
const T2 = new Date("2026-10-02T00:00:00Z");

function fakeDb(
  staffRows: Array<{ cwid: string; addedBy: string; createdAt: Date }>,
  scholarRows: Array<{
    cwid: string;
    preferredName: string;
    slug: string;
    primaryDepartment?: string | null;
  }>,
  seen: { scholarIn?: string[] } = {},
): CoreStaffLookup {
  return {
    coreStaff: {
      findMany: async ({ where, orderBy }) => {
        expect(where).toEqual({ coreId: "2" });
        expect(orderBy).toEqual({ createdAt: "asc" });
        return staffRows;
      },
    },
    scholar: {
      findMany: async ({ where }) => {
        seen.scholarIn = where.cwid.in;
        return scholarRows.map((s) => ({ primaryDepartment: null, ...s }));
      },
    },
  };
}

describe("loadCoreStaff", () => {
  it("returns [] and skips every lookup for a core with no staff", async () => {
    const directory = vi.fn();
    const out = await loadCoreStaff("2", fakeDb([], []), directory);
    expect(out).toEqual([]);
    expect(directory).not.toHaveBeenCalled();
  });

  it("names a staffer from Scholar (case-insensitively) with slug and department", async () => {
    const seen: { scholarIn?: string[] } = {};
    const directory = vi.fn().mockResolvedValue(new Map());
    const out = await loadCoreStaff(
      "2",
      fakeDb(
        [{ cwid: "abc1234", addedBy: "own0001", createdAt: T1 }],
        [
          {
            cwid: "ABC1234",
            preferredName: "Test Staffer",
            slug: "test-staffer",
            primaryDepartment: "Radiology",
          },
          { cwid: "own0001", preferredName: "Test Owner", slug: "test-owner" },
        ],
        seen,
      ),
      directory,
    );
    expect(out).toEqual([
      {
        cwid: "abc1234",
        name: "Test Staffer",
        slug: "test-staffer",
        affiliation: "Radiology",
        addedAt: T1,
        addedBy: "own0001",
        addedByName: "Test Owner",
      },
    ]);
    expect(seen.scholarIn).toEqual(expect.arrayContaining(["abc1234", "own0001"]));
    expect(directory).not.toHaveBeenCalled();
  });

  it("falls back to ONE batched ED lookup for staff and actors with no Scholar row", async () => {
    const directory = vi.fn().mockResolvedValue(
      new Map([
        ["xyz5678", "Directory Staffer"],
        ["own0002", "Directory Owner"],
      ]),
    );
    const out = await loadCoreStaff(
      "2",
      fakeDb(
        [
          { cwid: "abc1234", addedBy: "own0002", createdAt: T1 },
          { cwid: "xyz5678", addedBy: "own0002", createdAt: T2 },
        ],
        [{ cwid: "abc1234", preferredName: "Test Staffer", slug: "test-staffer" }],
      ),
      directory,
    );
    expect(directory).toHaveBeenCalledTimes(1);
    expect([...directory.mock.calls[0][0]].sort()).toEqual(["own0002", "xyz5678"]);
    expect(out.map((r) => [r.cwid, r.name, r.slug, r.addedByName])).toEqual([
      ["abc1234", "Test Staffer", "test-staffer", "Directory Owner"],
      ["xyz5678", "Directory Staffer", null, "Directory Owner"],
    ]);
  });

  it("keeps a row with a null name when neither store knows the CWID, and survives an ED throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = vi.fn().mockRejectedValue(new Error("ED down"));
    const out = await loadCoreStaff(
      "2",
      fakeDb([{ cwid: "zzz9999", addedBy: "own0003", createdAt: T1 }], []),
      directory,
    );
    expect(out).toEqual([
      {
        cwid: "zzz9999",
        name: null,
        slug: null,
        affiliation: null,
        addedAt: T1,
        addedBy: "own0003",
        addedByName: null,
      },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
