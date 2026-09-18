/**
 * #2653 — `scripts/biosketch-harness.ts` metric functions, on fixtures. The runner (`main`)
 * needs the DB + Bedrock and is not exercised; importing the module touches neither (its
 * runtime dependencies are lazy-imported inside `main`).
 */
import { describe, expect, it } from "vitest";

import {
  citedLabels,
  compareVersions,
  countEmDashes,
  countSentences,
  countUrls,
  csvCell,
  estimateRunCostUsd,
  leadSentence,
  measureRun,
  parseArgs,
  percentile,
  roleSeparationCsvs,
  seededOrder,
  summarizeVersion,
  toCsv,
  type HarnessRun,
} from "@/scripts/biosketch-harness";
import type { BiosketchProductRef } from "@/lib/edit/biosketch-references";

const REFS: BiosketchProductRef[] = [
  { key: "P1", pmid: "11", label: "Smith 2019", title: "Alpha", year: 2019 },
  { key: "P2", pmid: "22", label: "PMID 22", title: "Beta", year: null },
];

describe("text counters", () => {
  it("counts em dashes, URLs and sentences", () => {
    expect(countEmDashes("a — b — c - d – e")).toBe(2);
    expect(countUrls("see https://a.org/x and www.b.org, doi:10.1/z.")).toBe(3);
    expect(countSentences("One. Two! Three? Four")).toBe(3);
    expect(countSentences("fragment with no terminal mark")).toBe(1);
    expect(countSentences("   ")).toBe(0);
    // an abbreviation mid-sentence is not a boundary (no whitespace after the dot)
    expect(countSentences("Reduced by 3.5 percent. Done.")).toBe(2);
  });

  it("leadSentence takes the first terminal-punctuated sentence", () => {
    expect(leadSentence("  I lead the vector work (Smith 2019). Then more.")).toBe(
      "I lead the vector work (Smith 2019).",
    );
    expect(leadSentence("no terminal")).toBe("no terminal");
  });

  it("citedLabels lists the referenced products in order of first use", () => {
    expect(citedLabels("B (PMID 22) then A (Smith 2019) then (PMID 22) again.", REFS)).toEqual([
      "PMID 22",
      "Smith 2019",
    ]);
    expect(citedLabels("nothing cited", REFS)).toEqual([]);
    // a grouped reference: the second label follows a semicolon
    expect(citedLabels("Both (PMID 22; Smith 2019).", REFS)).toEqual(["PMID 22", "Smith 2019"]);
  });
});

describe("estimateRunCostUsd", () => {
  it("prices ~4 chars per token through the supplied price function", () => {
    const calls: unknown[] = [];
    const price = (_m: string, o: { inputTokens: number; outputTokens: number }) => {
      calls.push(o);
      return 0.5;
    };
    expect(estimateRunCostUsd(price, "m", 4000, 801)).toBe(0.5);
    expect(calls).toEqual([{ inputTokens: 1000, outputTokens: 201 }]);
  });
});

describe("measureRun", () => {
  const base = {
    cwid: "c1",
    version: "v8" as const,
    mode: "personal_statement" as const,
    role: "pd_pi" as const,
    latencyMs: 1200,
    costUsd: 0.04,
  };

  it("reads v8's validator report for the raw counts and scans the final text", () => {
    const run = measureRun(
      base,
      {
        entries: [{ title: "", body: "Claim one (Smith 2019). Claim two. Claim — three." }],
        removed: [{ span: "x", category: "number", reason: "" }],
        references: {
          kept: 1,
          issues: [
            { span: "[P9]", kind: "out_of_list", action: "stripped" },
            { span: "https://x", kind: "url", action: "stripped" },
            { span: "2019;12", kind: "full_citation", action: "flagged" },
          ],
        },
      },
      REFS,
    );
    expect(run.sentences).toBe(3);
    expect(run.removedSpans).toBe(1);
    expect(run.unsupportedClaimRate).toBeCloseTo(1 / 3);
    expect(run.emDashes).toBe(1);
    expect(run.outOfListRaw).toBe(1);
    expect(run.urlsRaw).toBe(1);
    expect(run.fullCitationTells).toBe(1);
    expect(run.outOfListFinal).toBe(0);
    expect(run.urlsFinal).toBe(0);
    expect(run.referencesKept).toBe(1);
  });

  it("for v7 (no validator) the raw counts are the final scan of the text", () => {
    const run = measureRun(
      { ...base, version: "v7" },
      {
        entries: [{ title: "", body: "Claim (Jones 2020) at https://x.org/y. Fine (Smith 2019)." }],
        removed: [],
        references: null,
      },
      REFS,
    );
    expect(run.outOfListRaw).toBe(1);
    expect(run.outOfListFinal).toBe(1);
    expect(run.urlsRaw).toBe(1);
    expect(run.urlsFinal).toBe(1);
    expect(run.referencesKept).toBe(0);
    expect(run.unsupportedClaimRate).toBe(0);
  });
});

describe("percentile + summarizeVersion + compareVersions", () => {
  const run = (over: Partial<HarnessRun>): HarnessRun => ({
    cwid: "c",
    version: "v7",
    mode: "personal_statement",
    role: "pd_pi",
    latencyMs: 1000,
    costUsd: 0.1,
    chars: 100,
    sentences: 10,
    removedSpans: 0,
    unsupportedClaimRate: 0,
    emDashes: 0,
    outOfListRaw: 0,
    urlsRaw: 0,
    fullCitationTells: 0,
    outOfListFinal: 0,
    urlsFinal: 0,
    referencesKept: 0,
    ...over,
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 50)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it("summarizes one version's runs only", () => {
    const runs = [
      run({ latencyMs: 1000, costUsd: 0.1, unsupportedClaimRate: 0.1, emDashes: 1 }),
      run({ latencyMs: 3000, costUsd: 0.3, unsupportedClaimRate: 0.3, outOfListRaw: 2 }),
      run({ version: "v8", latencyMs: 99999, costUsd: null }),
    ];
    const s = summarizeVersion("v7", runs);
    expect(s).toEqual({
      version: "v7",
      runs: 2,
      unsupportedClaimRateMean: 0.2,
      outOfListRaw: 2,
      outOfListFinal: 0,
      urlsRaw: 0,
      urlsFinal: 0,
      fullCitationTells: 0,
      emDashes: 1,
      latencyP50: 1000,
      latencyP95: 3000,
      costP50: 0.1,
      costP95: 0.3,
    });
    // a null cost is left out of the cost percentiles rather than poisoning them
    expect(Number.isNaN(summarizeVersion("v8", runs).costP50)).toBe(true);
  });

  it("applies the issue's gate: zeros for the candidate, ±10% cost/latency, rate not rising", () => {
    const v7 = summarizeVersion("v7", [
      run({ latencyMs: 1000, costUsd: 0.1, unsupportedClaimRate: 0.2 }),
    ]);
    const pass = summarizeVersion("v8", [
      run({
        version: "v8",
        latencyMs: 1100,
        costUsd: 0.11,
        unsupportedClaimRate: 0.2,
        outOfListRaw: 3,
      }),
    ]);
    expect(compareVersions(v7, pass).every((g) => g.pass)).toBe(true);

    const fail = summarizeVersion("v8", [
      run({
        version: "v8",
        latencyMs: 1101,
        costUsd: 0.1,
        unsupportedClaimRate: 0.21,
        outOfListFinal: 1,
        urlsFinal: 1,
        emDashes: 1,
      }),
    ]);
    const verdict = Object.fromEntries(compareVersions(v7, fail).map((g) => [g.name, g.pass]));
    expect(verdict["unsupported-claim rate does not rise"]).toBe(false);
    expect(verdict["out-of-list references in final text are zero"]).toBe(false);
    expect(verdict["URLs in final text are zero"]).toBe(false);
    expect(verdict["em-dash count is zero"]).toBe(false);
    expect(verdict["latency p50 within +10%"]).toBe(false);
    expect(verdict["cost p50 within +10%"]).toBe(true);
    // no runs → NaN percentiles fail rather than pass vacuously
    const empty = summarizeVersion("v8", []);
    expect(compareVersions(v7, empty).find((g) => g.name === "latency p50 within +10%")!.pass).toBe(
      false,
    );
  });
});

describe("role separation CSVs", () => {
  it("quotes CSV cells that need it", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "quoted", cell')).toBe('"a ""quoted"", cell"');
    expect(toCsv(["a", "b"], [["1", "x,y"]])).toBe('a,b\n1,"x,y"\n');
  });

  it("seededOrder is a deterministic permutation", () => {
    const a = seededOrder(6, 42);
    expect([...a].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seededOrder(6, 42)).toEqual(a);
    expect(seededOrder(6, 43)).not.toEqual(a);
  });

  it("blinds the drafts (no role column), keys them, and reports per-cwid distinctness", () => {
    const drafts = [
      {
        cwid: "c1",
        role: "pd_pi" as const,
        text: "I will lead this. More.",
        cited: ["Smith 2019"],
      },
      {
        cwid: "c1",
        role: "co_investigator" as const,
        text: "I bring assays. More.",
        cited: ["PMID 22"],
      },
      {
        cwid: "c1",
        role: "mentor_sponsor" as const,
        text: "I train people. More.",
        cited: ["PMID 22"],
      },
    ];
    const { blinded, key, distinct } = roleSeparationCsvs(drafts, 7);
    const blindedLines = blinded.trim().split("\n");
    expect(blindedLines[0]).toBe("id,lead_sentence,cited_records,text");
    expect(blindedLines.length).toBe(4);
    expect(blinded).not.toContain("pd_pi");
    expect(blinded).not.toContain("mentor_sponsor");
    const keyLines = key.trim().split("\n");
    expect(keyLines[0]).toBe("id,cwid,role");
    // every id in the blinded file has exactly one key row, and the key names each role once
    const ids = blindedLines.slice(1).map((l) => l.split(",")[0]);
    expect(keyLines.slice(1).map((l) => l.split(",")[0])).toEqual(ids);
    expect(
      keyLines
        .slice(1)
        .map((l) => l.split(",")[2])
        .sort(),
    ).toEqual(["co_investigator", "mentor_sponsor", "pd_pi"]);
    // lead sentences all differ; cited records collide (two drafts cite the same product)
    expect(distinct).toEqual([{ cwid: "c1", leadSentences: true, cited: false }]);
  });
});

describe("parseArgs", () => {
  it("reads the flags with the documented defaults", () => {
    expect(
      parseArgs(["--cwids=a, b", "--out=/tmp/x", "--title=T", "--aims=A", "--no-faithfulness"]),
    ).toEqual({
      cwids: ["a", "b"],
      versions: ["v7", "v8"],
      out: "/tmp/x",
      mode: "personal_statement",
      title: "T",
      aims: "A",
      role: "pd_pi",
      separationCwid: null,
      faithfulness: false,
    });
    expect(
      parseArgs(["--versions=v6,v8", "--role=candidate", "--separation-cwid=z", "--mode=both"]),
    ).toMatchObject({
      versions: ["v6", "v8"],
      role: "candidate",
      separationCwid: "z",
      mode: "both",
      faithfulness: true,
    });
  });
});
