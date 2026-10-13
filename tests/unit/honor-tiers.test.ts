import { describe, expect, it } from "vitest";

import { honorTier, ruleTier } from "@/lib/honors/tiers";

describe("ruleTier — the honor, not just its conferring body", () => {
  it.each([
    // Every (organization, name) pair the seed and roster lists write today.
    ["Nobel Foundation", "Nobel Prize in Physiology or Medicine", 1],
    ["Lasker Foundation", "Albert Lasker Basic Medical Research Award", 1],
    ["National Science Foundation", "National Medal of Science", 1],
    ["Shaw Prize Foundation", "Shaw Prize in Life Science and Medicine", 1],
    ["Columbia University", "Louisa Gross Horwitz Prize", 1],
    ["John D. and Catherine T. MacArthur Foundation", "MacArthur Fellowship", 1],
    ["National Academy of Sciences", "Member", 2],
    ["National Academy of Medicine", "Member", 2],
    ["National Academy of Engineering", "Member", 2],
    ["American Philosophical Society", "Member", 2],
    ["American Academy of Arts and Sciences", "Fellow", 2],
    ["American Academy of Arts & Sciences", "Fellow", 2],
    ["Howard Hughes Medical Institute", "Investigator", 2],
    ["American Society for Clinical Investigation", "Member", 3],
    ["Association of American Physicians", "Member", 3],
    ["National Academy of Inventors", "Fellow", 3],
    ["American Association for the Advancement of Science", "Fellow", 3],
    ["U.S. Government (PECASE)", "PECASE (Presidential Early Career Award)", 4],
    ["Alfred P. Sloan Foundation", "Sloan Research Fellowship", 4],
    ["David and Lucile Packard Foundation", "Packard Fellowship for Science and Engineering", 4],
    ["Pew Charitable Trusts", "Pew Scholar in the Biomedical Sciences", 4],
    ["Searle Scholars Program", "Searle Scholars Program", 4],
    ["Burroughs Wellcome Fund", "Career Award", 4],
    ["Damon Runyon Cancer Research Foundation", "Damon Runyon Fellowship / Grant", 4],
    ["Weill Cornell Medicine", "Joan and Sanford I. Weill Exemplary Achievement Award", 6],
  ] as const)("%s / %s → tier %i", (org, name, tier) => {
    expect(ruleTier(org, name)).toBe(tier);
  });

  it("splits one body across tiers by the honor's name (NSF)", () => {
    expect(ruleTier("National Science Foundation", "National Medal of Science")).toBe(1);
    expect(ruleTier("National Science Foundation", "CAREER Award")).toBe(4);
  });

  it("needs an elected grade for the academy tiers", () => {
    expect(
      ruleTier("National Academy of Medicine", "Emerging Leaders in Health and Medicine Scholar"),
    ).toBe(5);
  });

  it("sinks institutional and media recognition to tier 6", () => {
    expect(ruleTier("Weill Cornell Medicine", "Excellence in Teaching Award")).toBe(6);
    expect(ruleTier("NewYork-Presbyterian Hospital", "Physician of the Year")).toBe(6);
    expect(ruleTier("Castle Connolly", "Top Doctor")).toBe(6);
  });

  it("defaults any other external body to tier 5", () => {
    expect(ruleTier("Radiation Research Society (RRS)", "Marie Curie Award")).toBe(5);
  });
});

describe("honorTier — a curator override wins", () => {
  it("uses the override when it is a tier, the rules otherwise", () => {
    expect(honorTier("National Science Foundation", "CAREER Award", 2)).toBe(2);
    expect(honorTier("National Science Foundation", "CAREER Award", null)).toBe(4);
    expect(honorTier("National Science Foundation", "CAREER Award", 9)).toBe(4);
  });
});
