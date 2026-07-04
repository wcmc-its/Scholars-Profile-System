import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db.write to expose ONLY $transaction. A stray `db.write.<table>` escaping
// the transaction would throw "Cannot read properties of undefined" here — so
// this test also guards against an un-wrapped delete/insert.
const { txClient, $transaction } = vi.hoisted(() => {
  const model = () => ({
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
  });
  const txClient = {
    personClinicalTrial: model(),
    clinicalTrial: model(),
  };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn(txClient);
  });
  return { txClient, $transaction };
});

vi.mock("@/lib/db", () => ({ db: { write: { $transaction } } }));
vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection: vi.fn() }));

import { replaceAll, type LinkBuild, type TrialBuild } from "@/etl/clinical-trials/shared";

beforeEach(() => {
  vi.clearAllMocks();
  txClient.personClinicalTrial.deleteMany.mockResolvedValue({ count: 3 });
  txClient.clinicalTrial.deleteMany.mockResolvedValue({ count: 2 });
});

describe("clinical-trials replaceAll", () => {
  it("runs delete + insert through ONE transaction client in FK-safe order", async () => {
    const trials = [{ protocolNumber: "P1" }] as unknown as TrialBuild[];
    const links = [{ cwid: "abc", protocolNumber: "P1" }] as unknown as LinkBuild[];

    const res = await replaceAll(trials, links);

    // Everything ran inside a single interactive transaction.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(txClient.clinicalTrial.createMany).toHaveBeenCalledWith({ data: trials });
    expect(txClient.personClinicalTrial.createMany).toHaveBeenCalledWith({ data: links });

    // Children-first delete, parents-first insert (FK order preserved in-tx).
    const delChild = txClient.personClinicalTrial.deleteMany.mock.invocationCallOrder[0];
    const delParent = txClient.clinicalTrial.deleteMany.mock.invocationCallOrder[0];
    const insParent = txClient.clinicalTrial.createMany.mock.invocationCallOrder[0];
    const insChild = txClient.personClinicalTrial.createMany.mock.invocationCallOrder[0];
    expect(delChild).toBeLessThan(delParent);
    expect(delParent).toBeLessThan(insParent);
    expect(insParent).toBeLessThan(insChild);

    // Counts come back from the tx deletes/inserts.
    expect(res).toEqual({ insTrials: 1, insLinks: 1, delLinks: 3, delTrials: 2 });
  });
});
