/**
 * A profile-less viewer (no Scholar row, no steward_directory row) gets their ED
 * name in the header instead of the bare cwid; a directory failure degrades to null.
 */
import { expect, it, vi } from "vitest";

const dir = vi.hoisted(() => ({
  calls: [] as string[][],
  impl: async (_cwids: string[]): Promise<unknown[]> => [],
  impersonating: null as null | { targetCwid: string; startedAt: number },
  steward: false,
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: async () => ({ cwid: "dev1", iat: 0, exp: 0, impersonating: dir.impersonating }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  impersonationActive: (s: { impersonating?: unknown }) => !!s.impersonating,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: async () => null },
      stewardDirectory: { findUnique: async () => null },
    },
  },
}));
vi.mock("@/lib/sources/ldap", () => ({
  fetchDirectoryPeopleByCwid: (cwids: string[]) => {
    dir.calls.push(cwids);
    return dir.impl(cwids);
  },
}));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: async () => false }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: async () => true }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: async () => false }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: async () => false }));
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: async () => dir.steward }));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: async () => ({ total: 0 }) }));

import { GET } from "@/app/api/auth/session/route";

it("uses the ED first + last name", async () => {
  dir.impl = async () => [
    { cwid: "dev1", name: "Doe, Jane", firstName: "Jane", lastName: "Doe", title: null, dept: null, email: null },
  ];
  const body = await (await GET()).json();
  expect(body.displayName).toBe("Jane Doe");
  expect(dir.calls.at(-1)).toEqual(["dev1"]);
});

it("degrades to null (cwid shown) when the directory is unreachable", async () => {
  dir.impl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const body = await (await GET()).json();
  expect(body.displayName).toBeNull();
});

it("names a profile-less comms_steward View-as target from ED, not the bare cwid", async () => {
  dir.impersonating = { targetCwid: "stw1", startedAt: Math.floor(Date.now() / 1000) };
  dir.steward = true;
  dir.impl = async (cwids) =>
    cwids[0] === "stw1"
      ? [{ cwid: "stw1", name: "Roe, Sam", firstName: "Sam", lastName: "Roe", title: null, dept: null, email: null }]
      : [];
  try {
    const body = await (await GET()).json();
    expect(body.impersonating?.targetName).toBe("Sam Roe");
  } finally {
    dir.impersonating = null;
    dir.steward = false;
  }
});
