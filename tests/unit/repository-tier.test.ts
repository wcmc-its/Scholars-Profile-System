import { describe, expect, it } from "vitest";

import { REPO_TIER, REPO_URL, tierOf, urlOf } from "@/lib/repository-tier";

describe("tierOf", () => {
  it("resolves a CONCERN-tier repository", () => {
    expect(tierOf("GSA-Human")).toBe("CONCERN");
    expect(tierOf("GSA")).toBe("CONCERN");
    expect(tierOf("iProX")).toBe("CONCERN");
  });

  it("resolves a FOREIGN_OPEN-tier repository", () => {
    expect(tierOf("Zenodo")).toBe("FOREIGN_OPEN");
    expect(tierOf("figshare")).toBe("FOREIGN_OPEN");
  });

  it("resolves a FOREIGN_CTRL-tier repository", () => {
    expect(tierOf("EGA")).toBe("FOREIGN_CTRL");
  });

  it("resolves US_OPEN and US_CTRL tiers", () => {
    expect(tierOf("GEO")).toBe("US_OPEN");
    expect(tierOf("dbGaP")).toBe("US_CTRL");
  });

  it("resolves REGISTRY-tier repositories", () => {
    expect(tierOf("ClinicalTrials.gov")).toBe("REGISTRY");
    expect(tierOf("CTRI")).toBe("REGISTRY");
    expect(tierOf("PDB")).toBe("REGISTRY");
  });

  it("returns UNKNOWN for a repository not in the catalog.py port", () => {
    expect(tierOf("Some Repository Nobody Has Heard Of")).toBe("UNKNOWN");
    expect(tierOf("")).toBe("UNKNOWN");
  });

  it("is exact-match, case-sensitive (repository is always the canonical name at rest)", () => {
    expect(tierOf("geo")).toBe("UNKNOWN");
    expect(tierOf("Geo")).toBe("UNKNOWN");
  });

  it("carries all 36 catalog.py repositories", () => {
    expect(Object.keys(REPO_TIER)).toHaveLength(36);
  });

  it("has exactly 5 CONCERN-tier entries, matching catalog.py's R list", () => {
    const concernCount = Object.values(REPO_TIER).filter((t) => t === "CONCERN").length;
    expect(concernCount).toBe(5);
  });
});

describe("urlOf", () => {
  it("resolves a known repository's homepage", () => {
    expect(urlOf("Dryad")).toBe("https://datadryad.org/");
    expect(urlOf("GEO")).toBe("https://www.ncbi.nlm.nih.gov/geo/");
  });

  it("returns null for a repository not in the catalog.py port", () => {
    expect(urlOf("Some Repository Nobody Has Heard Of")).toBeNull();
    expect(urlOf("")).toBeNull();
  });

  it("carries a url for all 36 catalog.py repositories, same key set as REPO_TIER", () => {
    expect(Object.keys(REPO_URL)).toHaveLength(36);
    expect(Object.keys(REPO_URL).sort()).toEqual(Object.keys(REPO_TIER).sort());
  });

  it("every url is a well-formed http(s) link", () => {
    for (const url of Object.values(REPO_URL)) {
      expect(url).toMatch(/^https?:\/\//);
    }
  });
});
