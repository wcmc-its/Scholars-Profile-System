import { describe, it, expect } from "vitest";
import {
  buildDepositsAndLinks,
  depositId,
  nonEmpty,
  type SourceRow,
} from "@/etl/data-sharing/shared";

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

describe("nonEmpty", () => {
  // Regression test: reciterdb.dataset_deposit.pmid is INT(11), not VARCHAR —
  // the mariadb driver hands buildDepositsAndLinks a real JS number for it.
  // nonEmpty used to assume a string and crash the whole weekly run
  // (TypeError: (s ?? "").trim is not a function) the first time it saw one.
  it("coerces a non-string value instead of throwing", () => {
    expect(nonEmpty(12345678)).toBe("12345678");
    expect(nonEmpty(0)).toBe("0");
  });

  it("still treats null/undefined/blank as empty", () => {
    expect(nonEmpty(null)).toBeNull();
    expect(nonEmpty(undefined)).toBeNull();
    expect(nonEmpty("  ")).toBeNull();
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

  it("doesn't crash on a numeric pmid (defense-in-depth if the CAST(pmid AS CHAR) in readSourceRows is ever lost)", () => {
    const rows: SourceRow[] = [
      // @ts-expect-error — deliberately simulating the raw driver value SourceRow's
      // type claims can't happen but does, pre-CAST (pmid is INT(11) in reciterdb).
      row({ cwid: "abc1234", repository: "Dryad", accessionOrDoi: "10.5061/dryad.abc123", pmid: 111 }),
    ];

    const { links } = buildDepositsAndLinks(rows, scholars, NOW);

    expect(links[0].pmids).toEqual(["111"]);
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
