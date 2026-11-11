/**
 * `components/edit/edit-activity-dashboard.tsx` — the /edit/activity body
 * (2026-11 redesign): who-made-the-edits tiles, gained-content filters, the
 * stacked chart as a day filter, top editors / fields, and the grouped, paged
 * feed. All people and ids here are fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  EditActivityDashboard,
  appendOlder,
  buildRows,
  dayAxis,
  easternDayKey,
  netChanges,
  niceMax,
  sameIgnoringFormat,
  wordDiff,
} from "@/components/edit/edit-activity-dashboard";
import { type EditActivitySummary, type RecentEdit, shapeAnalytics } from "@/lib/api/edit-activity";

const edit = (over: Partial<RecentEdit>): RecentEdit => ({
  id: "r0",
  ts: "2026-09-24T18:38:00.000Z",
  actorCwid: "edt0001",
  impersonatedCwid: null,
  action: "field_override",
  entityType: "scholar",
  entityId: "sch0001",
  changes: [],
  detail: null,
  ...over,
});

const ch = (key: string, field: string, before: string | null, after: string | null) => ({
  key,
  field,
  before,
  after,
});

function summary(over: Partial<EditActivitySummary> = {}): EditActivitySummary {
  return {
    windowDays: 30,
    generatedAt: "2026-09-24T20:00:00.000Z",
    totalEdits: 12,
    editorStats: { editors: 3, automatedEditors: 1, automatedEdits: 3 },
    entityNames: { "center:ctr_one": "Center One" },
    perDay: [
      { day: "2026-09-24", edits: 8 },
      { day: "2026-09-23", edits: 4 },
    ],
    topEditors: [
      { actorCwid: "stf0001", edits: 7 },
      { actorCwid: "system-autolock", edits: 3 },
      { actorCwid: "sch0002", edits: 2 },
    ],
    topEntities: [],
    analytics: {
      kinds: { self: 2, staff: 7, automated: 3 },
      selfEditors: 1,
      topStaff: { actorCwid: "stf0001", edits: 7 },
      automatedByActor: [{ actorCwid: "system-autolock", edits: 3 }],
      perDay: [
        { day: "2026-09-24", self: 1, staff: 4, automated: 3, topActor: "stf0001" },
        { day: "2026-09-23", self: 1, staff: 3, automated: 0, topActor: "stf0001" },
      ],
      editors: {
        stf0001: { kind: "staff", profiles: 4 },
        "system-autolock": { kind: "automated", profiles: 3 },
        sch0002: { kind: "self", profiles: 1 },
      },
      fields: [{ key: "overview", label: "Overview", profiles: 2, edits: 3 }],
      gained: [
        { key: "overview", label: "Overview written", profiles: 1 },
        { key: "orcid", label: "ORCID linked", profiles: 0 },
      ],
    },
    recent: [
      // Staff writes Sam's overview for the first time.
      edit({ id: "a", actorCwid: "stf0001", changes: [ch("overview", "Overview", null, "<p>Sam studies examples.</p>")] }),
      // An automated run over two scholars.
      edit({
        id: "b",
        ts: "2026-09-24T15:06:00.000Z",
        actorCwid: "system-autolock",
        action: "reporter_profile_confirm",
        entityId: "sch0001",
      }),
      edit({
        id: "c",
        ts: "2026-09-24T15:05:00.000Z",
        actorCwid: "system-autolock",
        action: "reporter_profile_confirm",
        entityId: "sch0002",
      }),
      // A scholar's two mentee saves on their own profile.
      edit({
        id: "d",
        ts: "2026-09-23T14:10:00.000Z",
        actorCwid: "sch0002",
        entityId: "sch0002",
        changes: [ch("manualMentees", "Manual mentees", '[{"name":"Ann"}]', '[{"name":"Ann"},{"name":"Bo","year":2026}]')],
      }),
      edit({
        id: "e",
        ts: "2026-09-23T14:00:00.000Z",
        actorCwid: "sch0002",
        entityId: "sch0002",
        changes: [ch("manualMentees", "Manual mentees", null, '[{"name":"Ann"}]')],
      }),
      // View-as session.
      edit({ id: "f", ts: "2026-09-23T13:05:00.000Z", actorCwid: "stf0001", action: "impersonation_end", entityId: "sch0001" }),
      edit({ id: "g", ts: "2026-09-23T13:00:00.000Z", actorCwid: "stf0001", action: "impersonation_start", entityId: "sch0001" }),
    ],
    people: {
      stf0001: { name: "Dana Staff", title: "Program Manager" },
      sch0001: { name: "Sam Scholar", title: null },
      sch0002: { name: "Pat Prof", title: "Professor" },
    },
    nextCursor: null,
    publicationTitles: {},
    ...over,
  };
}

describe("pure helpers", () => {
  it("easternDayKey uses Eastern time, not UTC", () => {
    expect(easternDayKey("2026-09-25T01:30:00.000Z")).toBe("2026-09-24");
  });
  it("dayAxis lists N days ending on the given day, oldest first", () => {
    const axis = dayAxis("2026-09-24", 30);
    expect(axis).toHaveLength(30);
    expect(axis[0]).toBe("2026-08-26");
    expect(axis[29]).toBe("2026-09-24");
  });
  it("niceMax rounds up to a readable axis top", () => {
    expect(niceMax(392)).toBe(400);
    expect(niceMax(25)).toBe(30);
    expect(niceMax(8)).toBe(8);
    expect(niceMax(0)).toBe(1);
  });
  it("buildRows: sessions, automated runs and View-as pairs collapse when grouping", () => {
    const rows = buildRows(summary().recent, true);
    expect(rows.map((r) => r.edits.map((e) => e.id).join(""))).toEqual(["a", "bc", "de", "fg"]);
    expect(rows.map((r) => r.kind)).toEqual(["staff", "automated", "self", "audit"]);
    expect(rows.map((r) => r.mode)).toEqual(["session", "run", "session", "audit"]);
    expect(buildRows(summary().recent, false)).toHaveLength(7);
  });
  it("buildRows: one editor's identical change across profiles is one bulk row", () => {
    const title = [ch("primaryTitle", "Primary title", "Professor", "Professor of Medicine")];
    const rows = buildRows(
      ["sch0001", "sch0002", "sch0003", "sch0001"].map((entityId, i) =>
        edit({ id: `t${i}`, actorCwid: "stf0001", entityId, ts: `2026-09-24T18:0${9 - i}:00.000Z`, changes: title }),
      ),
      true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("bulk");
  });
  it("buildRows: someone else's edit in between does not split a bulk row", () => {
    const title = [ch("primaryTitle", "Primary title", "Professor", "Professor of Medicine")];
    const rows = buildRows(
      [
        edit({ id: "t1", actorCwid: "stf0001", entityId: "sch0001", ts: "2026-09-24T18:05:00.000Z", changes: title }),
        edit({ id: "x", actorCwid: "sch0009", entityId: "sch0009", ts: "2026-09-24T18:04:00.000Z", changes: [ch("overview", "Overview", "a", "b")] }),
        edit({ id: "t2", actorCwid: "stf0001", entityId: "sch0002", ts: "2026-09-24T18:03:00.000Z", changes: title }),
      ],
      true,
    );
    expect(rows.map((r) => [r.mode, r.edits.length])).toEqual([
      ["bulk", 2],
      ["session", 1],
    ]);
  });
  it("buildRows: two people editing the same field of one profile is one contested row", () => {
    const rows = buildRows(
      [
        edit({ id: "p2", actorCwid: "stf0001", entityId: "sch0002", ts: "2026-09-24T18:03:00.000Z", changes: [ch("primaryTitle", "Primary title", "B", "C")] }),
        edit({ id: "s2", actorCwid: "sch0002", entityId: "sch0002", ts: "2026-09-24T18:02:00.000Z", changes: [ch("primaryTitle", "Primary title", "A", "B")] }),
        edit({ id: "p1", actorCwid: "stf0001", entityId: "sch0002", ts: "2026-09-24T18:01:00.000Z", changes: [ch("primaryTitle", "Primary title", "B", "A")] }),
        edit({ id: "s1", actorCwid: "sch0002", entityId: "sch0002", ts: "2026-09-24T18:00:00.000Z", changes: [ch("primaryTitle", "Primary title", null, "B")] }),
      ],
      true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("contested");
  });
  it("buildRows splits one editor's saves past the session gap", () => {
    const rows = buildRows(
      [edit({ id: "x", ts: "2026-09-24T18:00:00.000Z" }), edit({ id: "y", ts: "2026-09-24T17:00:00.000Z" })],
      true,
    );
    expect(rows).toHaveLength(2);
  });
  it("netChanges folds a field to first-before → last-after", () => {
    const [c] = netChanges(summary().recent.slice(3, 5));
    expect(c).toMatchObject({ key: "manualMentees", before: null, saves: 2 });
    expect(c!.after).toContain("Bo");
  });
  it("wordDiff marks only changed words", () => {
    expect(wordDiff("a b c d", "a x c d")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "ins", text: "x" },
      { kind: "same", text: "c d" },
    ]);
  });
  it("sameIgnoringFormat treats an ORCID URL and bare iD as equal", () => {
    expect(sameIgnoringFormat("https://orcid.org/0000-0001-2345-6789", "0000-0001-2345-6789")).toBe(true);
    expect(sameIgnoringFormat("0000-0001-2345-6789", "0000-0001-2345-6780")).toBe(false);
  });
  it("shapeAnalytics: kinds, gained-from-empty, fields, ETL counts as automated", () => {
    const row = (over: Record<string, unknown>) => ({
      ts: "2026-09-24T18:00:00.000Z",
      actor_cwid: "abc1001",
      impersonated_cwid: null,
      action: "field_override",
      target_entity_type: "scholar",
      target_entity_id: "abc1001",
      fields_changed: '["overview"]',
      before_values: '{"overview":null}',
      after_values: '{"overview":"<p>x</p>"}',
      ...over,
    });
    const a = shapeAnalytics([
      row({}),
      row({ actor_cwid: "stf0001", target_entity_id: "sch0009", before_values: '{"overview":"<p>old</p>"}' }),
      row({ actor_cwid: "ETL", target_entity_id: "sch0009", fields_changed: '["orcid"]', before_values: '{"orcid":null}', after_values: '{"orcid":"0000-0001-2345-6789"}' }),
      row({ actor_cwid: "stf0001", target_entity_id: "sch0008", fields_changed: '["manualMentees"]', before_values: '{"manualMentees":"[]"}', after_values: '{"manualMentees":"[{\\"name\\":\\"A\\"}]"}' }),
    ]);
    expect(a.kinds).toEqual({ self: 1, staff: 2, automated: 1 });
    expect(a.selfEditors).toBe(1);
    expect(a.topStaff).toEqual({ actorCwid: "stf0001", edits: 2 });
    expect(Object.fromEntries(a.gained.map((g) => [g.key, g.profiles]))).toMatchObject({
      overview: 1,
      orcid: 1,
      manualMentees: 1,
    });
    expect(a.fields[0]).toMatchObject({ key: "overview", profiles: 2, edits: 2 });
    // ETL's ORCID edit is automated: not in the people-made fields panel.
    expect(a.fields.find((f) => f.key === "orcid")).toBeUndefined();
    expect(a.editors.stf0001).toEqual({ kind: "staff", profiles: 2 });
    expect(a.perDay).toHaveLength(1);
  });
});

describe("EditActivityDashboard", () => {
  it("renders who-made-the-edits tiles with resolved names", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const kpis = screen.getByTestId("edit-activity-kpis").textContent ?? "";
    expect(kpis).toContain("On 2 of 30 days");
    expect(kpis).toContain("1 scholar edited their own profile");
    expect(kpis).toContain("Largest: Dana Staff with 7 edits");
    expect(kpis).toContain("autolock 3");
  });

  it("labels the spike with its top editor's name, not a CWID", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const spike = screen.getByTestId("edit-activity-spike");
    expect(spike.textContent).toBe("Sep 24 · 8 · top editor Dana Staff");
    // The last day of the axis: pinned right, over its bar.
    expect(spike.style.right).toBe("0px");
  });

  it("tags staff rows with who they were for and shows the first-written overview", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const row = screen.getByTestId("edit-activity-row-a");
    expect(row.textContent).toContain("Dana Staff");
    expect(row.textContent).toContain("stf0001");
    expect(row.textContent).toContain("Staff, for Sam Scholar");
    expect(row.textContent).toContain("First written");
    expect(row.textContent).toContain("Sam studies examples.");
    expect(row.textContent).not.toContain("<p>");
  });

  it("combines repeated saves into one net row; unchecking shows each save", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const row = screen.getByTestId("edit-activity-row-d");
    expect(row.textContent).toContain("Own profile");
    expect(row.textContent).toContain("2 saves combined");
    expect(row.textContent).toContain("+ Ann");
    expect(row.textContent).toContain("+ Bo · 2026");
    expect(screen.queryByTestId("edit-activity-row-e")).toBeNull();
    fireEvent.click(screen.getByTestId("edit-activity-group"));
    expect(screen.getByTestId("edit-activity-row-e")).toBeTruthy();
  });

  it("collapses an automated run and names its scholars", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const row = screen.getByTestId("edit-activity-row-b");
    expect(row.textContent).toContain("2 in one run");
    expect(row.textContent).toContain("Sam Scholar, Pat Prof");
  });

  it("View-as sessions sit under Audit & operations, not All", () => {
    render(<EditActivityDashboard summary={summary()} />);
    expect(screen.queryByTestId("edit-activity-row-f")).toBeNull();
    fireEvent.click(screen.getByTestId("edit-activity-category-audit"));
    expect(screen.getByTestId("edit-activity-row-f").textContent).toContain(
      "Viewed the console as Sam Scholar (sch0001) for 5 min",
    );
  });

  it("clicking a day's bar filters the feed to that day; again clears it", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.click(screen.getByTestId("edit-activity-bar-2026-09-23"));
    expect(screen.queryByTestId("edit-activity-day-2026-09-24")).toBeNull();
    expect(screen.getByTestId("edit-activity-day-2026-09-23")).toBeTruthy();
    fireEvent.click(screen.getByTestId("edit-activity-bar-2026-09-23"));
    expect(screen.getByTestId("edit-activity-day-2026-09-24")).toBeTruthy();
  });

  it("a gained-content number filters to edits that filled that field", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.click(screen.getByTestId("edit-activity-gained-overview"));
    expect(screen.getByTestId("edit-activity-row-a")).toBeTruthy();
    expect(screen.queryByTestId("edit-activity-row-d")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear Overview written" }));
    expect(screen.getByTestId("edit-activity-row-d")).toBeTruthy();
  });

  it("top editors carry a kind tag; clicking one filters the feed", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const editors = screen.getByTestId("edit-activity-top-editors");
    expect(within(editors).getByTestId("edit-activity-editor-stf0001").textContent).toContain("Staff");
    expect(within(editors).getByTestId("edit-activity-editor-sch0002").textContent).toContain("Self");
    expect(within(editors).getByTestId("edit-activity-editor-system-autolock").textContent).toContain("Automated");
    fireEvent.click(screen.getByTestId("edit-activity-editor-sch0002"));
    expect(screen.queryByTestId("edit-activity-row-a")).toBeNull();
    expect(screen.getByTestId("edit-activity-row-d")).toBeTruthy();
  });

  it("search and Hide automated narrow the feed", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.change(screen.getByTestId("edit-activity-search"), { target: { value: "bo" } });
    expect(screen.getByTestId("edit-activity-row-d")).toBeTruthy();
    expect(screen.queryByTestId("edit-activity-row-a")).toBeNull();
    fireEvent.change(screen.getByTestId("edit-activity-search"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("edit-activity-hide-system"));
    expect(screen.queryByTestId("edit-activity-row-b")).toBeNull();
  });

  it("bulk and back-and-forth rows read as sentences", () => {
    const title = (b: string | null, a: string) => [ch("primaryTitle", "Primary title", b, a)];
    render(
      <EditActivityDashboard
        summary={summary({
          recent: [
            edit({ id: "u3", actorCwid: "stf0001", entityId: "sch0002", ts: "2026-09-24T18:03:00.000Z", changes: title("Professor", "Professor of Medicine") }),
            edit({ id: "u2", actorCwid: "stf0001", entityId: "sch0001", ts: "2026-09-24T18:02:00.000Z", changes: title("Professor", "Professor of Medicine") }),
            edit({ id: "c2", actorCwid: "stf0001", entityId: "sch0002", ts: "2026-09-24T17:03:00.000Z", changes: title("Chief", "Professor") }),
            edit({ id: "c1", actorCwid: "sch0002", entityId: "sch0002", ts: "2026-09-24T17:00:00.000Z", changes: title("Professor", "Chief") }),
          ],
        })}
      />,
    );
    const bulk = screen.getByTestId("edit-activity-row-u3").textContent;
    expect(bulk).toContain("Changed Primary title to “Professor of Medicine” on 2 profiles (2 edits)");
    expect(bulk).toContain("Managed at its source");
    const back = screen.getByTestId("edit-activity-row-c2").textContent;
    expect(back).toContain("Pat Prof and Dana Staff");
    expect(back).toContain("Back-and-forth on Pat Prof");
    expect(back).toContain("edited by Pat Prof and Dana Staff, 2 times in 3 min");
    // Each save's own change, not the row's net change.
    expect(back).toContain("Professor → Chief");
    expect(back).toContain("Chief → Professor");
  });

  it("names an ETL field_override run by its field, and highlights by title", () => {
    render(
      <EditActivityDashboard
        summary={summary({
          publicationTitles: { "123": "A <i>study</i> of examples" },
          recent: [
            edit({ id: "h", actorCwid: "sch0002", entityId: "sch0002", changes: [ch("selectedHighlightPmids", "Selected highlights", null, "[123,456]")] }),
            edit({ id: "e1", ts: "2026-09-24T15:00:00.000Z", actorCwid: "ETL", entityId: "sch0001", changes: [ch("orcid", "ORCID", null, "0000-0001-2345-6789")] }),
            edit({ id: "e2", ts: "2026-09-24T15:00:00.000Z", actorCwid: "ETL", entityId: "sch0002", changes: [ch("orcid", "ORCID", null, "0000-0001-2345-6780")] }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("edit-activity-row-e1").textContent).toContain("ORCID updated · 2 in one run");
    const h = screen.getByTestId("edit-activity-row-h").textContent;
    expect(h).toContain("A study of examples · PMID 123");
    expect(h).toContain("PMID 456");
  });

  it("the footer counts rows and edits without mixing in load state", () => {
    render(<EditActivityDashboard summary={summary()} />);
    expect(screen.getByTestId("edit-activity-feed-footer").textContent).toBe("Rows 1–3 · edits 1–5 of 12");
  });

  it("day headers pluralize", () => {
    render(<EditActivityDashboard summary={summary({ perDay: [{ day: "2026-09-24", edits: 1 }] })} />);
    expect(screen.getByTestId("edit-activity-day-2026-09-24").textContent).toContain("1 edit · 2 rows");
  });

  it("mutes a re-save with no visible change", () => {
    render(
      <EditActivityDashboard
        summary={summary({
          recent: [
            edit({
              id: "o",
              actorCwid: "sch0002",
              entityId: "sch0002",
              action: "orcid_set",
              changes: [ch("orcid", "ORCID", "https://orcid.org/0000-0001-2345-6789", "0000-0001-2345-6789")],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("edit-activity-row-o").textContent).toContain(
      "ORCID re-saved with no visible change (format only).",
    );
  });
});

describe("paging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const olderPage = (nextCursor: string | null) => ({
    ok: true,
    recent: [
      edit({
        id: "z",
        ts: "2026-09-22T16:00:00.000Z",
        actorCwid: "stf0003",
        entityId: "sch0009",
        changes: [ch("primaryTitle", "Primary title", "Old title", "New title")],
      }),
    ],
    nextCursor,
    people: { stf0003: { name: "Olga Older", title: null }, sch0009: { name: "Nia Ninth", title: null } },
    entityNames: {},
    publicationTitles: {},
  });

  const stubFetch = (...responses: Array<{ status: number; body: unknown }>) => {
    const fn = vi.fn();
    for (const r of responses) {
      fn.mockResolvedValueOnce({ ok: r.status === 200, status: r.status, json: async () => r.body });
    }
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("appendOlder keeps order and drops ids already loaded", () => {
    const merged = appendOlder(
      [edit({ id: "a" }), edit({ id: "b" })],
      [edit({ id: "b" }), edit({ id: "c" }), edit({ id: "c" })],
    );
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("Next is disabled when everything is on one page and no cursor remains", () => {
    render(<EditActivityDashboard summary={summary()} />);
    expect((screen.getByTestId("edit-activity-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Next past the loaded rows fetches the older page with the summary's window", async () => {
    const fetchMock = stubFetch({ status: 200, body: olderPage(null) });
    render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "2026-09-23T13:00:00.000Z_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-next"));
    const row = await screen.findByTestId("edit-activity-row-z");
    expect(row.textContent).toContain("Olga Older");
    expect(row.textContent).toContain("Staff, for Nia Ninth");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "/api/edit/activity/recent?cursor=2026-09-23T13%3A00%3A00.000Z_4&asOf=2026-09-24T20%3A00%3A00.000Z",
    );
  });

  it("a failed page shows an error and keeps the loaded rows", async () => {
    stubFetch({ status: 500, body: { ok: false } });
    render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "c1_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-next"));
    expect(await screen.findByTestId("edit-activity-load-older-error")).toBeTruthy();
    expect(screen.getByTestId("edit-activity-row-a")).toBeTruthy();
  });

  it("a new summary (router.refresh) drops loaded older pages", async () => {
    stubFetch({ status: 200, body: olderPage("c9_1") });
    const { rerender } = render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "c1_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-next"));
    await screen.findByTestId("edit-activity-row-z");
    rerender(
      <EditActivityDashboard
        summary={summary({ totalEdits: 41, generatedAt: "2026-09-24T21:00:00.000Z", nextCursor: "c2_9" })}
      />,
    );
    expect(screen.queryByTestId("edit-activity-row-z")).toBeNull();
    expect(screen.getByTestId("edit-activity-row-a")).toBeTruthy();
  });
});
