/**
 * #3368: profile links must never prefetch. The Usage rollup counts every
 * `?_rsc=` request to a profile path as a real in-app click; a prefetching
 * profile <Link> would put prefetches (clicked or not) back into that count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const linkProps: Array<Record<string, unknown>> = [];
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    linkProps.push(props);
    return <a href={String(props.href)}>{props.children}</a>;
  },
}));
vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import { TrialResultRow } from "@/components/search/trial-result-row";
import type { PeopleHit } from "@/lib/api/search";
import type { TrialHit } from "@/lib/api/search-trials";

const profileLinks = (slug: string) =>
  linkProps.filter((p) => String(p.href).startsWith(`/${slug}`));

beforeEach(() => {
  linkProps.length = 0;
});

describe("profile links do not prefetch", () => {
  it("PeopleResultCard: the stretched name link", () => {
    const hit: PeopleHit = {
      cwid: "abc1234",
      slug: "jane-doe",
      preferredName: "Jane Doe",
      primaryTitle: "Professor of Medicine",
      primaryDepartment: "Medicine",
      deptName: "Medicine",
      divisionName: null,
      roleCategory: "full_time_faculty",
      pubCount: 100,
      grantCount: 0,
      hasActiveGrants: false,
      identityImageEndpoint: "https://example.com/abc1234.png",
      evidenceLines: [{ kind: "none" }],
    };
    render(
      <PeopleResultCard
        hit={hit}
        q=""
        position={0}
        total={1}
        filters={{ deptDiv: [], personType: [], activity: [] }}
      />,
    );
    const links = profileLinks("jane-doe");
    expect(links.length).toBeGreaterThan(0);
    for (const p of links) expect(p.prefetch).toBe(false);
  });

  it("TrialResultRow: the PI pills", () => {
    const hit = {
      trialId: "NCT00000001",
      nctNumber: "NCT00000001",
      title: "A trial",
      status: "OPEN TO ACCRUAL",
      statusBucket: "active",
      phase: "2",
      studyType: "INTERVENTIONAL",
      sponsorClass: "industry",
      principalSponsor: "Sponsor",
      pis: [{ cwid: "c1", name: "PI One", slug: "pi-one" }],
      conditions: "Condition",
      statusKey: "recruiting",
      startDate: "2016-09",
      startEstimated: false,
      endDate: "2020-06",
      endEstimated: false,
      interventions: "Drug: X",
      hasResults: false,
      matchedConcept: false,
      matchedFields: [],
    } as TrialHit;
    render(<TrialResultRow hit={hit} q="" conceptLabel={null} />);
    const links = profileLinks("pi-one");
    expect(links.length).toBeGreaterThan(0);
    for (const p of links) expect(p.prefetch).toBe(false);
  });
});
