/**
 * `/api/edit/program-roster`: who may write, what is refused, and that a name
 * is always the directory's. Trainee records, so every denied caller must be
 * turned away before the database or the directory is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  real: vi.fn(),
  viewingAs: vi.fn(() => false),
  isSuperuser: vi.fn(async () => true),
  directory: vi.fn(),
  transaction: vi.fn(),
  findEntryOuter: vi.fn(),
  listed: vi.fn(),
  tx: {
    rosterProgram: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    rosterEntry: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: h.session, isSuperuser: h.isSuperuser }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: h.viewingAs,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.real }));
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: h.directory }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {},
    write: {
      $transaction: h.transaction,
      rosterEntry: { findUnique: h.findEntryOuter, findMany: h.listed },
      rosterProgram: h.tx.rosterProgram,
    },
  },
}));

import { POST } from "@/app/api/edit/program-roster/route";

const EDITOR = { cwid: "edi001", isSuperuser: false, isCommsSteward: false, isProgramRosterEditor: true };
const PROGRAM = { id: "p1", name: "Summer program", shortLabel: "SUM", description: null, retiredAt: null };
const ENTRY = {
  id: "e1",
  programId: "p1",
  menteeCwid: "tra001",
  menteeName: "Avery Quill",
  year: 2025,
  researchProgram: null,
  mentors: [{ mentorCwid: "men001", mentorName: "Jordan Vale" }],
};
const YEAR = new Date().getUTCFullYear();
const CREATE = { action: "entry_create", programId: "p1", menteeCwid: "TRA001", year: YEAR, mentorCwids: ["men001", "MEN001"] };

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/edit/program-roster", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    }),
  );
const result = async (body: unknown) => {
  const res = await post(body);
  return [res.status, ((await res.json()) as { error?: string }).error ?? null];
};
/** The bound values of the one audit insert. */
const audit = () => {
  expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
  return JSON.stringify(h.tx.$executeRaw.mock.calls[0].slice(1));
};
const person = (cwid: string, firstName: string, lastName: string) => ({ cwid, name: "", firstName, lastName });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("EDIT_PROGRAM_ROSTER", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.viewingAs.mockReturnValue(false);
  h.session.mockResolvedValue(EDITOR);
  h.real.mockResolvedValue({ cwid: "edi001", iat: 0, exp: 0 });
  h.transaction.mockImplementation(async (cb: (tx: typeof h.tx) => unknown) => cb(h.tx));
  h.directory.mockImplementation(async (cwids: string[]) =>
    [person("tra001", "Avery", "Quill"), person("men001", "Jordan", "Vale"), person("men002", "Emery", "Stone")].filter(
      (p) => cwids.includes(p.cwid),
    ),
  );
  h.tx.rosterProgram.findUnique.mockResolvedValue(PROGRAM);
  h.tx.rosterProgram.create.mockImplementation(async ({ data }) => ({ ...PROGRAM, ...data }));
  h.tx.rosterProgram.update.mockImplementation(async ({ data }) => ({ ...PROGRAM, ...data }));
  h.tx.rosterEntry.count.mockResolvedValue(0);
  h.tx.rosterEntry.findUnique.mockResolvedValue(ENTRY);
  h.findEntryOuter.mockResolvedValue(ENTRY);
  h.listed.mockResolvedValue([]);
  h.tx.rosterEntry.create.mockImplementation(async ({ data }) => ({ ...ENTRY, ...data, mentors: data.mentors.create }));
  h.tx.rosterEntry.update.mockImplementation(async ({ data }) => ({ ...ENTRY, ...data, mentors: data.mentors.create }));
  h.tx.$executeRaw.mockResolvedValue(1);
});

describe("gate", () => {
  const none = { cwid: "x00001", isSuperuser: false, isCommsSteward: false };
  it.each<[string, Record<string, unknown>]>([
    ["no role", none],
    ["comms_steward", { ...none, isCommsSteward: true }],
    ["observer", { ...none, isCommsSteward: true, isObserver: true }],
    ["content editor", { ...none, isCommsSteward: true, isContentEditor: true }],
    ["research_security_viewer", { ...none, isResearchSecurityViewer: true }],
  ])("%s gets 404 and nothing is touched", async (_n, s) => {
    h.session.mockResolvedValue(s);
    for (const body of [CREATE, { action: "paste_check", programId: "p1", text: "x" }, { action: "entry_delete", id: "e1" }, { action: "program_create", name: "A", shortLabel: "B" }]) {
      expect(await result(body)).toEqual([404, "not_found"]);
    }
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.directory).not.toHaveBeenCalled();
    expect(h.findEntryOuter).not.toHaveBeenCalled();
  });

  it("signed out is 401; the flag off is 404 even for a superuser", async () => {
    h.session.mockResolvedValue(null);
    expect((await post(CREATE)).status).toBe(401);
    h.session.mockResolvedValue({ ...EDITOR, isSuperuser: true });
    vi.stubEnv("EDIT_PROGRAM_ROSTER", "off");
    expect(await result(CREATE)).toEqual([404, "not_found"]);
  });

  it("a superuser viewing as an editor cannot write", async () => {
    h.viewingAs.mockReturnValue(true);
    h.real.mockResolvedValue({ cwid: "sup001", iat: 0, exp: 0, impersonating: { targetCwid: "edi001", startedAt: 0 } });
    expect((await post(CREATE)).status).toBeGreaterThanOrEqual(403);
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("entries", () => {
  it("saves the directory's names, lowercases and dedupes CWIDs, audits CWIDs and no names", async () => {
    const res = await post({ ...CREATE, menteeName: "Typed By Hand", researchProgram: "  Cancer   Biology " });
    expect(res.status).toBe(200);
    expect(h.tx.rosterEntry.create.mock.calls[0][0].data).toMatchObject({
      menteeCwid: "tra001",
      menteeName: "Avery Quill",
      researchProgram: "Cancer Biology",
      createdBy: "edi001",
      mentors: { create: [{ mentorCwid: "men001", mentorName: "Jordan Vale" }] },
    });
    const a = audit();
    expect(a).toContain("roster_entry_change");
    expect(a).toContain("men001");
    expect(a).not.toMatch(/Avery|Quill|Jordan|Vale/);
  });

  it.each<[string, Record<string, unknown>, [number, string]]>([
    ["a person not in the directory", { menteeCwid: "ghost1" }, [400, "not_in_directory"]],
    ["a mentor not in the directory", { mentorCwids: ["men001", "ghost1"] }, [400, "not_in_directory"]],
    ["no mentor", { mentorCwids: [] }, [400, "mentor_required"]],
    ["their own mentor", { mentorCwids: ["tra001"] }, [400, "mentor_is_mentee"]],
    ["a malformed CWID", { mentorCwids: ["1bad"] }, [400, "invalid_cwid"]],
    ["too many mentors", { mentorCwids: Array.from({ length: 11 }, (_, i) => `mentor${i}`) }, [400, "too_many_mentors"]],
    ["a typo year", { year: YEAR + 2 }, [400, "invalid_year"]],
    ["a text year", { year: "2025" }, [400, "invalid_year"]],
  ])("refuses %s and saves nothing", async (_n, over, want) => {
    expect(await result({ ...CREATE, ...over })).toEqual(want);
    expect(h.tx.rosterEntry.create).not.toHaveBeenCalled();
  });

  it("saves nothing when the directory cannot be reached", async () => {
    h.directory.mockRejectedValue(new Error("ldap down"));
    expect(await result(CREATE)).toEqual([500, "write_failed"]);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses a retired or missing program, and a duplicate", async () => {
    h.tx.rosterProgram.findUnique.mockResolvedValueOnce({ ...PROGRAM, retiredAt: new Date() });
    expect(await result(CREATE)).toEqual([409, "program_retired"]);
    h.tx.rosterProgram.findUnique.mockResolvedValueOnce(null);
    expect(await result(CREATE)).toEqual([404, "program_not_found"]);
    h.tx.rosterEntry.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await result(CREATE)).toEqual([409, "already_listed"]);
    h.tx.rosterEntry.create.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await result(CREATE)).toEqual([409, "program_not_found"]);
  });

  it("update keeps a departed mentor's stored name and looks up only new ones; the person cannot change", async () => {
    h.directory.mockImplementation(async () => [person("men002", "Emery", "Stone")]);
    const res = await post({
      action: "entry_update",
      id: "e1",
      menteeCwid: "other1",
      year: 2024,
      mentorCwids: ["men001", "men002"],
    });
    expect(res.status).toBe(200);
    expect(h.directory).toHaveBeenCalledWith(["men002"]);
    const data = h.tx.rosterEntry.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("menteeCwid");
    expect(data.mentors).toEqual({
      deleteMany: {},
      create: [
        { mentorCwid: "men001", mentorName: "Jordan Vale" },
        { mentorCwid: "men002", mentorName: "Emery Stone" },
      ],
    });
    expect(audit()).toContain("2025"); // the before values
  });

  it("an update that adds nobody never asks the directory", async () => {
    expect((await post({ action: "entry_update", id: "e1", year: 2024, mentorCwids: ["men001"] })).status).toBe(200);
    expect(h.directory).not.toHaveBeenCalled();
  });

  it("delete audits what was removed; a missing entry is 404", async () => {
    expect((await post({ action: "entry_delete", id: "e1" })).status).toBe(200);
    expect(audit()).toContain("tra001");
    h.tx.rosterEntry.findUnique.mockResolvedValue(null);
    expect(await result({ action: "entry_delete", id: "e1" })).toEqual([404, "entry_not_found"]);
  });
});

describe("names", () => {
  it("stores the name the people search shows, middle initial included", async () => {
    h.directory.mockResolvedValue([
      { ...person("tra001", "Avery", "Quill"), name: "Avery J. Quill" },
      { ...person("men001", "Jordan", "Vale"), name: "men001" }, // the directory's stand-in for no name
    ]);
    expect((await post(CREATE)).status).toBe(200);
    expect(h.tx.rosterEntry.create.mock.calls[0][0].data).toMatchObject({
      menteeName: "Avery J. Quill",
      mentors: { create: [{ mentorCwid: "men001", mentorName: "Jordan Vale" }] },
    });
  });
});

describe("paste", () => {
  const GOOD = `Avery Quill\ttra001\t${YEAR}\tmen001; MEN002\tCancer Biology`;
  const WRONG = `Casey Morrow\tmen002\t${YEAR}\tmen001`;
  const paste = (action: string, text: unknown) => ({ action, programId: "p1", text });

  it("check reports each line and saves nothing", async () => {
    const res = await post(paste("paste_check", `Name\tCWID\tYear\n${GOOD}\n${WRONG}`));
    const { rows } = (await res.json()) as { rows: Array<{ person: unknown; held: string | null }> };
    expect(rows.map((r) => r.held)).toEqual([null, "The directory has Emery Stone for this CWID"]);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("save writes every line in one transaction, each with its audit row and no names", async () => {
    const second = `Emery Stone\tmen002\t${YEAR}\tmen001`;
    const res = await post(paste("paste_save", `${GOOD}\n${second}`));
    expect(res.status).toBe(200);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.rosterEntry.create.mock.calls.map((c) => c[0].data.menteeName)).toEqual(["Avery Quill", "Emery Stone"]);
    expect(h.tx.rosterEntry.create.mock.calls[0][0].data.mentors.create).toHaveLength(2);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.tx.$executeRaw.mock.calls)).not.toMatch(/Avery|Quill|Emery|Stone/);
  });

  it("one held line and nothing is saved", async () => {
    expect(await result(paste("paste_save", `${GOOD}\n${WRONG}`))).toEqual([409, "paste_changed"]);
    h.listed.mockResolvedValue([{ menteeCwid: "TRA001", year: YEAR }]);
    expect(await result(paste("paste_save", GOOD))).toEqual([409, "paste_changed"]);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses an empty or too long list, a retired program, and a directory that is down", async () => {
    expect(await result(paste("paste_check", "  \n"))).toEqual([400, "empty_paste"]);
    expect(await result(paste("paste_check", 7))).toEqual([400, "empty_paste"]);
    expect(await result(paste("paste_check", Array(101).fill(GOOD).join("\n")))).toEqual([400, "too_many_rows"]);
    h.directory.mockRejectedValueOnce(new Error("ldap down"));
    expect(await result(paste("paste_save", GOOD))).toEqual([500, "write_failed"]);
    h.tx.rosterProgram.findUnique.mockResolvedValue({ ...PROGRAM, retiredAt: new Date() });
    expect(await result(paste("paste_save", GOOD))).toEqual([409, "program_retired"]);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("retired between the check and the write, or listed by someone else, rolls back", async () => {
    h.tx.rosterProgram.findUnique.mockResolvedValueOnce(PROGRAM).mockResolvedValueOnce({ ...PROGRAM, retiredAt: new Date() });
    expect(await result(paste("paste_save", GOOD))).toEqual([409, "program_retired"]);
    expect(h.tx.rosterEntry.create).not.toHaveBeenCalled();
    h.tx.rosterEntry.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await result(paste("paste_save", GOOD))).toEqual([409, "already_listed"]);
  });
});

describe("programs", () => {
  it("creates, retires and reopens, each audited", async () => {
    expect((await post({ action: "program_create", name: " Summer  program ", shortLabel: "SUM" })).status).toBe(200);
    expect(h.tx.rosterProgram.create.mock.calls[0][0].data).toMatchObject({ name: "Summer program", createdBy: "edi001" });
    await post({ action: "program_retire", id: "p1" });
    expect(h.tx.rosterProgram.update.mock.calls[0][0].data.retiredAt).toBeInstanceOf(Date);
    await post({ action: "program_reopen", id: "p1" });
    expect(h.tx.rosterProgram.update.mock.calls[1][0].data.retiredAt).toBeNull();
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it("deletes only an empty program, whether the count or the foreign key says so", async () => {
    h.tx.rosterEntry.count.mockResolvedValueOnce(3);
    expect(await result({ action: "program_delete", id: "p1" })).toEqual([409, "program_not_empty"]);
    expect(h.tx.rosterProgram.delete).not.toHaveBeenCalled();
    h.tx.rosterProgram.delete.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await result({ action: "program_delete", id: "p1" })).toEqual([409, "program_not_empty"]);
    expect(await result({ action: "program_delete", id: "p1" })).toEqual([200, null]);
  });

  it("refuses a blank name, a taken short name, an unknown program and an unknown action", async () => {
    expect(await result({ action: "program_create", name: " ", shortLabel: "S" })).toEqual([400, "invalid_name"]);
    h.tx.rosterProgram.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await result({ action: "program_create", name: "A", shortLabel: "SUM" })).toEqual([409, "label_taken"]);
    h.tx.rosterProgram.findUnique.mockResolvedValueOnce(null);
    expect(await result({ action: "program_update", id: "nope", name: "A", shortLabel: "B" })).toEqual([404, "program_not_found"]);
    expect(await result({ action: "wipe" })).toEqual([400, "invalid_action"]);
  });
});
