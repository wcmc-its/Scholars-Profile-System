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
    evidence: [] as Array<{
      cwid: string;
      orcid: string;
      band: string;
      computedAt?: Date;
      competitor?: boolean;
      nameAgrees?: boolean;
      /** Bulk floor facts; defaults pass (etl:bulk-confirm-strong rule). */
      shared?: number;
      instMatch?: boolean;
      reciterRead?: boolean;
      rejected?: number;
      competitorCwids?: string[];
      /** `evidence_detail.byline` (absent = an earlier run's row). */
      byline?: Record<string, unknown>;
    }>,
    /** `orcid_candidate` pairs with articles_rejected > 0 (`cwid|orcid`). */
    rpmRejected: new Set<string>(),
    /** `orcid_candidate` rows with source `rpm_admin`. */
    admins: [] as Array<{ cwid: string; orcid: string }>,
    /** Other `orcid_candidate` rows (any source). */
    sources: [] as Array<{ cwid: string; orcid: string; source: string }>,
    /** Scholars with a confirmed publication. */
    withPubs: ["jd0001"],
    /** role_category per cwid (default "faculty"). */
    roles: new Map<string, string>(),
    /** dept_code / div_code / primary_org_code per cwid. */
    units: new Map<string, Record<string, string>>(),
    /** Manual division code → its hand-added roster. */
    rosters: new Map<string, string[]>(),
    scholars: new Map<
      string,
      {
        orcid: string | null;
        orcidConfirmMethod: string | null;
        orcidConfirmedBy?: string | null;
        orcidConfirmedAt?: Date | null;
        campus?: string;
        status?: string;
      }
    >(),
    dismissals: new Set<string>(),
    /** Who wrote each dismissal, and when (`cwid|orcid`). */
    dismissMeta: new Map<string, { dismissedBy: string | null; dismissedAt: Date }>(),
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
      findMany: vi.fn(
        async (args?: {
          where?: { band?: string; cwid?: string | { in: string[] }; orcid?: { in: string[] } };
        }) =>
          h.state.evidence
            .filter((r) => args?.where?.band === undefined || r.band === args.where.band)
            .filter((r) => {
              const c = args?.where?.cwid;
              return (
                c === undefined || (typeof c === "string" ? r.cwid === c : c.in.includes(r.cwid))
              );
            })
            .filter((r) => !args?.where?.orcid || args.where.orcid.in.includes(r.orcid))
            .map((r) => ({
              cwid: r.cwid,
              orcid: r.orcid,
              band: r.band,
              shared: r.shared ?? 5,
              nameAgrees: r.nameAgrees ?? true,
              competitor: r.competitor ?? false,
              competitorCwids: r.competitorCwids ?? [],
              competitorOrcids: [],
              instMatch: r.instMatch ?? true,
              evidenceDetail: {
                workStatus: {
                  reciterRead: r.reciterRead ?? true,
                  counts: { rejected: r.rejected ?? 0 },
                },
                ...(r.byline ? { byline: r.byline } : {}),
              },
            })),
      ),
      count: vi.fn(
        async ({ where }: { where: { orcid: string; cwid: { not: string } } }) =>
          h.state.evidence.filter((r) => r.orcid === where.orcid && r.cwid !== where.cwid.not)
            .length,
      ),
      findFirst: vi.fn(async ({ where }: { where: { band: string; computedAt: { gt: Date } } }) => {
        const e = h.state.evidence.find(
          (r) => r.band === where.band && r.computedAt && r.computedAt > where.computedAt.gt,
        );
        return e ? { cwid: e.cwid } : null;
      }),
    },
    orcidCandidate: {
      count: vi.fn(async ({ where }: { where: Pair & { source?: string } }) =>
        where.source
          ? h.state.sources.filter(
              (x) => x.cwid === where.cwid && x.orcid === where.orcid && x.source === where.source,
            ).length
          : h.state.rpmRejected.has(k(where.cwid, where.orcid))
            ? 1
            : 0,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { cwid: { in: string[] }; orcid?: { in: string[] }; source?: string };
        }) =>
          [
            ...h.state.admins.map((a) => ({ ...a, source: "rpm_admin", articlesRejected: 0 })),
            ...h.state.sources.map((x) => ({ ...x, articlesRejected: 0 })),
            // bulkConfirmableMany reads rejected RPM pairs as rows.
            ...(where.orcid
              ? [...h.state.rpmRejected].map((key) => ({
                  cwid: key.split("|")[0]!,
                  orcid: key.split("|")[1]!,
                  source: "rpm_inferred",
                  articlesRejected: 1,
                }))
              : []),
          ].filter(
            (a) =>
              where.cwid.in.includes(a.cwid) &&
              (!where.orcid || where.orcid.in.includes(a.orcid)) &&
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
    // assertOrcidFree: no cross-campus links in these fixtures.
    scholarIdentityLink: { count: vi.fn(async () => 0) },
    scholar: {
      findUnique: vi.fn(async ({ where }: { where: { cwid: string } }) => {
        const s = h.state.scholars.get(where.cwid);
        return s ? { campus: "wcm", status: "active", deletedAt: null, ...s } : null;
      }),
      count: vi.fn(
        async ({ where }: { where: { orcid: string } }) =>
          [...h.state.scholars.values()].filter((s) => s.orcid === where.orcid).length,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            cwid?: { in?: string[]; not?: string };
            orcid?: string | { in: string[] };
            roleCategory?: { in: string[] };
            AND?: Array<{ OR?: Array<Record<string, { in: string[] }>> }>;
          };
        }) =>
          // No `cwid.in`: assertOrcidFree's lookup of OTHER rows holding the iD, or
          // bulkConfirmableMany's holders of any of the iDs (`orcid.in`).
          (
            where.cwid?.in ??
            [...h.state.scholars.keys()].filter((c) => {
              const o = h.state.scholars.get(c)!.orcid;
              return typeof where.orcid === "object"
                ? o !== null && where.orcid.in.includes(o)
                : o === where.orcid && c !== where.cwid?.not;
            })
          )
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
              campus: "wcm",
              status: "active",
              deletedAt: null,
              ...h.state.scholars.get(c)!,
              cwid: c,
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
      findMany: vi.fn(
        async (args?: {
          where?: {
            cwid?: string | { in: string[] };
            orcid?: { in: string[] };
            dismissedBy?: string;
          };
        }) =>
          [...h.state.dismissals]
            .map((d) => ({
              cwid: d.split("|")[0]!,
              orcid: d.split("|")[1]!,
              dismissedBy: h.state.dismissMeta.get(d)?.dismissedBy ?? null,
              dismissedAt: h.state.dismissMeta.get(d)?.dismissedAt ?? new Date(0),
            }))
            .filter((d) => {
              const w = args?.where;
              const c = w?.cwid;
              return (
                (c === undefined ||
                  (typeof c === "string" ? d.cwid === c : c.in.includes(d.cwid))) &&
                (w?.orcid === undefined || w.orcid.in.includes(d.orcid)) &&
                (w?.dismissedBy === undefined || d.dismissedBy === w.dismissedBy)
              );
            }),
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { cwid: string; orcid: string | { in: string[] }; dismissedBy?: string };
        }) => {
          let count = 0;
          for (const d of [...h.state.dismissals]) {
            const [cwid, orcid] = d.split("|") as [string, string];
            const o = where.orcid;
            if (cwid !== where.cwid) continue;
            if (typeof o === "string" ? orcid !== o : !o.in.includes(orcid)) continue;
            if (
              where.dismissedBy !== undefined &&
              h.state.dismissMeta.get(d)?.dismissedBy !== where.dismissedBy
            )
              continue;
            h.state.dismissals.delete(d);
            h.state.dismissMeta.delete(d);
            count += 1;
          }
          return { count };
        },
      ),
      upsert: vi.fn(async ({ create }: { create: Pair & { dismissedBy?: string | null } }) => {
        const key = k(create.cwid, create.orcid);
        h.state.dismissals.add(key);
        if (!h.state.dismissMeta.has(key))
          h.state.dismissMeta.set(key, {
            dismissedBy: create.dismissedBy ?? null,
            dismissedAt: new Date(),
          });
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
      // Bulk review's dry-run extras (`bulkPairFacts`).
      publicationAuthor: { groupBy: vi.fn(async () => h.state.withPubs.map((cwid) => ({ cwid }))) },
      orcidCandidateEvidence: {
        findMany: vi.fn(async () => [
          {
            cwid: "jd0001",
            orcid: "0000-0002-1825-0097",
            evidenceDetail: {
              names: {
                orcid: { credit: null, given: "Jane", family: "Doe", other: [] },
                givenAgrees: true,
                surnameRule: "exact",
              },
              institutions: [],
              shared: [],
              email: "jd0001@med.cornell.edu",
            },
          },
        ]),
      },
    },
  },
}));

import { POST as bulkConfirm } from "@/app/api/edit/orcid-queue/bulk-confirm/route";
import { POST as decide } from "@/app/api/edit/orcid-queue/decide/route";
import { POST as undo } from "@/app/api/edit/orcid-queue/undo/route";

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
  h.state.rpmRejected = new Set();
  h.state.dismissMeta = new Map();
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
      Object.assign(s, data);
      return { count: 1 };
    },
  );
});

describe("authz", () => {
  const calls: Array<[string, (r: never) => Promise<Response>, Record<string, unknown>]> = [
    ["decide", decide, { cwid: "jd0001", orcid: ORCID, decision: "confirm" }],
    [
      "bulk-confirm",
      bulkConfirm,
      {
        pairs: [{ cwid: "jd0001", orcid: ORCID }],
        rule: { minShared: 5, maxOnlyOrcid: 1, minSources: 2 },
      },
    ],
    ["undo", undo, { items: [{ cwid: "jd0001", confirmed: ORCID }] }],
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
    expect(tx.orcidDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          cwid: "jd0001",
          orcid: OTHER,
          dismissedBy: "lib0001",
          reason: "other_confirmed",
          keptOrcid: ORCID,
        },
      }),
    );
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
    expect(tx.orcidDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          cwid: "jd0001",
          orcid: ORCID,
          dismissedBy: "lib0001",
          reason: "not_this_person",
          keptOrcid: null,
          otherCwid: null,
        },
      }),
    );
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

  it("an rpm_admin iD is a candidate, not on file: another candidate confirms without replace, and the admin iD is not dismissed", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: OTHER }];
    const res = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(res.status).toBe(200);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals.has(k("jd0001", OTHER))).toBe(false);
    expect(audits()[0]!.afterValues).not.toHaveProperty("dismissed");
  });

  it("an rpm_admin iD confirms like any candidate", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: ORCID }];
    const confirm = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "confirm" }));
    expect(confirm.status).toBe(200);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
  });

  it("Not this person on an rpm_admin iD is a plain dismissal", async () => {
    h.state.admins = [{ cwid: "jd0001", orcid: ORCID }];
    const dismiss = await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    expect(dismiss.status).toBe(200);
    expect(h.state.dismissals.has(k("jd0001", ORCID))).toBe(true);
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
    expect(tx.orcidDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          orcid: ORCID_3,
          reason: "other_confirmed",
          keptOrcid: ORCID,
        }),
      }),
    );
  });

  it("an other iD not in the scholar's queue refuses the whole decision (404)", async () => {
    h.state.evidence = h.state.evidence.filter((e) => e.orcid !== OTHER);
    const res = await decide(
      req({ cwid: "jd0001", orcid: ORCID, decision: "confirm", dismissOthers: [OTHER] }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("other_not_in_queue");
  });

  it("v3 B2 retireOthers: the others are retired as duplicate records (reason duplicate_retired, kept iD)", async () => {
    h.state.evidence.push({ cwid: "jd0001", orcid: OTHER, band: "moderate" });
    const res = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "confirm",
        dismissOthers: [OTHER],
        retireOthers: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(tx.orcidDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          orcid: OTHER,
          reason: "duplicate_retired",
          keptOrcid: ORCID,
        }),
      }),
    );
    expect(audits()[1]!.afterValues).toMatchObject({
      duplicate_retired: true,
      with_confirm_of: ORCID,
    });
    // retireOthers needs a confirm with others.
    expect(
      (await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss", retireOthers: true })))
        .status,
    ).toBe(400);
  });

  it("v3 B2 shared, belongs: confirmed for the other scholar, ruled out here as belongs_to_other", async () => {
    h.state.evidence.push({ cwid: "zz0002", orcid: ORCID, band: "moderate" });
    h.state.scholars.set("zz0002", { orcid: null, orcidConfirmMethod: null });
    const res = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "dismiss",
        shared: { cwid: "zz0002", belongs: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(h.state.scholars.get("zz0002")!).toMatchObject({
      orcid: ORCID,
      orcidConfirmMethod: "librarian",
    });
    expect(h.state.scholars.get("jd0001")!.orcid).toBeNull();
    expect(h.state.dismissals).toEqual(new Set([k("jd0001", ORCID)]));
    expect(tx.orcidDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          cwid: "jd0001",
          reason: "belongs_to_other",
          otherCwid: "zz0002",
        }),
      }),
    );
    expect(audits().map((a) => a.action)).toEqual([
      "orcid_librarian_confirm",
      "orcid_librarian_dismiss",
    ]);
    expect(audits()[1]!.afterValues).toMatchObject({ belongs_to: "zz0002" });
  });

  it("v3 B2 shared, not either: Not this person for both; refused when the other has no such candidate", async () => {
    h.state.evidence.push({ cwid: "zz0002", orcid: ORCID, band: "moderate" });
    h.state.scholars.set("zz0002", { orcid: null, orcidConfirmMethod: null });
    const res = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "dismiss",
        shared: { cwid: "zz0002", belongs: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(h.state.dismissals).toEqual(new Set([k("jd0001", ORCID), k("zz0002", ORCID)]));
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    h.state.dismissals = new Set();
    const missing = await decide(
      req({
        cwid: "jd0001",
        orcid: ORCID,
        decision: "dismiss",
        shared: { cwid: "nobody", belongs: true },
      }),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("other_not_in_queue");
    // shared is a dismiss without others.
    expect(
      (
        await decide(
          req({
            cwid: "jd0001",
            orcid: ORCID,
            decision: "confirm",
            shared: { cwid: "zz0002", belongs: true },
          }),
        )
      ).status,
    ).toBe(400);
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
    for (const [arg] of vi.mocked(tx.orcidDismissal.upsert).mock.calls)
      expect((arg as { create: object }).create).toMatchObject({
        reason: "none_of_these",
        keptOrcid: null,
      });
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

describe("bulk-confirm", () => {
  const RULE = { minShared: 5, maxOnlyOrcid: 1 };
  const BYLINE = { papers: [], total: 2, rejected: 0, otherHolders: [], otherIds: [] };
  const blockerOf = async (rule: Record<string, unknown> = RULE, dryRun = false) => {
    const res = await bulkConfirm(
      req({ pairs: [{ cwid: "jd0001", orcid: ORCID }], rule, ...(dryRun ? { dryRun } : {}) }),
    );
    const r = ((await res.json()) as { results: Array<{ ok: boolean; blocker?: string }> })
      .results[0]!;
    return r.ok ? null : r.blocker;
  };

  it.each([
    ["2 shared works", { shared: 2 }],
    ["no institution match", { instMatch: false }],
  ])("byline route: confirms a Strong pair with %s when 2 accepted papers print the iD", async (_, extra) => {
    h.state.evidence = [{ cwid: "jd0001", orcid: ORCID, band: "strong", ...extra, byline: BYLINE }];
    expect(await blockerOf(RULE, true)).toBeNull();
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(await blockerOf()).toBeNull();
    expect(h.state.scholars.get("jd0001")).toMatchObject({
      orcid: ORCID,
      orcidConfirmMethod: "librarian",
    });
  });

  it.each([
    ["one byline paper", { total: 1 }, "shared"],
    ["a rejected paper that prints the iD", { rejected: 1 }, "shared"],
    ["another holder of the iD on a byline", { otherHolders: ["zz0009"] }, "shared"],
    ["a second iD on the scholar's bylines", { otherIds: [OTHER] }, "shared"],
    [
      "a rejected paper only Crossref prints it on",
      { uncountedContests: { rejected: 1, otherHolders: [], otherIds: [] } },
      "shared",
    ],
    [
      "another holder only Crossref shows",
      { uncountedContests: { rejected: 0, otherHolders: ["zz0009"], otherIds: [] } },
      "shared",
    ],
    ["a byline shape we do not know", { papers: undefined }, "shared"],
  ])("byline route: %s does not pass the floor", async (_, over, blocker) => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong", shared: 2, byline: { ...BYLINE, ...over } },
    ];
    expect(await blockerOf()).toBe(blocker);
    expect(await blockerOf(RULE, true)).toBe(blocker);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("byline route: a failed record route with an institution match missing says so", async () => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong", instMatch: false, byline: { ...BYLINE, total: 1 } },
    ];
    expect(await blockerOf()).toBe("institution");
  });

  it("byline route: the other floor blockers still block", async () => {
    const pair = { cwid: "jd0001", orcid: ORCID, band: "strong", shared: 2, byline: BYLINE };
    h.state.evidence = [{ ...pair, rejected: 1 }];
    expect(await blockerOf()).toBe("reciter_rejected");
    h.state.evidence = [{ ...pair, reciterRead: false }];
    expect(await blockerOf()).toBe("reciter_unread");
    h.state.evidence = [{ ...pair, competitorCwids: ["xx0009"] }];
    expect(await blockerOf()).toBe("competitor");
    // The iD is a candidate for another scholar, then on file for one.
    h.state.evidence = [pair, { cwid: "zz0002", orcid: ORCID, band: "weak" }];
    expect(await blockerOf()).toBe("other_scholar");
    h.state.evidence = [pair];
    h.state.scholars.set("zz0002", { orcid: ORCID, orcidConfirmMethod: "self" });
    expect(await blockerOf()).toBe("other_scholar");
    h.state.scholars.delete("zz0002");
    h.state.rpmRejected = new Set([`jd0001|${ORCID}`]);
    expect(await blockerOf()).toBe("reciter_rejected");
    h.state.rpmRejected = new Set();
    h.state.scholars.set("jd0001", { orcid: OTHER, orcidConfirmMethod: "self" });
    expect(await blockerOf()).toBe("on_file");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("byline route: never for Cornell Ithaca, whose floor is unchanged", async () => {
    // Made up, with a valid check digit.
    const ITH = "0000-0000-0000-0028";
    h.state.evidence = [{ cwid: "it0001", orcid: ITH, band: "strong", byline: BYLINE }];
    h.state.scholars = new Map([
      ["it0001", { orcid: null, orcidConfirmMethod: null, campus: "ithaca", status: "external" }],
    ]);
    const one = async (rule: Record<string, unknown>) => {
      const res = await bulkConfirm(req({ pairs: [{ cwid: "it0001", orcid: ITH }], rule }));
      return ((await res.json()) as { results: Array<{ blocker?: string }> }).results[0]!.blocker;
    };
    expect(await one(RULE)).toBe("ithaca_source");
    // The WCM flag loosens nothing for Ithaca.
    h.state.sources = [{ cwid: "it0001", orcid: ITH, source: "web_page_seed" }];
    h.state.evidence = [
      { cwid: "it0001", orcid: ITH, band: "strong", nameAgrees: false },
      { cwid: "it0001", orcid: OTHER, band: "weak" },
    ];
    expect(await one({ ...RULE, allowMultiple: true })).toBe("multiple");
    h.state.evidence = [{ cwid: "it0001", orcid: ITH, band: "strong", nameAgrees: false }];
    expect(await one({ ...RULE, allowMultiple: true })).toBe("name");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("takes a scholar's best iD of several only when the rule says so; never a differing name", async () => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "jd0001", orcid: OTHER, band: "weak" },
    ];
    expect(await blockerOf()).toBe("multiple");
    expect(await blockerOf({ ...RULE, allowMultiple: false })).toBe("multiple");
    // Not the best of the scholar's iDs: refused even when several are allowed.
    const res = await bulkConfirm(
      req({ pairs: [{ cwid: "jd0001", orcid: OTHER }], rule: { ...RULE, allowMultiple: true } }),
    );
    expect(((await res.json()) as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(false);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    h.state.evidence = [{ cwid: "jd0001", orcid: ORCID, band: "strong", nameAgrees: false }];
    expect(await blockerOf()).toBe("name");
    expect(await blockerOf({ ...RULE, allowMultiple: true })).toBe("name");
    // A retired flag from an old client is an unknown key: ignored, so still refused.
    expect(await blockerOf({ ...RULE, allowNameDiffers: true })).toBe("name");
    expect(await blockerOf({ ...RULE, allowNameDiffers: true }, true)).toBe("name");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "jd0001", orcid: OTHER, band: "weak" },
    ];
    const rule = { ...RULE, allowMultiple: true, passesBy: "either" };
    expect(await blockerOf(rule)).toBeNull();
    expect(h.state.scholars.get("jd0001")).toMatchObject({ orcid: ORCID });
    expect(audits().at(-1)).toMatchObject({ afterValues: { bulk: true, bulk_rule: rule } });
  });

  it("400 on a rule flag that is not a boolean, or an unknown Passes by", async () => {
    for (const extra of [{ allowMultiple: "yes" }, { passesBy: "name" }])
      expect(
        (await bulkConfirm(req({ pairs: [{ cwid: "jd0001", orcid: ORCID }], rule: { ...RULE, ...extra } })))
          .status,
      ).toBe(400);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("confirms each pair with confirmPair's write, the rule on each audit row; refuses what no longer qualifies", async () => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "js0002", orcid: OTHER, band: "strong", competitor: true },
      { cwid: "jt0003", orcid: "0000-0001-5109-3700", band: "moderate" },
    ];
    h.state.scholars = new Map([
      ["jd0001", { orcid: null, orcidConfirmMethod: null }],
      ["js0002", { orcid: null, orcidConfirmMethod: null }],
      ["jt0003", { orcid: null, orcidConfirmMethod: null }],
    ]);
    const res = await bulkConfirm(
      req({
        pairs: [
          { cwid: "jd0001", orcid: ORCID },
          { cwid: "js0002", orcid: OTHER },
          { cwid: "jt0003", orcid: "0000-0001-5109-3700" },
        ],
        rule: RULE,
      }),
    );
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: Array<{ cwid: string; ok: boolean; code?: string }>;
    };
    expect(results).toEqual([
      { cwid: "jd0001", orcid: ORCID, ok: true },
      {
        cwid: "js0002",
        orcid: OTHER,
        ok: false,
        code: "not_bulk_eligible",
        blocker: "competitor",
      },
      {
        cwid: "jt0003",
        orcid: "0000-0001-5109-3700",
        ok: false,
        code: "not_bulk_eligible",
        blocker: "band",
      },
    ]);
    expect(h.state.scholars.get("jd0001")).toMatchObject({
      orcid: ORCID,
      orcidConfirmMethod: "librarian",
      orcidConfirmedBy: "lib0001",
    });
    expect(h.state.scholars.get("js0002")!.orcid).toBeNull();
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "orcid_librarian_confirm",
      afterValues: { bulk: true, bulk_rule: RULE },
    });
  });

  it("refuses a scholar with a second open iD, and an Ithaca pair neither Affiliation Manager nor a web page supplied", async () => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "jd0001", orcid: OTHER, band: "weak" },
      { cwid: "it0001", orcid: "0000-0001-5109-3700", band: "strong" },
    ];
    h.state.scholars = new Map([
      ["jd0001", { orcid: null, orcidConfirmMethod: null }],
      ["it0001", { orcid: null, orcidConfirmMethod: null, campus: "ithaca", status: "external" }],
    ]);
    const res = await bulkConfirm(
      req({
        pairs: [
          { cwid: "jd0001", orcid: ORCID },
          { cwid: "it0001", orcid: "0000-0001-5109-3700" },
        ],
        rule: RULE,
      }),
    );
    const { results } = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["2 shared works (Strong from byline papers)", { shared: 2 }, "shared"],
    ["no institution match", { instMatch: false }, "institution"],
    ["ReCiter not read", { reciterRead: false }, "reciter_unread"],
    ["a work rejected in ReCiter", { rejected: 1 }, "reciter_rejected"],
    ["a competitor cwid listed", { competitorCwids: ["xx0009"] }, "competitor"],
  ])("refuses a Strong pair with %s (etl:bulk-confirm-strong floor)", async (_, extra, blocker) => {
    h.state.evidence = [{ cwid: "jd0001", orcid: ORCID, band: "strong", ...extra }];
    const res = await bulkConfirm(req({ pairs: [{ cwid: "jd0001", orcid: ORCID }], rule: RULE }));
    const { results } = (await res.json()) as {
      results: Array<{ code?: string; blocker?: string }>;
    };
    expect(results[0]).toMatchObject({ code: "not_bulk_eligible", blocker });
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an iD another scholar holds or is a candidate for, a rejected RPM pair, and any earlier dismissal", async () => {
    const one = async () => {
      const res = await bulkConfirm(req({ pairs: [{ cwid: "jd0001", orcid: ORCID }], rule: RULE }));
      return ((await res.json()) as { results: Array<{ code?: string }> }).results[0]!.code;
    };
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "zz0002", orcid: ORCID, band: "weak" },
    ];
    expect(await one()).toBe("not_bulk_eligible");
    h.state.evidence = [{ cwid: "jd0001", orcid: ORCID, band: "strong" }];
    h.state.scholars.set("zz0002", { orcid: ORCID, orcidConfirmMethod: "self" });
    expect(await one()).toBe("not_bulk_eligible");
    h.state.scholars.delete("zz0002");
    h.state.rpmRejected = new Set([`jd0001|${ORCID}`]);
    expect(await one()).toBe("not_bulk_eligible");
    h.state.rpmRejected = new Set();
    h.state.evidence.push({ cwid: "jd0001", orcid: OTHER, band: "weak" });
    h.state.dismissals = new Set([`jd0001|${OTHER}`]);
    expect(await one()).toBe("not_bulk_eligible");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["cornell_affiliation_manager", "web_page_seed"])("confirms a Strong Cornell Ithaca %s pair without the WCM work checks", async (source) => {
    const ITH = "0000-0001-5109-3700";
    h.state.evidence = [
      // No SPS publications: not read in ReCiter, no institution match.
      { cwid: "it0001", orcid: ITH, band: "strong", instMatch: false, reciterRead: false },
    ];
    h.state.scholars = new Map([
      ["it0001", { orcid: null, orcidConfirmMethod: null, campus: "ithaca", status: "external" }],
    ]);
    h.state.sources = [{ cwid: "it0001", orcid: ITH, source }];
    const res = await bulkConfirm(req({ pairs: [{ cwid: "it0001", orcid: ITH }], rule: RULE }));
    const { results } = (await res.json()) as { results: Array<{ ok: boolean; code?: string }> };
    expect(results[0]).toMatchObject({ ok: true });
    expect(h.state.scholars.get("it0001")).toMatchObject({
      orcid: ITH,
      orcidConfirmMethod: "librarian",
    });
  });

  it("confirms an email-verified Cornell Ithaca pair without Affiliation Manager; refuses one with a competitor or for WCM", async () => {
    const ITH = "0000-0001-5109-3700";
    h.state.evidence = [
      { cwid: "it0001", orcid: ITH, band: "email_verified", instMatch: false, reciterRead: false },
      { cwid: "it0002", orcid: OTHER, band: "email_verified", competitorCwids: ["xx0009"] },
      { cwid: "jd0001", orcid: ORCID, band: "email_verified" },
    ];
    h.state.scholars = new Map([
      ["it0001", { orcid: null, orcidConfirmMethod: null, campus: "ithaca", status: "external" }],
      ["it0002", { orcid: null, orcidConfirmMethod: null, campus: "ithaca", status: "external" }],
      ["jd0001", { orcid: null, orcidConfirmMethod: null }],
    ]);
    const res = await bulkConfirm(
      req({
        pairs: [
          { cwid: "it0001", orcid: ITH },
          { cwid: "it0002", orcid: OTHER },
          { cwid: "jd0001", orcid: ORCID },
        ],
        rule: RULE,
      }),
    );
    const { results } = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(h.state.scholars.get("it0001")).toMatchObject({
      orcid: ITH,
      orcidConfirmMethod: "librarian",
    });
  });

  it.each([true, false])("dryRun reports which pairs pass the floor and writes nothing (has publications: %s)", async (hasPublications) => {
    h.state.withPubs = hasPublications ? ["jd0001"] : [];
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "js0002", orcid: OTHER, band: "strong", instMatch: false },
    ];
    h.state.scholars.set("js0002", { orcid: null, orcidConfirmMethod: null });
    const res = await bulkConfirm(
      req({
        dryRun: true,
        pairs: [
          { cwid: "jd0001", orcid: ORCID },
          { cwid: "js0002", orcid: OTHER },
        ],
        rule: RULE,
      }),
    );
    const { results } = (await res.json()) as {
      results: Array<{ ok: boolean; orcidName?: string | null; verifiedEmail?: boolean }>;
    };
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    // A passing pair carries Bulk review's Name on ORCID and Verified email.
    expect(results[0]).toMatchObject({
      orcidName: "Jane Doe",
      verifiedEmail: true,
      hasPublications,
    });
    expect(results[1]!.orcidName).toBeUndefined();
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(0);
    expect(h.reflectOverviewEdit).not.toHaveBeenCalled();
  });

  it("dryRun checks pairs without a transaction and keeps their order across chunks", async () => {
    const { db } = await import("@/lib/db");
    vi.mocked(db.write.$transaction).mockClear();
    vi.mocked(db.write.orcidCandidateEvidence.findMany).mockClear();
    const ids = ["a1", "b2", "c3", "d4", "e5", "f6"];
    h.state.evidence = ids.map((cwid, i) => ({
      cwid,
      orcid: ORCID,
      band: i % 2 ? "weak" : "strong",
    }));
    const res = await bulkConfirm(
      req({ dryRun: true, pairs: ids.map((cwid) => ({ cwid, orcid: ORCID })), rule: RULE }),
    );
    const { results } = (await res.json()) as { results: Array<{ cwid: string }> };
    expect(results.map((r) => r.cwid)).toEqual(ids);
    expect(db.write.$transaction).not.toHaveBeenCalled();
    // Six queries for the whole batch, however many pairs (two on the evidence table).
    expect(vi.mocked(db.write.orcidCandidateEvidence.findMany)).toHaveBeenCalledTimes(2);
  });

  it("400 on a bad body: no pairs, a repeated scholar, a bad iD, or a missing rule", async () => {
    for (const body of [
      { pairs: [], rule: RULE },
      {
        pairs: [
          { cwid: "jd0001", orcid: ORCID },
          { cwid: "jd0001", orcid: OTHER },
        ],
        rule: RULE,
      },
      { pairs: [{ cwid: "jd0001", orcid: "nope" }], rule: RULE },
      { pairs: [{ cwid: "jd0001", orcid: ORCID }] },
    ])
      expect((await bulkConfirm(req(body))).status).toBe(400);
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });
});

describe("undo", () => {
  it("undoes the actor's own confirm and the dismissals it made: back to undecided, one undo audit row", async () => {
    h.state.evidence = [
      { cwid: "jd0001", orcid: ORCID, band: "strong" },
      { cwid: "jd0001", orcid: OTHER, band: "weak" },
    ];
    await decide(
      req({ cwid: "jd0001", orcid: ORCID, decision: "confirm", dismissOthers: [OTHER] }),
    );
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals.has(k("jd0001", OTHER))).toBe(true);
    h.appendAuditRow.mockClear();

    const res = await undo(
      req({ items: [{ cwid: "jd0001", confirmed: ORCID, dismissed: [OTHER] }] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ cwid: "jd0001", ok: true }]);
    expect(h.state.scholars.get("jd0001")).toMatchObject({ orcid: null, orcidConfirmMethod: null });
    expect(h.state.dismissals.size).toBe(0);
    expect(audits()).toEqual([
      expect.objectContaining({
        action: "orcid_librarian_undo",
        afterValues: { orcid: null, unconfirmed: ORCID, undismissed: [OTHER] },
      }),
    ]);
  });

  it("undoes a Not this person", async () => {
    await decide(req({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" }));
    const res = await undo(req({ items: [{ cwid: "jd0001", dismissed: [ORCID] }] }));
    expect((await res.json()).results).toEqual([{ cwid: "jd0001", ok: true }]);
    expect(h.state.dismissals.size).toBe(0);
  });

  it("never undoes someone else's confirm or dismissal, or a confirm the scholar made", async () => {
    h.state.scholars.set("jd0001", {
      orcid: ORCID,
      orcidConfirmMethod: "librarian",
      orcidConfirmedBy: "other01",
      orcidConfirmedAt: new Date(),
    });
    h.state.scholars.set("js0002", {
      orcid: OTHER,
      orcidConfirmMethod: "self",
      orcidConfirmedBy: "lib0001",
      orcidConfirmedAt: new Date(),
    });
    h.state.dismissals.add(k("jt0003", ORCID));
    h.state.dismissMeta.set(k("jt0003", ORCID), {
      dismissedBy: "other01",
      dismissedAt: new Date(),
    });
    h.state.scholars.set("jt0003", { orcid: null, orcidConfirmMethod: null });
    const res = await undo(
      req({
        items: [
          { cwid: "jd0001", confirmed: ORCID },
          { cwid: "js0002", confirmed: OTHER },
          { cwid: "jt0003", dismissed: [ORCID] },
        ],
      }),
    );
    expect((await res.json()).results).toEqual([
      { cwid: "jd0001", ok: false, code: "state_changed" },
      { cwid: "js0002", ok: false, code: "state_changed" },
      { cwid: "jt0003", ok: false, code: "state_changed" },
    ]);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
    expect(h.state.dismissals.has(k("jt0003", ORCID))).toBe(true);
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("refuses past the 15-minute window", async () => {
    h.state.scholars.set("jd0001", {
      orcid: ORCID,
      orcidConfirmMethod: "librarian",
      orcidConfirmedBy: "lib0001",
      orcidConfirmedAt: new Date(Date.now() - 16 * 60 * 1000),
    });
    const res = await undo(req({ items: [{ cwid: "jd0001", confirmed: ORCID }] }));
    expect((await res.json()).results).toEqual([
      { cwid: "jd0001", ok: false, code: "undo_expired" },
    ]);
    expect(h.state.scholars.get("jd0001")!.orcid).toBe(ORCID);
  });

  it("400 on an empty item or a bad iD", async () => {
    for (const body of [
      { items: [] },
      { items: [{ cwid: "jd0001" }] },
      { items: [{ cwid: "jd0001", confirmed: "nope" }] },
    ])
      expect((await undo(req(body))).status).toBe(400);
  });
});
