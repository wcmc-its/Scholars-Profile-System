/**
 * Report 11 "Email these users" (`lib/edit/core-users-contact.ts`, route
 * `POST /api/edit/reports/core-users/contacts`): the recipient filter (active
 * scholars with an address only), the `CORE_CONTACT_CAP` refusal at 201 vs
 * 200, and the gate refusing read-only roles (observer, content editor) and
 * the all-cores roll-up. `readEditRequest` runs for real, so the observer strip
 * is the production one. Fixture people and addresses are invented.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  effective: vi.fn(),
  real: vi.fn(),
  impersonating: vi.fn(),
  isSuperuser: vi.fn(),
  role: vi.fn(),
  coreFind: vi.fn(),
  scholarFind: vi.fn(),
  pmids: vi.fn(),
  load: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.effective,
  impersonationActive: h.impersonating,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.real }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: h.isSuperuser }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: h.coreFind },
      scholar: { findMany: h.scholarFind },
      unitAdmin: { findUnique: h.role },
    },
    write: {},
  },
  prisma: {},
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.audit }));
vi.mock("@/lib/edit/core-report-common", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-report-common")>()),
  loadCoreConfirmedPmids: h.pmids,
}));
vi.mock("@/lib/edit/core-users-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-users-report")>()),
  loadCoreUsersReport: h.load,
}));

import { POST } from "@/app/api/edit/reports/core-users/contacts/route";
import { CORE_CONTACT_CAP } from "@/lib/api/export-scholars";
import { withContentEditorView, withObserverView } from "@/lib/auth/observer-view";
import {
  canContactCoreUsers,
  coreContactAllowed,
  selectCoreContactRecipients,
  type ContactCandidate,
} from "@/lib/edit/core-users-contact";

const plain = { cwid: "zzz9001", isSuperuser: false, isCommsSteward: false };

function cand(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    email: "a@example.org",
    roleCategory: "full_time_faculty",
    deletedAt: null,
    status: "active",
    ...over,
  };
}

function post(query: string) {
  return new NextRequest("http://localhost/api/edit/reports/core-users/contacts", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ query }),
  });
}

/** `n` filtered people, each an active scholar with a distinct address. */
function people(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `zzz${String(i).padStart(4, "0")}`);
  h.load.mockResolvedValue({ people: ids.map((cwid) => ({ cwid })) });
  h.scholarFind.mockImplementation(async (args: { where: { cwid: { in: string[] } } }) =>
    args.where.cwid.in.map((cwid) => cand({ email: `${cwid}@example.org` })),
  );
}

beforeEach(() => {
  vi.stubEnv("SCHOLAR_LIST_EXPORT_EMAIL", "on");
  h.real.mockResolvedValue({ cwid: plain.cwid });
  h.effective.mockResolvedValue(plain);
  h.impersonating.mockReturnValue(false);
  h.isSuperuser.mockResolvedValue(false);
  h.role.mockResolvedValue({ role: "owner" });
  h.coreFind.mockResolvedValue({ id: "core-x" });
  h.pmids.mockResolvedValue(["1"]);
  h.audit.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("selectCoreContactRecipients", () => {
  it("keeps only active, non-departed scholars with an address, deduped", () => {
    expect(
      selectCoreContactRecipients([
        cand({ email: "b@example.org" }),
        cand({ email: "B@example.org" }), // same address, other case
        cand({ email: "gone@example.org", deletedAt: new Date("2026-01-01") }), // departed
        cand({ email: "hidden@example.org", status: "suppressed" }),
        cand({ email: null }),
        cand({ email: "   " }),
        cand({ email: "a@example.org" }),
      ]),
    ).toEqual(["a@example.org", "b@example.org"]);
  });

  it("drops a hidden role and honors the email kill switch", () => {
    expect(selectCoreContactRecipients([cand({ roleCategory: "doctoral_student" })])).toEqual([]);
    vi.stubEnv("SCHOLAR_LIST_EXPORT_EMAIL", "off");
    expect(selectCoreContactRecipients([cand()])).toEqual([]);
  });
});

describe("cap", () => {
  it("allows exactly CORE_CONTACT_CAP and refuses one more", () => {
    expect(CORE_CONTACT_CAP).toBe(200);
    expect(coreContactAllowed(200)).toBe(true);
    expect(coreContactAllowed(201)).toBe(false);
  });

  it("the route copies 200 and audits the count, never an address", async () => {
    people(200);
    const res = await POST(post("center=core-x&kind=core&client=yes"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(200);
    expect(body.emails).toHaveLength(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.audit).toHaveBeenCalledTimes(1);
    const row = h.audit.mock.calls[0][1];
    expect(row).toMatchObject({
      actorCwid: plain.cwid,
      action: "core_users_contact_copy",
      targetEntityType: "core",
      targetEntityId: "core-x",
      afterValues: { recipients: 200, filters: "client=yes" },
    });
    expect(JSON.stringify(row)).not.toContain("@");
  });

  it("the route refuses 201 whole (409, no addresses, no audit)", async () => {
    people(201);
    const res = await POST(post("center=core-x&kind=core"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "over_core_contact_cap" });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("gate", () => {
  it("admits the core's owner/curator, superuser and real steward", () => {
    expect(canContactCoreUsers(plain, "core-x", "owner")).toBe(true);
    expect(canContactCoreUsers(plain, "core-x", "curator")).toBe(true);
    expect(canContactCoreUsers({ ...plain, isSuperuser: true }, "core-x", "none")).toBe(true);
    expect(canContactCoreUsers({ ...plain, isCommsSteward: true }, "core-x", "none")).toBe(true);
    expect(canContactCoreUsers(plain, "core-x", "none")).toBe(false);
  });

  it("refuses observers and content editors on their synthetic steward view", () => {
    expect(canContactCoreUsers(withObserverView(plain, true), "core-x", "none")).toBe(false);
    expect(canContactCoreUsers(withContentEditorView(plain, true), "core-x", "none")).toBe(false);
  });

  it("never offers the all-cores roll-up", () => {
    expect(canContactCoreUsers({ ...plain, isSuperuser: true }, "all", "none")).toBe(false);
  });

  it("the route 403s an observer and reads no addresses", async () => {
    h.effective.mockResolvedValue(withObserverView(plain, true));
    h.role.mockResolvedValue(null);
    people(3);
    const res = await POST(post("center=core-x&kind=core"));
    expect(res.status).toBe(403);
    expect(h.scholarFind).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("the route 400s center=all", async () => {
    h.effective.mockResolvedValue({ ...plain, isSuperuser: true });
    const res = await POST(post("center=all&kind=core"));
    expect(res.status).toBe(400);
  });
});
