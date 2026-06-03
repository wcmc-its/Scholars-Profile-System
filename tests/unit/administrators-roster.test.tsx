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
    // The card title falls back to the bare CWID.
    expect(screen.getByTestId("administrators-card-staff1")).toBeTruthy();
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
  it("an ED row renders Revoke + role controls DISABLED with the caveat note (non-superuser)", () => {
    stubRouter();
    render(
      <AdministratorsRoster
        entries={[edRow()]}
        isSuperuser={false}
        actorCwid="zzz999"
        nameResolutionDegraded={false}
      />,
    );
    const revoke = screen.getByTestId(
      "administrators-revoke-acd4005-department-N1280",
    ) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
    const curator = screen.getByTestId(
      "administrators-role-curator-acd4005-department:N1280",
    ) as HTMLButtonElement;
    expect(curator.disabled).toBe(true);
    expect(
      screen.getByTestId("administrators-ed-locked-note-acd4005-department-N1280"),
    ).toBeTruthy();
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

  it("a superuser ALSO sees ED-row controls DISABLED (read-only for everyone)", () => {
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
    const revoke = screen.getByTestId(
      "administrators-revoke-acd4005-department-N1280",
    ) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
    const curator = screen.getByTestId(
      "administrators-role-curator-acd4005-department:N1280",
    ) as HTMLButtonElement;
    expect(curator.disabled).toBe(true);
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
