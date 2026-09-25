/**
 * An in-memory `honor_list_run` that enforces the one constraint the run lock
 * rests on: `active_list_id` is UNIQUE (NULLs exempt), and a violating insert
 * throws Prisma's P2002. Every call yields to the event loop first, so two
 * concurrent callers genuinely interleave: a read-then-insert guard would let
 * both through; only the constraint stops the second.
 */
export type FakeRun = {
  id: string;
  listId: string;
  trigger: string;
  requestedByCwid: string | null;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  activeListId: string | null;
  createdAt: Date;
};

type Where = Record<string, unknown>;

function matches(row: FakeRun, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const actual = row[k as keyof FakeRun];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { lt?: Date; gte?: Date; in?: unknown[] };
      if (op.lt && !(actual instanceof Date && actual < op.lt)) return false;
      if (op.gte && !(actual instanceof Date && actual >= op.gte)) return false;
      if (op.in && !op.in.includes(actual)) return false;
      return true;
    }
    return actual === v;
  });
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export function fakeHonorListRuns() {
  const rows: FakeRun[] = [];
  let seq = 0;
  const honorListRun = {
    async create({ data }: { data: Partial<FakeRun> }) {
      await tick();
      if (data.activeListId != null && rows.some((r) => r.activeListId === data.activeListId)) {
        throw Object.assign(new Error("Unique constraint failed: active_list_id"), {
          code: "P2002",
        });
      }
      const row: FakeRun = {
        id: `run-${++seq}`,
        listId: "",
        trigger: "schedule",
        requestedByCwid: null,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        activeListId: null,
        createdAt: new Date(),
        ...data,
      } as FakeRun;
      rows.push(row);
      return { id: row.id };
    },
    async updateMany({ where, data }: { where: Where; data: Partial<FakeRun> }) {
      await tick();
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    async update({ where, data }: { where: { id: string }; data: Partial<FakeRun> }) {
      await tick();
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(r, data);
      return r;
    },
  };
  return { rows, honorListRun };
}
