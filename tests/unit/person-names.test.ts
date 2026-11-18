import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { nameOr, resolvePersonNames } from "@/lib/edit/person-names";
import { resetDirectoryNameCache } from "@/lib/edit/directory-names";

beforeEach(() => resetDirectoryNameCache());

describe("resolvePersonNames", () => {
  it("uses the Scholar name first, then the directory, keyed lowercase", async () => {
    const read = {
      scholar: { findMany: vi.fn(async () => [{ cwid: "sch0001", preferredName: "Pat Scholar" }]) },
    };
    const fetch = vi.fn(async () => [
      { cwid: "stf0001", name: "Staff, Sam", firstName: "Sam", lastName: "Staff", title: null, dept: null, email: null },
    ]);
    const names = await resolvePersonNames(["SCH0001", "stf0001", null, "unk0001"], {
      read,
      directory: { fetch },
    });
    expect(names.get("sch0001")).toBe("Pat Scholar");
    expect(names.get("stf0001")).toBe("Sam Staff");
    expect(names.has("unk0001")).toBe(false);
    expect(fetch).toHaveBeenCalledWith(["stf0001", "unk0001"]);
    expect(nameOr(names, "unk0001")).toBe("unk0001");
    expect(nameOr(names, "SCH0001")).toBe("Pat Scholar");
  });

  it("never throws when both sources fail", async () => {
    const read = { scholar: { findMany: vi.fn(async () => Promise.reject(new Error("db"))) } };
    const fetch = vi.fn(async () => Promise.reject(new Error("ldap")));
    const names = await resolvePersonNames(["abc0001"], { read, directory: { fetch } });
    expect(names.size).toBe(0);
  });
});
