import { describe, it, expect } from "vitest";
import { buildDepositsAndLinks, depositId, type SourceRow } from "@/etl/data-sharing/shared";

const NOW = new Date("2026-06-19T00:00:00.000Z");

function row(p: Partial<SourceRow>): SourceRow {
  return {
    cwid: null,
    repository: null,
    accessionOrDoi: null,
    resourceType: null,
    dataType: null,
    accessModel: null,
    depositYear: null,
    provenance: null,
    confidence: null,
    authorPosition: null,
    pmid: null,
    ...p,
  };
}

describe("depositId", () => {
  it("is a 64-char lowercase hex string (fits VarChar(64))", () => {
    const id = depositId("Dryad", "10.5061/dryad.abc123");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different ids for different (repository, accessionOrDoi) pairs", () => {
    expect(depositId("Dryad", "10.5061/dryad.abc123")).not.toBe(
      depositId("Dryad", "10.5061/dryad.xyz789"),
    );
    expect(depositId("Dryad", "10.5061/dryad.abc123")).not.toBe(
      depositId("GEO", "10.5061/dryad.abc123"),
    );
  });
});

describe("buildDepositsAndLinks", () => {
  const scholars = new Map<string, string>([["abc1234", "abc1234"]]);

  it("assigns the SAME deposit id across two full-replace runs for the same (repository, accessionOrDoi) — regression test for the UUID-churn bug", () => {
    const rows: SourceRow[] = [
      row({
        cwid: "abc1234",
        repository: "Dryad",
        accessionOrDoi: "10.5061/dryad.abc123",
        pmid: "111",
      }),
    ];

    const first = buildDepositsAndLinks(rows, scholars, NOW);
    const second = buildDepositsAndLinks(rows, scholars, NOW);

    expect(first.deposits).toHaveLength(1);
    expect(second.deposits).toHaveLength(1);
    expect(first.deposits[0].id).toBe(second.deposits[0].id);
    expect(first.links[0].datasetId).toBe(second.links[0].datasetId);
  });

  it("gives different (repository, accessionOrDoi) pairs different deposit ids", () => {
    const rows: SourceRow[] = [
      row({ cwid: "abc1234", repository: "Dryad", accessionOrDoi: "10.5061/dryad.abc123" }),
      row({ cwid: "abc1234", repository: "GEO", accessionOrDoi: "GSE12345" }),
    ];

    const { deposits } = buildDepositsAndLinks(rows, scholars, NOW);

    expect(deposits).toHaveLength(2);
    expect(deposits[0].id).not.toBe(deposits[1].id);
  });
});
