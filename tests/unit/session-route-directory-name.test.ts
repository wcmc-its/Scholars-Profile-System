/**
 * A profile-less viewer (no Scholar row, no steward_directory row) gets their ED
 * name in the header instead of the bare cwid; a directory failure degrades to null.
 */
import { expect, it, vi } from "vitest";

const dir = vi.hoisted(() => ({
  calls: [] as string[][],
  impl: async (_cwids: string[]): Promise<unknown[]> => [],
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: async () => ({ cwid: "dev1", iat: 0, exp: 0 }),
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
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: async () => false }));
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
