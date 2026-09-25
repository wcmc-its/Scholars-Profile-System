/**
 * `components/edit/administrators-roster.tsx` — client-side directory
 * enrichment (#728 Phase B (A)). On mount the roster batch-fetches
 * `/api/directory/people?cwids=…` and renders First Last + title + email,
 * falling back to the server name and then the bare CWID. The #443 note is
 * RECOMPUTED post-enrichment: it shows only when an unresolved person remains.
 * `global.fetch` is mocked per the `unit-access-card.test.tsx` model.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AdministratorsRoster } from "@/components/edit/administrators-roster";
import type { AdminRosterEntry } from "@/lib/api/administrators-roster";

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Mock `/api/directory/people` to return the given directory people. */
function stubDirectory(people: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, people }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Mock `/api/directory/people` returning a 503 (directory unreachable). */
function stub503() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "directory_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const dirPerson = (over: Record<string, unknown>) => ({
  cwid: "x",
  name: "x",
  title: null,
  dept: null,
  firstName: null,
  lastName: null,
  email: null,
  ...over,
});

const entry = (over: Partial<AdminRosterEntry>): AdminRosterEntry => ({
  cwid: "acd4005",
  name: "acd4005",
  title: null,
  nameResolved: false,
  grants: [
    {
      entityType: "department",
      entityId: "N1280",
      unitName: "Medicine",
      role: "curator",
      source: "ED:DA",
    },
  ],
  ...over,
});

describe("AdministratorsRoster — directory enrichment", () => {
  it("renders First Last + title + email from the directory fetch", async () => {
    stubDirectory([
      dirPerson({
        cwid: "acd4005",
        firstName: "Alicia",
        lastName: "Diggs",
        title: "Billing Compliance Manager",
        email: "acd4005@med.cornell.edu",
      }),
    ]);
    render(
      <AdministratorsRoster
        entries={[entry({})]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={true}
      />,
    );
    await waitFor(() => expect(screen.getByText("Alicia Diggs")).toBeTruthy());
    expect(screen.getByText(/Billing Compliance Manager/)).toBeTruthy();
    const mail = screen.getByTestId("administrators-email-acd4005") as HTMLAnchorElement;
    expect(mail.getAttribute("href")).toBe("mailto:acd4005@med.cornell.edu");
    // Bare CWID still shown as the muted secondary token.
    expect(screen.getByText("acd4005")).toBeTruthy();
    // No unresolved person remains ⇒ the #443 note clears after enrichment.
    await waitFor(() =>
      expect(screen.queryByTestId("administrators-name-degraded-note")).toBeNull(),
    );
  });

  it("falls back to the server Scholar name when the directory returns nothing", async () => {
    stubDirectory([]);
    render(
      <AdministratorsRoster
        entries={[entry({ cwid: "fac1", name: "Faculty One", title: "MD", nameResolved: true })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    expect(screen.getByText("Faculty One")).toBeTruthy();
    // Server resolved the name ⇒ no note, even with an empty directory.
    await waitFor(() =>
      expect(screen.queryByTestId("administrators-name-degraded-note")).toBeNull(),
    );
  });

  it("shows the bare CWID and the #443 note when neither source resolves a name", async () => {
    stubDirectory([]); // directory has no row for this staff CWID
    render(
      <AdministratorsRoster
        entries={[entry({ cwid: "staff1", name: "staff1", nameResolved: false })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={true}
      />,
    );
    // The band-row name falls back to the bare CWID.
    expect(screen.getByTestId("administrators-person-staff1")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("administrators-name-degraded-note")).toBeTruthy(),
    );
    // No email link when none resolved.
    expect(screen.queryByTestId("administrators-email-staff1")).toBeNull();
  });

  it("clears the note after enrichment when everyone resolves via the directory", async () => {
    stubDirectory([
      dirPerson({ cwid: "staff1", firstName: "Sam", lastName: "Staff" }),
    ]);
    render(
      <AdministratorsRoster
        entries={[entry({ cwid: "staff1", name: "staff1", nameResolved: false })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={true}
      />,
    );
    await waitFor(() => expect(screen.getByText("Sam Staff")).toBeTruthy());
    expect(screen.queryByTestId("administrators-name-degraded-note")).toBeNull();
  });

  it("keeps the server names + note when the directory fetch fails (503)", async () => {
    stub503();
    render(
      <AdministratorsRoster
        entries={[entry({ cwid: "staff1", name: "staff1", nameResolved: false })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={true}
      />,
    );
    // 503 ⇒ trust the server seed; the note stays.
    await waitFor(() =>
      expect(screen.getByTestId("administrators-name-degraded-note")).toBeTruthy(),
    );
  });

  it("chunks the directory fetch into batches of 50 (route MAX_CWIDS) and merges", async () => {
    // 60 unique CWIDs ⇒ 2 batches (50 + 10). The mock echoes a person per requested cwid.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      const cwids = (url.searchParams.get("cwids") ?? "").split(",").filter(Boolean);
      const people = cwids.map((c) => dirPerson({ cwid: c, firstName: "First", lastName: c.toUpperCase() }));
      return new Response(JSON.stringify({ ok: true, people }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const entries = Array.from({ length: 60 }, (_, i) => {
      const cwid = `cw${String(i).padStart(3, "0")}`;
      return entry({ cwid, name: cwid });
    });
    render(
      <AdministratorsRoster
        entries={entries}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={true}
      />,
    );
    // A person in the SECOND batch (index 55) resolves ⇒ chunking + merge worked.
    await waitFor(() => expect(screen.getByText("First CW055")).toBeTruthy());
    // Two batched requests, each ≤ 50 CWIDs.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const url = new URL(String(call[0]), "http://localhost");
      const n = (url.searchParams.get("cwids") ?? "").split(",").filter(Boolean).length;
      expect(n).toBeLessThanOrEqual(50);
    }
  });

  it("renders the empty state and never fetches when there are no entries", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <AdministratorsRoster entries={[]} isSuperuser actorCwid="zzz999" nameResolutionDegraded={false} />,
    );
    expect(screen.getByTestId("administrators-empty")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── #728 Phase C — write controls + ED-locked disabled UX (§ 4.3 / § 4.4) ────

/**
 * Route fetch by URL: `/api/directory/people` → the directory enrichment (empty
 * by default), `/api/edit/grant` → the grant write (200 ok unless overridden).
 */
function stubRouter(grant: { ok: boolean; error?: string; status?: number } = { ok: true }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/directory/people")) {
      return new Response(JSON.stringify({ ok: true, people: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/edit/grant")) {
      const { status, ...body } = grant;
      return new Response(JSON.stringify(body), {
        status: status ?? (grant.ok ? 200 : 403),
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const edRow = (over: Partial<AdminRosterEntry> = {}): AdminRosterEntry =>
  entry({
    cwid: "acd4005",
    name: "Alicia Diggs",
    nameResolved: true,
    grants: [
      {
        entityType: "department",
        entityId: "N1280",
        unitName: "Medicine",
        role: "curator",
        source: "ED:DA",
      },
    ],
    ...over,
  });

const manualRow = (over: Partial<AdminRosterEntry> = {}): AdminRosterEntry =>
  entry({
    cwid: "fac001",
    name: "Faculty One",
    nameResolved: true,
    grants: [
      {
        entityType: "department",
        entityId: "MED",
        unitName: "Medicine",
        role: "curator",
        source: "manual",
      },
    ],
    ...over,
  });

describe("AdministratorsRoster — Phase C write controls", () => {
  it("an ED row renders a read-only role pill + 'Read-only' instead of controls (non-superuser)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[edRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    // No Revoke and no role toggle — the affordance matches the route's
    // `ed_locked` gate instead of offering a control that would 403.
    expect(screen.queryByTestId("administrators-revoke-acd4005-department-N1280")).toBeNull();
    expect(
      screen.queryByTestId("administrators-role-curator-acd4005-department:N1280"),
    ).toBeNull();
    expect(
      screen.getByTestId("administrators-role-acd4005-department-N1280").textContent,
    ).toBe("Curator");
    const note = screen.getByTestId("administrators-ed-locked-note-acd4005-department-N1280");
    expect(note.textContent).toContain("Read-only");
    expect(screen.getByText("Web Directory · Department Administrator")).toBeTruthy();
  });

  it("a manual row renders Revoke + role controls ENABLED", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    const revoke = screen.getByTestId(
      "administrators-revoke-fac001-department-MED",
    ) as HTMLButtonElement;
    expect(revoke.disabled).toBe(false);
    const owner = screen.getByTestId(
      "administrators-role-owner-fac001-department:MED",
    ) as HTMLButtonElement;
    expect(owner.disabled).toBe(false);
    // No ED-locked note on a manual row.
    expect(
      screen.queryByTestId("administrators-ed-locked-note-fac001-department-MED"),
    ).toBeNull();
  });

  it("a superuser ALSO sees ED rows read-only (read-only for everyone)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[edRow()]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    // ED rows are managed in the Web Directory — read-only here for everyone,
    // superusers included (no override; it would just be re-synced).
    expect(screen.queryByTestId("administrators-revoke-acd4005-department-N1280")).toBeNull();
    expect(
      screen.queryByTestId("administrators-role-curator-acd4005-department:N1280"),
    ).toBeNull();
    expect(
      screen.getByTestId("administrators-ed-locked-note-acd4005-department-N1280"),
    ).toBeTruthy();
  });

  it("the self row (cwid === actorCwid) has Revoke disabled", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow({ cwid: "fac001" })]}
        isSuperuser={false}
        actorCwid="fac001"
        nameResolutionDegraded={false}
      />,
    );
    const revoke = screen.getByTestId(
      "administrators-revoke-fac001-department-MED",
    ) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
  });

  it("revoking a manual row POSTs action:'revoke' and optimistically drops the row", async () => {
    const fetchMock = stubRouter({ ok: true });
    render(
      <AdministratorsRoster
        entries={[manualRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-revoke-fac001-department-MED"));
    // Confirm in the dialog.
    await waitFor(() => expect(screen.getByText("Revoke this grant?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.queryByTestId("administrators-grant-fac001-department-MED")).toBeNull(),
    );
    const grantCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/edit/grant"),
    );
    expect(grantCall).toBeTruthy();
    const body = JSON.parse(String((grantCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      entityType: "department",
      entityId: "MED",
      cwid: "fac001",
      action: "revoke",
    });
  });

  it("hoists a single page-level Add administrator trigger (not a per-card form)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow(), edRow()]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    // One trigger total, regardless of how many people are on the roster…
    expect(screen.getAllByTestId("administrators-add-trigger")).toHaveLength(1);
    // …and the old per-card add form is gone.
    expect(screen.queryByTestId("administrators-add-fac001")).toBeNull();
  });
});

// ── cores-as-org-units P2 — `allCores` merges into the Add-dialog options ────

describe("AdministratorsRoster — allCores option merge (P2)", () => {
  it("offers a core with zero grants as an Add-dialog option", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
        allCores={[{ id: "2", name: "Biomedical Imaging" }]}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    const options = screen
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain("core:2");
  });

  it("keeps the roster's real unitName for a core that already has a grant, over the allCores placeholder", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[
          entry({
            cwid: "own001",
            name: "Own One",
            nameResolved: true,
            grants: [
              {
                entityType: "core",
                entityId: "2",
                unitName: "Biomedical Imaging (roster)",
                role: "owner",
                source: "manual",
              },
            ],
          }),
        ]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
        allCores={[{ id: "2", name: "Biomedical Imaging (catalog)" }]}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    const coreOption = options.find((o) => o.value === "core:2");
    expect(coreOption?.textContent).toBe("Biomedical Imaging (roster) · Core");
  });

  it("does not offer a core option when allCores is omitted (default empty)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    const options = screen
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options.some((v) => v.startsWith("core:"))).toBe(false);
  });
});

// ── #729 — per-card "View as" launch shortcut gating ─────────────────────────

// ── Sort + filter (§ SORT / § FILTER) ────────────────────────────────────────

describe("AdministratorsRoster — sort + filter", () => {
  const zoe = entry({
    cwid: "zoe1",
    name: "Zoe Zebra",
    nameResolved: true,
    grants: [
      {
        entityType: "department",
        entityId: "A1",
        unitName: "Anesthesiology",
        role: "curator",
        source: "manual",
      },
    ],
  });
  const amy = entry({
    cwid: "amy1",
    name: "Amy Apple",
    nameResolved: true,
    grants: [
      {
        entityType: "department",
        entityId: "Z1",
        unitName: "Zoology",
        role: "curator",
        source: "manual",
      },
    ],
  });

  it("defaults to sorting by person name", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[zoe, amy]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    const names = screen.getAllByTestId(/^administrators-person-/).map((el) => el.getAttribute("data-testid"));
    expect(names).toEqual(["administrators-person-amy1", "administrators-person-zoe1"]);
  });

  it("switching to 'Org unit' groups by org unit (not by person), sorted by unit name", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[zoe, amy]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-sort-orgUnit"));
    // "Anesthesiology" (zoe's unit) sorts before "Zoology" (amy's) — each
    // renders as its own group, with the header column now "Person".
    const unitGroups = screen
      .getAllByTestId(/^administrators-unit-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(unitGroups).toEqual([
      "administrators-unit-department:A1",
      "administrators-unit-department:Z1",
    ]);
    expect(screen.getByTestId("administrators-admin-department:A1-zoe1")).toBeTruthy();
    expect(screen.getByTestId("administrators-admin-department:Z1-amy1")).toBeTruthy();
  });

  it("lists a shared org unit once, with every admin nested underneath (not once per person)", () => {
    stubRouter();
    const zane = entry({
      cwid: "zan1",
      name: "Zane Zebra",
      nameResolved: true,
      grants: [
        {
          entityType: "department",
          entityId: "A1",
          unitName: "Anesthesiology",
          role: "owner",
          source: "manual",
        },
      ],
    });
    render(
      <AdministratorsRoster
        entries={[zoe, zane]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.click(screen.getByTestId("administrators-sort-orgUnit"));
    // Both zoe and zane administer "Anesthesiology" (department:A1) — the
    // unit's group header must render exactly once, with both admins as
    // separate rows underneath (the bug being fixed: it used to repeat the
    // unit's name once per person instead of grouping them).
    expect(screen.getAllByTestId("administrators-unit-department:A1")).toHaveLength(1);
    expect(screen.getByTestId("administrators-admin-department:A1-zoe1")).toBeTruthy();
    expect(screen.getByTestId("administrators-admin-department:A1-zan1")).toBeTruthy();
  });

  it("filters to person-groups matching name, cwid, or org unit (case-insensitive substring)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[zoe, amy]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.change(screen.getByTestId("administrators-filter-input"), {
      target: { value: "zoology" },
    });
    expect(screen.getByTestId("administrators-person-amy1")).toBeTruthy();
    expect(screen.queryByTestId("administrators-person-zoe1")).toBeNull();
  });

  it("shows the no-matches message (distinct from the empty-roster message) when nothing matches", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[zoe, amy]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    fireEvent.change(screen.getByTestId("administrators-filter-input"), {
      target: { value: "no such person or unit" },
    });
    expect(screen.getByTestId("administrators-no-matches")).toBeTruthy();
    expect(screen.queryByTestId("administrators-empty")).toBeNull();
    expect(screen.queryByTestId("administrators-table")).toBeNull();
  });
});

describe("AdministratorsRoster — View as (#729)", () => {
  it("renders a View-as button on other people's cards when canImpersonate", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow({ cwid: "fac001" })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
        canImpersonate
      />,
    );
    expect(screen.getByTestId("view-as-fac001")).toBeTruthy();
  });

  it("hides the View-as button on the viewer's own card", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow({ cwid: "fac001" })]}
        isSuperuser
        actorCwid="fac001"
        nameResolutionDegraded={false}
        canImpersonate
      />,
    );
    expect(screen.queryByTestId("view-as-fac001")).toBeNull();
  });

  it("hides the View-as button when canImpersonate is off (default)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[manualRow({ cwid: "fac001" })]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    expect(screen.queryByTestId("view-as-fac001")).toBeNull();
  });
});

// ── 2026-09 redesign: one table, collapsible multi-grant rows, filter rail ──

describe("AdministratorsRoster — table redesign", () => {
  const g = (
    entityType: "department" | "division" | "center",
    entityId: string,
    unitName: string,
    role: "owner" | "curator",
    source: string,
    extra: Record<string, unknown> = {},
  ) => ({ entityType, entityId, unitName, role, source, ...extra });

  // Obviously fake people.
  const multi = entry({
    cwid: "mul001",
    name: "Morgan Many",
    nameResolved: true,
    grants: [
      g("division", "V1", "Div Alpha", "curator", "ED:DivA"),
      g("division", "V2", "Div Beta", "curator", "ED:DivA"),
      g("division", "V3", "Div Gamma", "curator", "ED:DivA"),
      g("division", "V4", "Div Delta", "curator", "ED:DivA"),
    ],
  });
  const single = entry({
    cwid: "one001",
    name: "Oscar Once",
    nameResolved: true,
    grants: [
      g("department", "D1", "Dept One", "owner", "manual", {
        grantedBy: "boss1",
        grantedByName: "Boss Person",
        grantedAt: "2026-03-04T12:00:00.000Z",
      }),
    ],
  });
  const renderIt = () =>
    render(
      <AdministratorsRoster
        entries={[multi, single]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );

  it("collapses a multi-grant person to a summary that expands to one row per grant", () => {
    stubRouter();
    renderIt();
    const row = screen.getByTestId("administrators-person-mul001");
    expect(row.textContent).toContain("4 divisions");
    expect(row.textContent).toContain("Div Alpha, Div Beta, Div Gamma, +1 more");
    expect(row.textContent).toContain("Curator · 4");
    expect(row.textContent).toContain("Web Directory · Division Administrator");
    expect(screen.queryByTestId("administrators-grant-mul001-division-V1")).toBeNull();

    const toggle = screen.getByTestId("administrators-expand-mul001");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["V1", "V2", "V3", "V4"]) {
      expect(screen.getByTestId(`administrators-grant-mul001-division-${id}`)).toBeTruthy();
    }
    fireEvent.click(toggle);
    expect(screen.queryByTestId("administrators-grant-mul001-division-V1")).toBeNull();
  });

  it("Expand all / Collapse all opens every multi-grant person", () => {
    stubRouter();
    renderIt();
    const btn = screen.getByTestId("administrators-expand-all");
    expect(btn.textContent).toBe("Expand all");
    fireEvent.click(btn);
    expect(screen.getByTestId("administrators-grant-mul001-division-V4")).toBeTruthy();
    expect(btn.textContent).toBe("Collapse all");
  });

  it("a single manual grant shows the role toggle, Revoke, and who added it", () => {
    stubRouter();
    renderIt();
    const row = screen.getByTestId("administrators-grant-one001-department-D1");
    expect(row.textContent).toContain("Dept One");
    expect(row.textContent).toContain("Added by Boss Person · Mar 2026");
    expect(screen.getByTestId("administrators-role-owner-one001-department:D1")).toBeTruthy();
    expect(screen.getByTestId("administrators-revoke-one001-department-D1")).toBeTruthy();
    expect(screen.queryByTestId("administrators-expand-one001")).toBeNull();
  });

  it("shows people / grants / granted-here stats and a Showing footer", () => {
    stubRouter();
    renderIt();
    const stats = screen.getByTestId("administrators-stats").textContent ?? "";
    expect(stats).toContain("2 people");
    expect(stats).toContain("5 grants");
    expect(stats).toContain("1 granted here");
    expect(screen.getByTestId("administrators-footer").textContent).toBe(
      "Showing 2 of 2 people · 5 grants.",
    );
  });

  it("'Most grants' sorts by grant count before name", () => {
    stubRouter();
    const many = entry({ ...multi, name: "Zed Many" });
    render(
      <AdministratorsRoster
        entries={[single, many]}
        isSuperuser
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    const order = () =>
      screen.getAllByTestId(/^administrators-person-/).map((el) => el.getAttribute("data-testid"));
    expect(order()).toEqual(["administrators-person-one001", "administrators-person-mul001"]);
    fireEvent.click(screen.getByTestId("administrators-sort-grants"));
    expect(order()).toEqual(["administrators-person-mul001", "administrators-person-one001"]);
  });

  it("rail filters narrow by source and by grant count, with people counts; Clear resets", () => {
    stubRouter();
    renderIt();
    const rail = screen.getByTestId("administrators-rail");
    expect(rail.textContent).toContain("Web Directory1");
    expect(rail.textContent).toContain("Granted here1");

    fireEvent.click(screen.getByTestId("administrators-filter-src-manual"));
    expect(screen.getByTestId("administrators-person-one001")).toBeTruthy();
    expect(screen.queryByTestId("administrators-person-mul001")).toBeNull();

    // AND across groups: manual source + 2–5 grants matches nobody.
    fireEvent.click(screen.getByTestId("administrators-filter-n-2-5"));
    expect(screen.getByTestId("administrators-no-matches")).toBeTruthy();

    fireEvent.click(screen.getByTestId("administrators-filters-clear"));
    expect(screen.getByTestId("administrators-person-one001")).toBeTruthy();
    expect(screen.getByTestId("administrators-person-mul001")).toBeTruthy();
  });

  it("OR within a group: Owner + Curator keeps both people", () => {
    stubRouter();
    renderIt();
    fireEvent.click(screen.getByTestId("administrators-filter-role-owner"));
    expect(screen.queryByTestId("administrators-person-mul001")).toBeNull();
    fireEvent.click(screen.getByTestId("administrators-filter-role-curator"));
    expect(screen.getByTestId("administrators-person-mul001")).toBeTruthy();
    expect(screen.getByTestId("administrators-person-one001")).toBeTruthy();
  });
});
