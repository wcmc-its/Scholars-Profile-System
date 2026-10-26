/**
 * The ORCID librarian queue's decide route (`/api/edit/orcid-queue/decide`),
 * against the real `orcid-queue.server` writers over a fake Prisma client.
 *
 * Load-bearing: the flag 404s first; a non-superuser and any View-as session
 * are 403 with nothing written; a confirm is method `librarian` by the REAL
 * actor; a dismiss on an email auto-confirmed iD is the Undo; v3 "None of
 * these" dismisses every listed iD in one transaction and says so in the audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORCID = "0000-0002-1825-0097";
const OTHER = "0000-0000-0000-001X";

type Pair = { cwid: string; orcid: string };

const h = vi.hoisted(() => {
  const state = {
    evidence: [] as Array<{ cwid: string; orcid: string; band: string; computedAt?: Date }>,
    /** `orcid_candidate` rows with source `rpm_admin`. */
    admins: [] as Array<{ cwid: string; orcid: string }>,
    /** Other `orcid_candidate` rows (any source). */
    sources: [] as Array<{ cwid: string; orcid: string; source: string }>,
    /** role_category per cwid (default "faculty"). */
    roles: new Map<string, string>(),
    /** dept_code / div_code / primary_org_code per cwid. */
    units: new Map<string, Record<string, string>>(),
    /** Manual division code → its hand-added roster. */
    rosters: new Map<string, string[]>(),
    scholars: new Map<string, { orcid: string | null; orcidConfirmMethod: string | null }>(),
    dismissals: new Set<string>(),
  };
  const k = (cwid: string, orcid: string) => `${cwid}|${orcid}`;
  const scholarUpdateMany = vi.fn();
  const h = { state, scholarUpdateMany };
  const tx = {
    orcidCandidateEvidence: {
      findUnique: vi.fn(async ({ where }: { where: { cwid_orcid: Pair } }) => {
        const e = h.state.evidence.find(
          (r) => r.cwid === where.cwid_orcid.cwid && r.orcid === where.cwid_orcid.orcid,
        );
        return e ? { band: e.band } : null;
      }),
      findMany: vi.fn(async (args?: { where?: { band?: string } }) =>
        h.state.evidence
          .filter((r) => args?.where?.band === undefined || r.band === args.where.band)
          .map(({ cwid, orcid, band }) => ({ cwid, orcid, band, shared: 5, nameAgrees: true })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { band: string; computedAt: { gt: Date } } }) => {
        const e = h.state.evidence.find(
          (r) => r.band === where.band && r.computedAt && r.computedAt > where.computedAt.gt,
        );
        return e ? { cwid: e.cwid } : null;
      }),
    },
    orcidCandidate: {
      findMany: vi.fn(async ({ where }: { where: { cwid: { in: string[] }; source?: string } }) =>
        [
          ...h.state.admins.map((a) => ({ ...a, source: "rpm_admin" })),
          ...h.state.sources.map((x) => ({ ...x })),
        ].filter(
          (a) =>
            where.cwid.in.includes(a.cwid) &&
            (where.source === undefined || a.source === where.source),
        ),
      ),
    },
    division: {
      findMany: vi.fn(async ({ where }: { where: { code: { in: string[] } } }) =>
        where.code.in.filter((c) => h.state.rosters.has(c)).map((code) => ({ code })),
      ),
    },
    divisionMembership: {
      findMany: vi.fn(async ({ where }: { where: { divisionCode: { in: string[] } } }) =>
        where.divisionCode.in.flatMap((d) =>
          (h.state.rosters.get(d) ?? []).map((cwid) => ({ cwid })),
        ),
      ),
    },
    scholar: {
      findUnique: vi.fn(async ({ where }: { where: { cwid: string } }) => {
        const s = h.state.scholars.get(where.cwid);
        return s ? { ...s } : null;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            cwid: { in: string[] };
            roleCategory?: { in: string[] };
            AND?: Array<{ OR?: Array<Record<string, { in: string[] }>> }>;
          };
        }) =>
          where.cwid.in
            .filter((c) => h.state.scholars.has(c))
            .filter(
              (c) =>
                !where.roleCategory ||
                where.roleCategory.in.includes(h.state.roles.get(c) ?? "faculty"),
            )
            // personFilterWhere's unit clause: { OR: [{ deptCode: { in } }, { cwid: { in } }, …] }.
            .filter((c) =>
              (where.AND ?? []).every(
                (w) =>
                  !w.OR ||
                  w.OR.some((o) =>
                    Object.entries(o).some(([field, v]) =>
                      v.in.includes(field === "cwid" ? c : (h.state.units.get(c)?.[field] ?? "")),
                    ),
                  ),
              ),
            )
            .map((c) => ({
              cwid: c,
              orcid: h.state.scholars.get(c)!.orcid,
              status: "active",
              deletedAt: null,
            })),
      ),
      updateMany: h.scholarUpdateMany,
    },
    orcidDismissal: {
      findUnique: vi.fn(async ({ where }: { where: { cwid_orcid: Pair } }) =>
        h.state.dismissals.has(k(where.cwid_orcid.cwid, where.cwid_orcid.orcid))
          ? where.cwid_orcid
          : null,
      ),
      findMany: vi.fn(async (args?: { where?: { cwid?: string | { in: string[] } } }) =>
        [...h.state.dismissals]
          .map((d) => ({ cwid: d.split("|")[0]!, orcid: d.split("|")[1]! }))
          .filter((d) => {
            const c = args?.where?.cwid;
            return (
              c === undefined || (typeof c === "string" ? d.cwid === c : c.in.includes(d.cwid))
            );
          }),
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async ({ create }: { create: Pair }) => {
        h.state.dismissals.add(k(create.cwid, create.orcid));
        return create;
      }),
    },
  };
  return {
    readEditRequest: vi.fn(),
    appendAuditRow: vi.fn(),
    reflectOverviewEdit: vi.fn(),
    reflectVisibilityChange: vi.fn(),
    runAfterResponse: vi.fn(),
    state,
    scholarUpdateMany,
    tx,
  };
});
const tx = h.tx;
const k = (cwid: string, orcid: string) => `${cwid}|${orcid}`;

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: h.reflectOverviewEdit,
  reflectVisibilityChange: h.reflectVisibilityChange,
}));
vi.mock("@/lib/edit/after-response", () => ({ runAfterResponse: h.runAfterResponse }));
vi.mock("@/lib/db", () => ({
  db: {
    write: { ...h.tx, $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) },
    read: {
      scholar: {
        findUnique: vi.fn(async () => ({ slug: "jane-doe" })),
        findMany: vi.fn(async () => []),
      },
    },
  },
}));

import { POST as decide } from "@/app/api/edit/orcid-queue/decide/route";

const SUPER = { cwid: "lib0001", isSuperuser: true };
const STEWARD = { cwid: "cs00001", isSuperuser: false, isCommsSteward: true };

function req(
  body: Record<string, unknown>,
  session: Record<string, unknown> = SUPER,
  impersonatedCwid: string | null = null,
) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "lib0001", impersonatedCwid, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/orcid-queue", { method: "POST" }) as never;
}

const audits = () =>
  h.appendAuditRow.mock.calls.map(
    (c) => c[1] as { action: string; afterValues: Record<string, unknown> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.ORCID_LIBRARIAN_QUEUE = "on";
  h.state.evidence = [{ cwid: "jd0001", orcid: ORCID, band: "strong" }];
  h.state.scholars = new Map([["jd0001", { orcid: null, orcidConfirmMethod: null }]]);
  h.state.dismissals = new Set();
  h.state.admins = [];
  h.state.sources = [];
  h.state.roles = new Map();
  h.state.units = new Map();
  h.state.rosters = new Map();
  h.scholarUpdateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { cwid: string; orcid: string | null };
      data: { orcid: string | null; orcidConfirmMethod: string | null };
    }) => {
      const s = h.state.scholars.get(where.cwid);
      if (!s || s.orcid !== where.orcid) return { count: 0 };
      s.orcid = data.orcid;
      s.orcidConfirmMethod = data.orcidConfirmMethod;
      return { count: 1 };
    },
  );
});

describe("authz", () => {
  const calls: Array<[string, (r: never) => Promise<Response>, Record<string, unknown>]> = [
    ["decide", decide, { cwid: "jd0001", orcid: ORCID, decision: "confirm" }],
  ];

  it.each(calls)("%s 404s with the flag off, before the preamble", async (_n, route, body) => {
    process.env.ORCID_LIBRARIAN_QUEUE = "off";
    expect((await route(req(body))).status).toBe(404);
    expect(h.readEditRequest).not.toHaveBeenCalled();
  });

  it.each(calls)("%s 403s a non-superuser, nothing written", async (_n, route, body) => {
    const res = await route(req(body, STEWARD));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_superuser");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it.each(calls)(
    "%s 403s a View-as superuser: an impersonated decision is never the librarian's",
    async (_n, route, body) => {
      const res = await route(req(body, SUPER, "jd0001"));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("impersonation_refused");
      expect(h.scholarUpdateMany).not.toHaveBeenCalled();
      expect(h.appendAuditRow).not.toHaveBeenCalled();
    },
  );
});

describe("decide", () => {
  it("confirm: scholar.orcid with method librarian by the real actor, the pair's dismissal deleted, one audit row", async () => {
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(res.status).toBe(200);
    expect(h.scholarUpdateMany).toHaveBeenCalledWith({
      where: { cwid: "jd0001", orcid: null },
      data: expect.objectContaining({
        orcid: ORCID,
        orcidConfirmMethod: "librarian",
        orcidConfirmedBy: "lib0001",
      }),
    });
    expect(tx.orcidDismissal.deleteMany).toHaveBeenCalledWith({
      where: { cwid: "jd0001", orcid: ORCID },
    });
    expect(audits()).toEqual([expect.objectContaining({ action: "orcid_librarian_confirm" })]);
    expect(h.appendAuditRow.mock.calls[0]![1]).toMatchObject({
      actorCwid: "lib0001",
      impersonatedCwid: null,
    });
    expect(h.reflectOverviewEdit).toHaveBeenCalledWith("jane-doe");
  });

  it("confirm: a pair not in the evidence table is 404; a different iD on file is 409 unless replace", async () => {
    expect((await decide(req({ cwid: "jd0001", orcid: OTHER, decision: "confirm" }))).status).toBe(
      404,
    );
    h.state.scholars.set("jd0001", { orcid: OTHER, orcidConfirmMethod: "self" });
    const refused = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("on_file_differs");
    const replaced = await decide(
      req({ cwid: "jd0001", orcid: ORCID, decision: "confirm", replace: true }),
    );
    expect(replaced.status).toBe(200);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals.has(k("jd0001", OTHER))).toBe(true);
  });

  it("400 on a bad iD or decision, before any write", async () => {
    expect(
      (await decide(req({ cwid: "jd0001", orcid: "0000-0002-1825-0098", decision: "confirm" })))
        .status,
    ).toBe(400);
    expect((await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "maybe" }))).status).toBe(
      400,
    );
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("dismiss: an orcid_dismissal row and an audit row; scholar.orcid untouched", async () => {
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    expect(res.status).toBe(200);
    expect(h.state.dismissals.has(k("jd0001", ORCID))).toBe(true);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(audits()).toEqual([expect.objectContaining({ action: "orcid_librarian_dismiss" })]);
  });

  it("dismiss on an email auto-confirmed iD is the Undo: clears scholar.orcid and dismisses", async () => {
    h.state.scholars.set("jd0001", { orcid: ORCID, orcidConfirmMethod: "email_verified" });
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ undid: true });
    expect(h.scholarUpdateMany).toHaveBeenCalledWith({
      where: { cwid: "jd0001", orcid: ORCID },
      data: {
        orcid: null,
        orcidConfirmedAt: null,
        orcidConfirmMethod: null,
        orcidConfirmedBy: null,
      },
    });
    expect(h.state.dismissals.has(k("jd0001", ORCID))).toBe(true);
    expect(audits()[0]!.afterValues).toMatchObject({ undo_email_autoconfirm: true });
  });

  it("an rpm_admin iD is on file: another candidate is a 409 conflict, replace dismisses the rpm_admin iD", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: OTHER }];
    const refused = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("on_file_differs");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    const replaced = await decide(
      req({ cwid: "jd0001", orcid: ORCID, decision: "confirm", replace: true }),
    );
    expect(replaced.status).toBe(200);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals.has(k("jd0001", OTHER))).toBe(true);
    expect(audits()[0]!.afterValues).toMatchObject({ dismissed: [OTHER] });
  });

  it("an rpm_admin iD is on file: confirming it is 409 already_on_file, dismissing it is 409 on_file", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: ORCID }];
    const confirm = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect((await confirm.json()).error).toBe("already_on_file");
    const dismiss = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    expect(dismiss.status).toBe(409);
    expect((await dismiss.json()).error).toBe("on_file");
    expect(h.state.dismissals.size).toBe(0);
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("a dismissed rpm_admin iD is not on file: the candidate confirms", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: OTHER }];
    h.state.dismissals.add(k("jd0001", OTHER));
    expect((await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }))).status).toBe(
      200,
    );
  });

  it("confirm never overrides a dismissal (the scholar's Remove, or Not this person): 409, nothing written", async () => {
    h.state.dismissals.add(k("jd0001", ORCID));
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("dismissed");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(h.state.dismissals.has(k("jd0001", ORCID))).toBe(true);
  });

  it("dismiss on an iD the scholar confirmed themselves is 409 (that is Remove on /edit)", async () => {
    h.state.scholars.set("jd0001", { orcid: ORCID, orcidConfirmMethod: "self" });
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    expect(res.status).toBe(409);
    expect(h.state.dismissals.size).toBe(0);
  });
});

describe("v2: confirm one iD, dismiss the scholar's others in the same action", () => {
  // A checksum-valid iD (the decide route normalizes every iD it is sent).
  const ORCID_3 = "0000-0001-5109-3700";
  beforeEach(() => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "jd0001", orcid: ORCID_3, band: "weak" },
      { cwid: "jd0001", orcid: OTHER, band: "moderate" },
    ];
  });

  it("confirms, then dismisses each other iD, one transaction, an audit row for each", async () => {
    const { db } = await import("@/lib/db");
    const res = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "confirm",
        dismissOthers: [ORCID_3, OTHER, ORCID],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dismissed: [ORCID_3, OTHER] });
    expect(db.write.$transaction).toHaveBeenCalledTimes(1);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals).toEqual(new Set([k("jd0001", ORCID_3), k("jd0001", OTHER)]));
    expect(audits().map((a) => a.action)).toEqual([
      "orcid_librarian_confirm",
      "orcid_librarian_dismiss",
      "orcid_librarian_dismiss",
    ]);
    expect(audits()[1]!.afterValues).toMatchObject({
      dismissed: [ORCID_3],
      with_confirm_of: ORCID,
    });
  });

  it("an other iD not in the scholar's queue refuses the whole decision (404)", async () => {
    h.state.evidence = h.state.evidence.filter((e) => e.orcid !== OTHER);
    const res = await decide(
      req({ cwid: "jd0001", orcid: ORCID, decision: "confirm", dismissOthers: [OTHER] }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("other_not_in_queue");
  });

  it("v3 None of these: a dismiss with the rest in dismissOthers, one transaction, flagged in each audit row", async () => {
    const { db } = await import("@/lib/db");
    const res = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "dismiss",
        dismissOthers: [ORCID_3, OTHER],
        noneOfThese: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dismissed: [ORCID_3, OTHER] });
    expect(db.write.$transaction).toHaveBeenCalledTimes(1);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(h.state.dismissals).toEqual(
      new Set([k("jd0001", ORCID), k("jd0001", ORCID_3), k("jd0001", OTHER)]),
    );
    expect(audits().map((a) => a.action)).toEqual([
      "orcid_librarian_dismiss",
      "orcid_librarian_dismiss",
      "orcid_librarian_dismiss",
    ]);
    for (const a of audits()) {
      expect(a.afterValues).toMatchObject({ none_of_these: true });
      expect(a.afterValues).not.toHaveProperty("with_confirm_of");
    }
  });

  it("400: dismissOthers on a plain dismiss, noneOfThese on a confirm, not an array, or a bad iD", async () => {
    for (const body of [
      { decision: "dismiss", dismissOthers: [ORCID_3] },
      { decision: "confirm", noneOfThese: true },
      { decision: "confirm", dismissOthers: ORCID_3 },
      { decision: "confirm", dismissOthers: ["0000-0002-1825-0098"] },
    ]) {
      expect((await decide(req({ cwid: "jd0001", orcid: ORCID, ...body }))).status).toBe(400);
    }
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });
});
