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
  proxy: false,
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
      unitAdmin: { findMany: async () => [] },
      scholarProxy: { findFirst: async () => (dir.proxy ? { proxyCwid: "px1" } : null) },
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
vi.mock("@/lib/auth/global-roles", () => ({ resolveGlobalRole: async () => null }));
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

it("surfaces a proxy-only View-as target so the banner and its exit render", async () => {
  dir.impersonating = { targetCwid: "px1", startedAt: Math.floor(Date.now() / 1000) };
  dir.proxy = true;
  dir.impl = async (cwids) =>
    cwids[0] === "px1"
      ? [{ cwid: "px1", name: "Poe, Pat", firstName: "Pat", lastName: "Poe", title: null, dept: null, email: null }]
      : [];
  try {
    const body = await (await GET()).json();
    expect(body.impersonating).toMatchObject({ targetCwid: "px1", targetName: "Pat Poe", role: "proxy" });
  } finally {
    dir.impersonating = null;
    dir.proxy = false;
  }
});

it("leaves impersonating null for a target with no role at all", async () => {
  dir.impersonating = { targetCwid: "nobody", startedAt: Math.floor(Date.now() / 1000) };
  try {
    const body = await (await GET()).json();
    expect(body.impersonating).toBeNull();
  } finally {
    dir.impersonating = null;
  }
});
