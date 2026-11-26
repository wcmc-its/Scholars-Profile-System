/**
 * `loadBibliometricsAccess`: which of a page's people the viewer may be
 * offered the Bibliometrics report for. Off with the flag; one batched
 * decision with it on; never an error that takes the page down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const scholars = vi.fn();
  return { identity: vi.fn(), among: vi.fn(), scholars, read: { marker: "read", scholar: { findMany: scholars } } };
});

vi.mock("@/lib/db", () => ({ db: { read: h.read, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/request", () => ({ resolveEditIdentity: h.identity }));
vi.mock("@/lib/edit/overview-authz", () => ({ cvExportAllowedAmong: h.among }));

import { bibliometricsHref, loadBibliometricsAccess } from "@/lib/edit/bibliometrics-access";

const ID = { session: { cwid: "adm1001", isSuperuser: false, isCommsSteward: false }, realCwid: "adm1001", impersonatedCwid: null };

beforeEach(() => {
  h.identity.mockReset().mockResolvedValue(ID);
  h.among.mockReset().mockResolvedValue(new Set(["abc1001"]));
  h.scholars.mockReset().mockResolvedValue([{ cwid: "abc1001", roleCategory: "full_time_faculty" }]);
});
afterEach(() => vi.unstubAllEnvs());

describe("loadBibliometricsAccess", () => {
  it("flag off: no one, and nothing is looked up", async () => {
    for (const value of [undefined, "off", "true"]) {
      vi.stubEnv("EDIT_BIBLIOMETRICS", value as string);
      expect((await loadBibliometricsAccess(["abc1001", "abc1002"])).size).toBe(0);
    }
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.among).not.toHaveBeenCalled();
  });

  it("flag on: one decision for the whole page, on the request's own identity", async () => {
    vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
    const allowed = await loadBibliometricsAccess(["abc1001", "abc1002", "abc1003"]);
    expect([...allowed]).toEqual(["abc1001"]);
    expect(h.among).toHaveBeenCalledTimes(1);
    expect(h.among.mock.calls[0][0]).toEqual({
      ...ID,
      entityIds: ["abc1001", "abc1002", "abc1003"],
      db: h.read,
    });
  });

  it("flag on: a hidden identity class or a missing scholar gets no link (the editor 404s), except for a superuser", async () => {
    vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
    h.among.mockResolvedValue(new Set(["abc1001", "stu2002", "gone3003", "nul4004"]));
    h.scholars.mockResolvedValue([
      { cwid: "abc1001", roleCategory: "full_time_faculty" },
      { cwid: "stu2002", roleCategory: "doctoral_student" },
      { cwid: "nul4004", roleCategory: null },
    ]);
    expect([...(await loadBibliometricsAccess(["abc1001", "stu2002", "gone3003", "nul4004"]))].sort()).toEqual([
      "abc1001",
      "nul4004",
    ]);
    expect(h.scholars).toHaveBeenCalledTimes(1);
    expect(h.scholars.mock.calls[0][0]).toEqual({
      where: { cwid: { in: ["abc1001", "stu2002", "gone3003", "nul4004"] }, deletedAt: null },
      select: { cwid: true, roleCategory: true },
    });

    h.scholars.mockClear();
    h.identity.mockResolvedValue({ ...ID, session: { ...ID.session, isSuperuser: true } });
    expect((await loadBibliometricsAccess(["abc1001", "stu2002", "gone3003", "nul4004"])).size).toBe(4);
    expect(h.scholars).not.toHaveBeenCalled();
  });

  it("flag on: no people, no session or a failed check all mean no one", async () => {
    vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
    expect((await loadBibliometricsAccess([])).size).toBe(0);
    expect(h.identity).not.toHaveBeenCalled();

    h.identity.mockResolvedValue(null);
    expect((await loadBibliometricsAccess(["abc1001"])).size).toBe(0);
    expect(h.among).not.toHaveBeenCalled();

    h.identity.mockResolvedValue(ID);
    h.among.mockRejectedValue(new Error("directory down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await loadBibliometricsAccess(["abc1001"])).size).toBe(0);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("the link is the scholar's editor on its Bibliometrics tab", () => {
    expect(bibliometricsHref("abc1001")).toBe("/edit/scholar/abc1001?attr=bibliometrics");
  });
});
