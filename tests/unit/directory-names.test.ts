/**
 * `lib/edit/directory-names.ts`: batched, cached, fail-soft ED name lookup
 * for CWIDs with no Scholar row. The LDAP call is injected (`deps.fetch`), so
 * nothing here reaches a directory. Fake CWIDs and names only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sources/ldap", () => ({
  fetchDirectoryPeopleByCwid: vi.fn().mockRejectedValue(new Error("not in tests")),
}));

import {
  DIRECTORY_FAILURE_BACKOFF_MS,
  DIRECTORY_NAME_TTL_MS,
  directoryDisplayName,
  fillDirectoryNames,
  isBareName,
  resetDirectoryNameCache,
  resolveDirectoryNames,
} from "@/lib/edit/directory-names";

function person(cwid: string, over: Record<string, unknown> = {}) {
  return {
    cwid,
    name: `Display ${cwid}`,
    title: null,
    dept: null,
    firstName: "First",
    lastName: cwid.toUpperCase(),
    email: null,
    ...over,
  };
}

beforeEach(() => {
  resetDirectoryNameCache();
  vi.restoreAllMocks();
});

describe("directoryDisplayName", () => {
  it("prefers First Last, then the display name, never the bare CWID", () => {
    expect(directoryDisplayName(person("fake001", { firstName: "Ann", lastName: "Aide" }))).toBe(
      "Ann Aide",
    );
    expect(
      directoryDisplayName(person("fake001", { firstName: null, lastName: null, name: "A. Aide" })),
    ).toBe("A. Aide");
    expect(
      directoryDisplayName(person("fake001", { firstName: null, lastName: null, name: "FAKE001" })),
    ).toBeNull();
  });
});

describe("resolveDirectoryNames", () => {
  it("looks up every uncached CWID in ONE call, lowercased and deduped, skipping junk", async () => {
    const fetch = vi.fn().mockResolvedValue([person("fake001"), person("fake002")]);
    const names = await resolveDirectoryNames(["FAKE001", "fake002", "fake001", "x", "bad id!"], {
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toEqual(["fake001", "fake002"]);
    expect(names).toEqual(
      new Map([
        ["fake001", "First FAKE001"],
        ["fake002", "First FAKE002"],
      ]),
    );
  });

  it("caches hits AND misses until the TTL, then looks up again", async () => {
    let now = 1_000_000;
    const fetch = vi.fn().mockResolvedValue([person("fake001")]);
    const deps = { fetch, now: () => now };
    await resolveDirectoryNames(["fake001", "fake009"], deps);
    const again = await resolveDirectoryNames(["fake001", "fake009"], deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again).toEqual(new Map([["fake001", "First FAKE001"]]));
    now += DIRECTORY_NAME_TTL_MS + 1;
    await resolveDirectoryNames(["fake001"], deps);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails soft on an ED error, and backs off ED for a minute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 5_000_000;
    const fetch = vi.fn().mockRejectedValue(new Error("ldap down"));
    const deps = { fetch, now: () => now };
    await expect(resolveDirectoryNames(["fake001"], deps)).resolves.toEqual(new Map());
    expect(warn).toHaveBeenCalledTimes(1);
    await resolveDirectoryNames(["fake001"], deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += DIRECTORY_FAILURE_BACKOFF_MS + 1;
    fetch.mockResolvedValue([person("fake001")]);
    await expect(resolveDirectoryNames(["fake001"], deps)).resolves.toEqual(
      new Map([["fake001", "First FAKE001"]]),
    );
  });

  it("gives up on a slow directory at the timeout (fail-soft)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(resolveDirectoryNames(["fake001"], { fetch, timeoutMs: 10 })).resolves.toEqual(
      new Map(),
    );
  });

  it("makes no call when there is nothing to look up", async () => {
    const fetch = vi.fn();
    await resolveDirectoryNames([], { fetch });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fillDirectoryNames", () => {
  it("fills only items whose name is missing or the CWID again", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue([person("fake001", { firstName: "Ann", lastName: "Aide" })]);
    const items = [
      { cwid: "fake001", name: "fake001" },
      { cwid: "fake002", name: "Kept Name" },
      { cwid: "fake003", name: "FAKE003" },
    ];
    const out = await fillDirectoryNames(
      items,
      (i) => i.name,
      (i, name) => ({ ...i, name }),
      { fetch },
    );
    expect(fetch.mock.calls[0]![0]).toEqual(["fake001", "fake003"]);
    expect(out.map((i) => i.name)).toEqual(["Ann Aide", "Kept Name", "FAKE003"]);
  });

  it("isBareName treats null and the CWID (any case) as no name", () => {
    expect(isBareName(null, "fake001")).toBe(true);
    expect(isBareName("FAKE001", "fake001")).toBe(true);
    expect(isBareName("Ann Aide", "fake001")).toBe(false);
  });
});
