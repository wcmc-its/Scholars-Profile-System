/** The program roster client component: filtering, read-only mode, add/edit/remove, programs. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProgramRoster } from "@/components/edit/program-roster";
import type { RosterEntryView, RosterProgramView } from "@/lib/edit/program-roster";

const program = (o: Partial<RosterProgramView> & { id: string }): RosterProgramView => ({
  name: `${o.id} full name`,
  shortLabel: o.id.toUpperCase(),
  description: null,
  retiredAt: null,
  ...o,
});
const entry = (id: string, name: string, year: number, o: Partial<RosterEntryView> = {}): RosterEntryView => ({
  id,
  programId: "sum",
  mentee: { cwid: `${id}001`, name },
  year,
  researchProgram: null,
  mentors: [{ cwid: "men001", name: "Jordan Vale" }],
  ...o,
});
const PROGRAMS = [program({ id: "old", retiredAt: "2025-01-02T00:00:00.000Z" }), program({ id: "sum" }), program({ id: "win" })];
const ENTRIES = [entry("bbb", "Rowan Tess", 2026), entry("aaa", "Avery Quill", 2026), entry("ccc", "Sasha Lindt", 2025)];

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
const names = () => screen.getAllByTestId(/^roster-entry-/).map((r) => r.getAttribute("data-testid"));
const show = (canEdit = true) => render(<ProgramRoster programs={PROGRAMS} entries={ENTRIES} canEdit={canEdit} exportCap={50} />);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("ProgramRoster", () => {
  it("opens on the first open program, newest year first then by name; a retired program has no tab", () => {
    show();
    expect(names()).toEqual(["roster-entry-aaa", "roster-entry-bbb", "roster-entry-ccc"]);
    expect(screen.getByRole("button", { name: /^SUM 3/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /^OLD/ })).toBeNull();
    expect(screen.getAllByText("aaa001")[0].className).toContain("font-mono");
  });

  it("filters by year, and by person or mentor name or CWID", () => {
    show();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    expect(names()).toEqual(["roster-entry-ccc"]);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "" } });
    const find = screen.getByLabelText("Find a person or mentor");
    fireEvent.change(find, { target: { value: "BBB0" } });
    expect(names()).toEqual(["roster-entry-bbb"]);
    fireEvent.change(find, { target: { value: "jordan" } });
    expect(names()).toHaveLength(3);
    fireEvent.change(find, { target: { value: "nobody" } });
    expect(screen.getByText("Nobody matches.")).toBeTruthy();
  });

  it("read-only shows no way to change anything", () => {
    show(false);
    expect(screen.queryByRole("button", { name: /Add person|^Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All programs" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByRole("button", { name: /Edit|Retire|Reopen|Delete|New program/ })).toBeNull();
    expect(dialog.getByRole("button", { name: "View OLD" })).toBeTruthy();
  });

  it("adds a person picked from the directory, with CWIDs shown, and needs a mentor first", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const add = screen.getByRole("button", { name: "Add" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fetchMock.mockResolvedValue(reply(200, { ok: true, people: [{ cwid: "new001", name: "Casey Morrow", title: null, dept: null }] }));
    fireEvent.change(screen.getByTestId("roster-person-input"), { target: { value: "casey" } });
    fireEvent.mouseDown(await screen.findByTestId("roster-person-option-new001"));
    expect(screen.getByText("new001").className).toContain("font-mono");
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fetchMock.mockResolvedValue(reply(200, { ok: true, people: [{ cwid: "men002", name: "Emery Stone", title: null, dept: null }] }));
    fireEvent.change(screen.getByTestId("roster-mentor-input"), { target: { value: "emery" } });
    fireEvent.mouseDown(await screen.findByTestId("roster-mentor-option-men002"));
    expect((add as HTMLButtonElement).disabled).toBe(false);
    fetchMock.mockResolvedValue(reply(200, { ok: true, entry: entry("new", "Casey Morrow", 2026) }));
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId("roster-entry-new")).toBeTruthy());
    expect(sent()).toMatchObject({ action: "entry_create", programId: "sum", menteeCwid: "new001", mentorCwids: ["men002"] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a refused save says why and keeps the form open", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Edit Avery Quill, 2026" }));
    fetchMock.mockResolvedValue(reply(409, { ok: false, error: "already_listed" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/already listed in this program/)).toBeTruthy();
    expect(sent()).toMatchObject({ action: "entry_update", id: "aaa", year: 2026, mentorCwids: ["men001"] });
  });

  it("removes only after a confirm", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Edit Avery Quill, 2026" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.click(form.getByRole("button", { name: "Remove" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(reply(200, { ok: true, deletedId: "aaa" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByTestId("roster-entry-aaa")).toBeNull());
    expect(sent()).toEqual({ action: "entry_delete", id: "aaa" });
  });

  it("offers Delete only for an empty program, Retire or Reopen otherwise; a retired one takes no new people", async () => {
    render(
      <ProgramRoster programs={PROGRAMS} entries={[...ENTRIES, entry("ddd", "Old One", 2019, { programId: "old" })]} canEdit exportCap={50} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage programs" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Delete WIN" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Retire SUM" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Reopen OLD" })).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "View OLD" }));
    expect(names()).toEqual(["roster-entry-ddd"]);
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
  });

  it("with no programs, creating the first one opens it", async () => {
    render(<ProgramRoster programs={[]} entries={[]} canEdit exportCap={50} />);
    expect(screen.getByText(/No programs yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage programs" }));
    fireEvent.click(screen.getByRole("button", { name: "New program" }));
    fireEvent.change(screen.getByLabelText("Short name"), { target: { value: "NEW" } });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New program" } });
    fetchMock.mockResolvedValue(reply(200, { ok: true, program: program({ id: "new" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Save program" }));
    expect(await screen.findByRole("button", { name: "Delete NEW" })).toBeTruthy();
    expect(sent()).toMatchObject({ action: "program_create", shortLabel: "NEW", name: "New program" });
  });

  it("the Mentors view counts trainees over all years and shows milestones", () => {
    const five = [1, 2, 3, 4, 5].map((i) => entry(`m${i}x`, `Trainee ${i}`, 2020 + i));
    render(<ProgramRoster programs={PROGRAMS} entries={five} canEdit exportCap={50} />);
    fireEvent.click(screen.getByRole("button", { name: "Mentors" }));
    expect(screen.queryByTestId("roster-entry-m1x")).toBeNull();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    const row = within(screen.getByTestId("roster-mentor-row-men001"));
    expect(row.getByRole("cell", { name: "5" })).toBeTruthy();
    expect(row.getAllByText("5 trainees").length).toBeGreaterThan(0);
    expect(row.getAllByText("2021 to 2025").length).toBeGreaterThan(0);
  });

  it("the download carries the program and year, never the search text, and is off above the cap with the reason", () => {
    const { unmount } = show(false);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2026" } });
    fireEvent.change(screen.getByLabelText("Find a person or mentor"), { target: { value: " avery " } });
    expect(screen.getByRole("link", { name: "Download Excel" }).getAttribute("href")).toBe(
      "/api/edit/program-roster/export?program=sum&year=2026",
    );
    unmount();
    render(<ProgramRoster programs={PROGRAMS} entries={ENTRIES} canEdit exportCap={3} />);
    expect(screen.queryByRole("link", { name: "Download Excel" })).toBeNull();
    expect(screen.getByText(/limited to 3 people, and this list has 4/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    expect(screen.getByRole("link", { name: "Download Excel" })).toBeTruthy();
  });

  it("paste: check, save the ready lines, keep the held ones to fix; an edit clears the check", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Paste a list" }));
    const box = screen.getByLabelText("List to paste") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "good line\nbad line" } });
    const row = (raw: string, held: string | null) => ({
      raw,
      person: { cwid: "new001", name: "Casey Morrow" },
      year: "2026",
      mentors: [{ cwid: "men002", name: "Emery Stone" }],
      researchProgram: "Cancer Biology",
      held,
    });
    const rows = [row("good line", null), row("bad line", "This CWID is not in the directory")];
    fetchMock.mockResolvedValue(reply(200, { ok: true, rows }));
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("1 ready, 1 held.")).toBeTruthy();
    expect(sent()).toMatchObject({ action: "paste_check", programId: "sum", text: "good line\nbad line" });

    fireEvent.change(box, { target: { value: "good line\nbad line " } });
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const save = await screen.findByRole("button", { name: "Save 1 row" });
    fetchMock.mockResolvedValue(reply(200, { ok: true, entries: [entry("new", "Casey Morrow", 2026)] }));
    fireEvent.click(save);
    expect(await screen.findByText(/Saved 1\./)).toBeTruthy();
    expect(sent()).toMatchObject({ action: "paste_save", text: "good line" });
    expect(box.value).toBe("bad line");
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getByTestId("roster-entry-new")).toBeTruthy();
  });

  it("paste closes when every line saves; read-only has no Paste", async () => {
    const { unmount } = show();
    fireEvent.click(screen.getByRole("button", { name: "Paste a list" }));
    fireEvent.change(screen.getByLabelText("List to paste"), { target: { value: "good line" } });
    const ready = { raw: "good line", person: { cwid: "new001", name: "Casey Morrow" }, year: "2026", mentors: [], researchProgram: "", held: null };
    fetchMock.mockResolvedValue(reply(200, { ok: true, rows: [ready] }));
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const save = await screen.findByRole("button", { name: "Save 1 row" });
    fetchMock.mockResolvedValue(reply(200, { ok: true, entries: [entry("new", "Casey Morrow", 2026)] }));
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("roster-entry-new")).toBeTruthy();
    unmount();
    show(false);
    expect(screen.queryByRole("button", { name: "Paste a list" })).toBeNull();
  });
});
