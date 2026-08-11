import { describe, it, expect } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  buildDepositsAndLinks,
  depositId,
  nonEmpty,
  parseJsonArray,
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
    title: null,
    description: null,
    creators: null,
    publisher: null,
    trialPhase: null,
    trialStatus: null,
    trialConditions: null,
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

describe("parseJsonArray", () => {
  // reciterdb.dataset_deposit.creators/trial_conditions are declared JSON, but
  // MariaDB implements JSON as a LONGTEXT alias — the mariadb driver hands
  // readSourceRows() back a JSON-encoded string, not a parsed array.
  it("parses a JSON-encoded array string", () => {
    expect(parseJsonArray('["Jane Doe","John Smith"]')).toEqual(["Jane Doe", "John Smith"]);
  });

  it("treats null/empty/malformed input as null instead of throwing", () => {
    expect(parseJsonArray(null)).toBeNull();
    expect(parseJsonArray("")).toBeNull();
    expect(parseJsonArray("not json")).toBeNull();
    expect(parseJsonArray('{"not":"an array"}')).toBeNull();
  });
});

describe("buildDepositsAndLinks", () => {
  it("carries the #2350 Phase 2 title/metadata fields through to the built deposit, JSON-decoding creators/trialConditions", () => {
    const rows: SourceRow[] = [
      row({
        cwid: "abc1234",
        repository: "ClinicalTrials.gov",
        accessionOrDoi: "NCT03815682",
        title: "RPTR-147 in Patients With Selected Solid Tumors and Lymphomas",
        trialPhase: "PHASE1",
        trialStatus: "TERMINATED",
        trialConditions: '["Solid Tumor","Lymphoma"]',
      }),
    ];

    const { deposits } = buildDepositsAndLinks(rows, new Map([["abc1234", "abc1234"]]), NOW);

    expect(deposits).toHaveLength(1);
    expect(deposits[0].title).toBe("RPTR-147 in Patients With Selected Solid Tumors and Lymphomas");
    expect(deposits[0].trialPhase).toBe("PHASE1");
    expect(deposits[0].trialStatus).toBe("TERMINATED");
    expect(deposits[0].trialConditions).toEqual(["Solid Tumor", "Lymphoma"]);
    // No DataCite fields on a CT.gov row — absent, not a bare `null` (Prisma
    // rejects bare `null` for a nullable Json column in createMany).
    expect(deposits[0].description).toBeNull();
    expect(deposits[0].creators).toBe(Prisma.DbNull);
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

  it("dedupes an accessionOrDoi that differs only by case — regression test for the DOI-case unique-constraint collision", () => {
    // Real data: scan2.py's databank vs. full-text-scan paths captured the
    // same Zenodo DOI as "10.5281/ZENODO.3576630" and "10.5281/zenodo.3576630".
    // DatasetDeposit's unique index is case-insensitive (utf8mb4_unicode_ci,
    // matching reciterdb), so these must collapse to ONE deposit here too —
    // pre-fix, they built as two and crashed the insert with P2002.
    const rows: SourceRow[] = [
      row({ cwid: "abc1234", repository: "Zenodo", accessionOrDoi: "10.5281/ZENODO.3576630" }),
      row({ cwid: "abc1234", repository: "Zenodo", accessionOrDoi: "10.5281/zenodo.3576630" }),
    ];

    const { deposits, links, stats } = buildDepositsAndLinks(rows, scholars, NOW);

    expect(deposits).toHaveLength(1);
    expect(deposits[0].accessionOrDoi).toBe("10.5281/zenodo.3576630");
    expect(links).toHaveLength(1);
    expect(stats.deposits).toBe(1);
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
