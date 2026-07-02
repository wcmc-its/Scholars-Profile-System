import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, update } = vi.hoisted(() => ({
  create: vi.fn(async (_args: unknown) => ({ id: 7 })),
  update: vi.fn(async (_args: unknown) => ({})),
}));
vi.mock("@/lib/db", () => ({
  db: { write: { etlRun: { create, update } } },
}));

import { withEtlRun } from "@/lib/etl-run";

beforeEach(() => {
  create.mockClear();
  update.mockClear();
});

describe("withEtlRun", () => {
  it("records running -> success and rowsProcessed from a numeric result", async () => {
    await withEtlRun("TestSource", async () => 42);
    expect(create).toHaveBeenCalledWith({
      data: { source: "TestSource", status: "running" },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as {
      where: { id: number };
      data: { status: string; rowsProcessed?: number };
    };
    expect(arg.where).toEqual({ id: 7 });
    expect(arg.data.status).toBe("success");
    expect(arg.data.rowsProcessed).toBe(42);
  });

  it("leaves rowsProcessed unset for a void result", async () => {
    await withEtlRun("TestSource", async () => {});
    const arg = update.mock.calls[0][0] as { data: { rowsProcessed?: number } };
    expect(arg.data.rowsProcessed).toBeUndefined();
  });

  it("records failed with the error message and re-throws", async () => {
    const boom = new Error("upstream exploded");
    await expect(
      withEtlRun("TestSource", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const arg = update.mock.calls[0][0] as {
      data: { status: string; errorMessage?: string };
    };
    expect(arg.data.status).toBe("failed");
    expect(arg.data.errorMessage).toBe("upstream exploded");
  });
});
