/**
 * The ORCID librarian queue routes (`/api/edit/orcid-queue/{decide,sample,
 * bulk-confirm}`), against the real `orcid-queue.server` writers over a fake
 * Prisma client.
 *
 * Load-bearing: the flag 404s first; a non-superuser and any View-as session
 * are 403 with nothing written; a confirm is method `librarian` by the REAL
 * actor; a dismiss on an email auto-confirmed iD is the Undo; a sample's
 * lifecycle (open → passed, a dismissal locks it, a newer sample supersedes);
 * bulk confirm refuses a stale, open or locked sample and skips rows that
 * changed since they were read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORCID = "0000-0002-1825-0097";
const ORCID_2 = "0000-0002-1825-009X";
const OTHER = "0000-0000-0000-001X";

type Pair = { cwid: string; orcid: string };
type SampleRow = Pair & { id: string; band: string; startedAt: Date; decision: string | null };

const h = vi.hoisted(() => {
  const state = {
    evidence: [] as Array<{ cwid: string; orcid: string; band: string; computedAt?: Date }>,
    /** `orcid_candidate` rows with source `rpm_admin`. */
    admins: [] as Array<{ cwid: string; orcid: string }>,
    scholars: new Map<string, { orcid: string | null; orcidConfirmMethod: string | null }>(),
    dismissals: new Set<string>(),
    samples: [] as Array<{
      id: string;
      band: string;
      startedAt: Date;
      cwid: string;
      orcid: string;
      decision: string | null;
    }>,
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
      findMany: vi.fn(async ({ where }: { where: { band: string } }) =>
        h.state.evidence
          .filter((r) => r.band === where.band)
          .map(({ cwid, orcid }) => ({ cwid, orcid })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { band: string; computedAt: { gt: Date } } }) => {
        const e = h.state.evidence.find(
          (r) => r.band === where.band && r.computedAt && r.computedAt > where.computedAt.gt,
        );
        return e ? { cwid: e.cwid } : null;
      }),
    },
    orcidCandidate: {
      findMany: vi.fn(async ({ where }: { where: { cwid: { in: string[] } } }) =>
        h.state.admins.filter((a) => where.cwid.in.includes(a.cwid)),
      ),
    },
    scholar: {
      findUnique: vi.fn(async ({ where }: { where: { cwid: string } }) => {
        const s = h.state.scholars.get(where.cwid);
        return s ? { ...s } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { cwid: { in: string[] } } }) =>
        where.cwid.in
          .filter((c) => h.state.scholars.has(c))
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
    orcidQueueSample: {
      findFirst: vi.fn(async ({ where }: { where: { band: string } }) => {
        const rows = h.state.samples
          .filter((s) => s.band === where.band)
          .sort((a, b) => +b.startedAt - +a.startedAt);
        return rows[0] ? { id: rows[0].id, startedAt: rows[0].startedAt } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id: string } }) =>
        h.state.samples
          .filter((s) => s.id === where.id)
          .map(({ cwid, orcid, decision }) => ({ cwid, orcid, decision })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id_cwid_orcid: Pair & { id: string } } }) => {
        const w = where.id_cwid_orcid;
        const s = h.state.samples.find(
          (r) => r.id === w.id && r.cwid === w.cwid && r.orcid === w.orcid,
        );
        return s ? { decision: s.decision } : null;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Pair & { id: string }; data: { decision: string } }) => {
          const s = h.state.samples.find(
            (r) =>
              r.id === where.id &&
              r.cwid === where.cwid &&
              r.orcid === where.orcid &&
              r.decision === null,
          );
          if (!s) return { count: 0 };
          s.decision = data.decision;
          return { count: 1 };
        },
      ),
      createMany: vi.fn(async ({ data }: { data: SampleRow[] }) => {
        for (const d of data) h.state.samples.push({ ...d, decision: null });
        return { count: data.length };
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
import { POST as sample } from "@/app/api/edit/orcid-queue/sample/route";
import { POST as bulk } from "@/app/api/edit/orcid-queue/bulk-confirm/route";
import { sampleStatus } from "@/lib/edit/orcid-queue";

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
  h.state.samples = [];
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

describe("authz, every route", () => {
  const calls: Array<[string, (r: never) => Promise<Response>, Record<string, unknown>]> = [
    ["decide", decide, { cwid: "jd0001", orcid: ORCID, decision: "confirm" }],
    ["sample", sample, { band: "strong" }],
    ["bulk-confirm", bulk, { band: "strong", sampleId: "s1" }],
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
    expect(tx.orcidQueueSample.createMany).not.toHaveBeenCalled();
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

describe("sample lifecycle", () => {
  const seedBand = (n: number) => {
    h.state.evidence = Array.from({ length: n }, (_, i) => ({
      cwid: `s${String(i).padStart(4, "0")}`,
      orcid: ORCID,
      band: "strong",
    }));
    h.state.scholars = new Map(
      h.state.evidence.map((e) => [e.cwid, { orcid: null, orcidConfirmMethod: null }]),
    );
  };

  it("sampleStatus: open until all decided; passed with none dismissed; locked on any dismissal", () => {
    expect(sampleStatus([{ decision: "confirmed" }, { decision: null }])).toBe("open");
    expect(sampleStatus([{ decision: "confirmed" }, { decision: "confirmed" }])).toBe("passed");
    expect(sampleStatus([{ decision: "dismissed" }, { decision: null }])).toBe("locked");
  });

  it("starts a sample of at most 50 qualifying rows, then returns that open sample", async () => {
    seedBand(60);
    h.state.scholars.set("s0000", { orcid: OTHER, orcidConfirmMethod: null }); // on file: never sampled
    const first = await (await sample(req({ band: "strong" }))).json();
    expect(first).toMatchObject({ created: true, sample: { total: 50, status: "open" } });
    expect(h.state.samples.some((s) => s.cwid === "s0000")).toBe(false);
    const again = await (await sample(req({ band: "strong" }))).json();
    expect(again).toMatchObject({ created: false, sample: { id: first.sample.id } });
    expect((await sample(req({ band: "moderate" }))).status).toBe(400);
  });

  it("a sampled decision stamps its row; a second decision on it is 409", async () => {
    seedBand(2);
    const s = (await (await sample(req({ band: "strong" }))).json()).sample;
    const row = h.state.samples[0]!;
    h.state.evidence.push({ cwid: row.cwid, orcid: row.orcid, band: "strong" });
    expect(
      (await decide(req({ cwid: row.cwid, orcid: row.orcid, decision: "confirm", sampleId: s.id })))
        .status,
    ).toBe(200);
    expect(row.decision).toBe("confirmed");
    h.state.scholars.set(row.cwid, { orcid: null, orcidConfirmMethod: null });
    const again = await decide(
      req({ cwid: row.cwid, orcid: row.orcid, decision: "dismiss", sampleId: s.id }),
    );
    expect(again.status).toBe(409);
  });

  it("a sampled pair that went on file elsewhere: confirm stamps the row and writes nothing else, so the sample can pass", async () => {
    seedBand(1);
    const s = (await (await sample(req({ band: "strong" }))).json()).sample;
    const row = h.state.samples[0]!;
    h.state.scholars.set(row.cwid, { orcid: row.orcid, orcidConfirmMethod: "self" });
    const res = await decide(
      req({ cwid: row.cwid, orcid: row.orcid, decision: "confirm", sampleId: s.id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyOnFile: true });
    expect(row.decision).toBe("confirmed");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
    expect(sampleStatus(h.state.samples)).toBe("passed");
    // Without a sampleId the same confirm is still a plain 409.
    expect(
      (await decide(req({ cwid: row.cwid, orcid: row.orcid, decision: "confirm" }))).status,
    ).toBe(409);
  });

  it("restart abandons an open sample: a fresh one supersedes it", async () => {
    seedBand(3);
    const first = (await (await sample(req({ band: "strong" }))).json()).sample;
    const again = await (await sample(req({ band: "strong", restart: true }))).json();
    expect(again.created).toBe(true);
    expect(again.sample.id).not.toBe(first.id);
  });

  it("a locked sample is not open: the next call starts a fresh one", async () => {
    seedBand(3);
    h.state.samples = [
      {
        id: "old",
        band: "strong",
        startedAt: new Date(1000),
        cwid: "s0000",
        orcid: ORCID,
        decision: "dismissed",
      },
    ];
    const res = await (await sample(req({ band: "strong" }))).json();
    expect(res.created).toBe(true);
    expect(res.sample.id).not.toBe("old");
  });
});

describe("bulk confirm", () => {
  const passed = (id = "s1", at = 2000) =>
    h.state.samples.push({
      id,
      band: "strong",
      startedAt: new Date(at),
      cwid: "smp0001",
      orcid: ORCID_2,
      decision: "confirmed",
    });

  beforeEach(() => {
    h.state.evidence = [
      { cwid: "a00001", orcid: ORCID, band: "strong" },
      { cwid: "b00001", orcid: ORCID, band: "strong" },
      { cwid: "c00001", orcid: ORCID, band: "strong" },
      { cwid: "smp0001", orcid: ORCID_2, band: "strong" },
    ];
    h.state.scholars = new Map([
      ["a00001", { orcid: null, orcidConfirmMethod: null }],
      ["b00001", { orcid: null, orcidConfirmMethod: null }],
      ["c00001", { orcid: null, orcidConfirmMethod: null }],
      ["smp0001", { orcid: ORCID_2, orcidConfirmMethod: "librarian" }],
    ]);
  });

  it("refuses a stale sample (not the band's latest), an open one and a locked one", async () => {
    passed("s1", 1000);
    passed("s2", 2000);
    const stale = await bulk(req({ band: "strong", sampleId: "s1" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("stale_sample");

    h.state.samples = [
      {
        id: "s3",
        band: "strong",
        startedAt: new Date(3000),
        cwid: "a00001",
        orcid: ORCID,
        decision: null,
      },
    ];
    expect((await (await bulk(req({ band: "strong", sampleId: "s3" }))).json()).error).toBe(
      "sample_not_passed",
    );

    h.state.samples[0]!.decision = "dismissed";
    expect((await (await bulk(req({ band: "strong", sampleId: "s3" }))).json()).error).toBe(
      "sample_locked",
    );
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("confirms every remaining row that still qualifies and skips the ones that changed", async () => {
    passed();
    h.state.dismissals.add(k("b00001", ORCID)); // dismissed since scoring
    // c00001 gets an iD between the read and its write: the WHERE orcid IS NULL write misses.
    const real = h.scholarUpdateMany.getMockImplementation()!;
    h.scholarUpdateMany.mockImplementation(async (args: { where: { cwid: string } }) =>
      args.where.cwid === "c00001" ? { count: 0 } : real(args as never),
    );
    const res = await bulk(req({ band: "strong", sampleId: "s1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, confirmed: 1, skipped: 2 });
    expect(h.state.scholars.get("a00001")!.orcid).toBe(ORCID);
    expect(h.state.scholars.get("b00001")!.orcid).toBeNull();
    const acts = audits();
    expect(acts.filter((a) => a.action === "orcid_librarian_confirm")).toHaveLength(1);
    expect(acts.at(-1)).toMatchObject({
      action: "orcid_bulk_confirm",
      afterValues: { band: "strong", confirmed: 1, skipped: 2 },
    });
    expect(h.appendAuditRow.mock.calls.at(-1)![1]).toMatchObject({
      targetEntityType: "orcid_queue_sample",
      targetEntityId: "s1",
    });
  });

  it("a passed sample is stale once a later ETL run re-scored the band", async () => {
    passed("s1", 2000);
    h.state.evidence[0]!.computedAt = new Date(5000);
    const res = await bulk(req({ band: "strong", sampleId: "s1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stale_sample");
    expect(h.scholarUpdateMany).not.toHaveBeenCalled();
  });

  it("skips a scholar whose only on-file iD is an rpm_admin one", async () => {
    passed();
    h.state.admins = [{ cwid: "a00001", orcid: OTHER }];
    const res = await bulk(req({ band: "strong", sampleId: "s1" }));
    expect(await res.json()).toMatchObject({ confirmed: 2 });
    expect(h.state.scholars.get("a00001")!.orcid).toBeNull();
  });

  it("batches run with a raised transaction timeout; a failed later batch still writes a partial bulk audit row", async () => {
    passed();
    const { db } = await import("@/lib/db");
    const $tx = db.write.$transaction as unknown as ReturnType<typeof vi.fn>;
    const real = $tx.getMockImplementation()!;
    let n = 0;
    $tx.mockImplementation(async (fn: unknown, opts: unknown) => {
      n++;
      if (n === 1) expect(opts).toMatchObject({ timeout: 30000 });
      if (n === 2) throw new Error("Transaction already closed: timeout");
      return real(fn as never, opts as never);
    });
    // Three rows, BATCH 50: one batch, then the final audit fails → partial audit.
    const res = await bulk(req({ band: "strong", sampleId: "s1" }));
    $tx.mockImplementation(real);
    expect(res.status).toBe(500);
    expect(audits().at(-1)).toMatchObject({
      action: "orcid_bulk_confirm",
      afterValues: { band: "strong", confirmed: 3, partial: true },
    });
    expect(h.runAfterResponse).toHaveBeenCalled();
  });

  it("re-reads the band on the writer: a row re-scored into another band is skipped", async () => {
    passed();
    tx.orcidCandidateEvidence.findUnique.mockImplementationOnce(async () => ({ band: "moderate" }));
    const res = await bulk(req({ band: "strong", sampleId: "s1" }));
    expect(await res.json()).toMatchObject({ confirmed: 2 });
  });
});
