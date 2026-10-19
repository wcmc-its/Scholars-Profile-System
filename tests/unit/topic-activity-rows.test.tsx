/**
 * TOPIC_FEED_GRANTS_TRIALS — the Activities feed's grant and trial rows
 * (components/taxonomy/activity-rows.tsx, Activities Redesign mockup).
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ActivityGrantRow,
  ActivityTrialRow,
  grantAwardLabel,
} from "@/components/taxonomy/activity-rows";
import type { TopicGrantActivityHit, TopicTrialActivityHit } from "@/lib/api/topic-activity";

const person = (i: number, role: string, roleCategory = "full_time_faculty") => ({
  cwid: `c${i}`,
  slug: `person-${i}`,
  preferredName: `Person ${i}`,
  role,
  identityImageEndpoint: "",
  roleCategory,
});

const grant = (over: Partial<TopicGrantActivityHit> = {}): TopicGrantActivityHit => ({
  projectId: "ACCT-1",
  title: "Stem cell fitness in a test disease",
  primeSponsor: "NCI",
  primeSponsorRaw: "National Cancer Institute",
  directSponsor: null,
  isSubaward: false,
  programType: "Grant",
  mechanism: "R01",
  nihIc: "NCI",
  awardNumber: "5R01CA000001-04",
  startDate: "2023-01-01",
  endDate: "2027-12-31",
  isActive: true,
  status: "active",
  isMultiPi: false,
  people: [person(1, "PI")],
  totalPeople: 1,
  department: null,
  pubCount: 0,
  abstract: null,
  abstractSource: null,
  applId: null,
  publications: [],
  coreProjectNum: null,
  titleHighlight: null,
  matchedLiteralTitle: false,
  matchedConcept: false,
  matchedFundedPubs: 0,
  textEvidence: null,
  areaScore: 0.8,
  ...over,
});

const trial = (over: Partial<TopicTrialActivityHit> = {}): TopicTrialActivityHit => ({
  trialId: "NCT00000001",
  nctNumber: "NCT00000001",
  title: "A Phase 2 Study of a Test Drug",
  status: "OPEN TO ACCRUAL",
  statusBucket: "active",
  phase: "2",
  studyType: "INTERVENTIONAL",
  sponsorClass: "industry",
  principalSponsor: "Test Pharma",
  pis: [{ cwid: "c1", name: "Person 1", slug: "person-1" }],
  conditions: "Condition A; Condition B",
  statusKey: "recruiting",
  startDate: "2024-08",
  startEstimated: false,
  endDate: "2027-06",
  endEstimated: true,
  interventions: "Drug: Alpha; Drug: Beta",
  hasResults: false,
  matchedConcept: false,
  matchedFields: [],
  areaScore: 0.8,
  ...over,
});

describe("grantAwardLabel", () => {
  it("spaces the mechanism from the serial and drops the type digit", () => {
    expect(grantAwardLabel("5R01CA000001-04", "R01")).toBe("R01 CA000001-04");
    expect(grantAwardLabel("P01 CA000002-17", "P01")).toBe("P01 CA000002-17");
    expect(grantAwardLabel("HT9425-23-1-0431", null)).toBe("HT9425-23-1-0431");
  });
});

describe("ActivityGrantRow", () => {
  it("status pill, years, award, linked title, people with roles, funder via direct sponsor", () => {
    render(
      <ActivityGrantRow
        hit={grant({
          isSubaward: true,
          directSponsor: "Other University",
          isMultiPi: true,
          people: [person(1, "PI"), person(2, "Co-PI"), person(3, "Co-I", "fellow_f31")],
          totalPeople: 3,
        })}
        applId={123}
      />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("2023–2027")).toBeTruthy();
    expect(screen.getByText("R01 CA000001-04")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Stem cell fitness in a test disease" })
        .getAttribute("href"),
    ).toBe("https://reporter.nih.gov/project-details/123");
    expect(screen.getByRole("link", { name: "Person 1" }).getAttribute("href")).toMatch(/person-1/);
    expect(screen.getByText(/Person 1/).closest("span")!.textContent).toBe("Person 1 (MPI), ");
    // A hidden identity class keeps its name, without a profile link.
    expect(screen.queryByRole("link", { name: "Person 3" })).toBeNull();
    expect(screen.getByText(/Person 3 \(Co-I\)/)).toBeTruthy();
    expect(screen.getByText("National Cancer Institute · via Other University")).toBeTruthy();
    // Nothing to expand.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ending soon and ended pills; a title with no RePORTER id is plain", () => {
    const { rerender } = render(<ActivityGrantRow hit={grant({ status: "ending_soon" })} />);
    expect(screen.getByText("Ending soon").className).toContain("amber");
    expect(screen.queryByRole("link", { name: /Stem cell/ })).toBeNull();
    rerender(<ActivityGrantRow hit={grant({ status: "recently_ended" })} />);
    expect(screen.getByText("Ended")).toBeTruthy();
  });

  it("four people, then +N more", () => {
    const people = [1, 2, 3, 4, 5].map((i) => person(i, "Co-I"));
    render(<ActivityGrantRow hit={grant({ people, totalPeople: 7 })} />);
    expect(screen.queryByRole("link", { name: "Person 5" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }));
    expect(screen.getByRole("link", { name: "Person 5" })).toBeTruthy();
    expect(screen.getByText("+2 more", { exact: false })).toBeTruthy();
  });

  it("Abstract & N publications opens the abstract and the papers", () => {
    const publications = Array.from({ length: 6 }, (_, i) => ({
      pmid: `${100 + i}`,
      title: `Paper ${i}`,
      journal: "J Test",
      year: 2025,
      citationCount: 0,
      isLowerConfidence: false,
    }));
    render(
      <ActivityGrantRow hit={grant({ abstract: "An abstract.", pubCount: 6, publications })} />,
    );
    const toggle = screen.getByRole("button", { name: "Abstract & 6 publications" });
    expect(screen.queryByText("An abstract.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("An abstract.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Paper 0" }).getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/100/",
    );
    expect(screen.queryByRole("link", { name: "Paper 5" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(screen.getByRole("link", { name: "Paper 5" })).toBeTruthy();
  });
});

describe("ActivityTrialRow", () => {
  it("status pill, type · phase, NCT link, linked title, PI · dates · sponsor", () => {
    render(<ActivityTrialRow hit={trial()} />);
    expect(screen.getByText("Recruiting").className).toContain("slate");
    expect(screen.getByText("Interventional · Phase 2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "NCT00000001 ↗" }).getAttribute("href")).toBe(
      "https://clinicaltrials.gov/study/NCT00000001",
    );
    expect(screen.getByRole("link", { name: "A Phase 2 Study of a Test Drug" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Person 1" }).getAttribute("href")).toMatch(/person-1/);
    expect(screen.getByText("Aug 2024 – Jun 2027 (est.)")).toBeTruthy();
    expect(screen.getByText("Test Pharma")).toBeTruthy();
    expect(screen.queryByText("Results posted")).toBeNull();
  });

  it("a non-recruiting status is grey; results posted links to the CT.gov results tab", () => {
    render(<ActivityTrialRow hit={trial({ statusKey: "completed", hasResults: true })} />);
    expect(screen.getByText("Completed").className).not.toContain("slate");
    expect(screen.getByRole("link", { name: "Results posted" }).getAttribute("href")).toBe(
      "https://clinicaltrials.gov/study/NCT00000001?tab=results",
    );
  });

  it("Intervention & N conditions opens the interventions and condition chips", () => {
    render(<ActivityTrialRow hit={trial()} />);
    expect(screen.queryByText("Condition A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Intervention & 2 conditions" }));
    expect(screen.getByText("Drug: Alpha · Drug: Beta")).toBeTruthy();
    expect(screen.getByText("Condition A")).toBeTruthy();
    expect(screen.getByText("Condition B")).toBeTruthy();
  });

  it("the toggle names only what the trial has", () => {
    const { rerender } = render(
      <ActivityTrialRow hit={trial({ interventions: null, conditions: "Condition A" })} />,
    );
    expect(screen.getByRole("button", { name: "1 condition" })).toBeTruthy();
    rerender(<ActivityTrialRow hit={trial({ interventions: null, conditions: "" })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
