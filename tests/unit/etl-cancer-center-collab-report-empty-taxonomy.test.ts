/**
 * `etl/cancer-center-collab-report` truncates and reloads `CenterCollabCandidate`
 * per center. Against an EMPTY cancer taxonomy every paper scores as not
 * cancer-relevant, so that reload would wipe good rows with a degraded read.
 * The step must throw before any delete/write instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  run: null as Promise<unknown> | null,
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  transaction: vi.fn(),
  centerFindMany: vi.fn(async () => [{ code: "MCC" }]),
}));

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      cancerTaxonomyDescriptor: { findMany: vi.fn(async () => []) },
      meshDescriptor: { findMany: vi.fn(async () => []) },
      center: { findMany: h.centerFindMany },
      scholar: { findMany: vi.fn(async () => [{ cwid: "abc1234" }]) },
      centerMembership: { findMany: vi.fn(async () => []) },
      publicationAuthor: { findMany: vi.fn(async () => []) },
      centerCollabCandidate: { deleteMany: h.deleteMany, createMany: h.createMany },
      $transaction: h.transaction,
    },
  },
  disconnect: vi.fn(async () => {}),
}));
vi.mock("@/lib/etl-run", () => ({
  withEtlRun: (_name: string, fn: () => Promise<unknown>) => {
    h.run = fn();
    return h.run;
  },
}));

afterEach(() => vi.restoreAllMocks());

describe("cancer-center-collab-report with an empty cancer taxonomy", () => {
  it("throws a clear error and never deletes or writes candidate rows", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await import("@/etl/cancer-center-collab-report/index");
    await expect(h.run).rejects.toThrow("cancer taxonomy is empty; run etl:cancer-taxonomy first");
    // let the module's own .catch run
    await new Promise((r) => setTimeout(r, 0));

    expect(exit).toHaveBeenCalledWith(1);
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
