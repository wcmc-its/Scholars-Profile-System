/**
 * Search reason-from-doc — the EVIDENCE-path lazy key paper. Under D the
 * publications evidence arrives with an empty `pubs` list (count only), so the
 * card offers a chevron disclosure that fetches the top-3 `/api/search/key-paper`
 * on the FIRST expand (not eagerly on render) and reveals them:
 *   - no fetch until the chevron is clicked (the per-visible-card load the
 *     chevron lets us avoid);
 *   - clicking fetches once and renders the up-to-3 key papers + "+N more";
 *   - collapse/re-open does not re-fetch;
 *   - absent `keyPaperConfig` ⇒ no chevron, no fetch (legacy/inline path).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PeopleHit>): PeopleHit {
  return {
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Medicine",
    deptName: "Medicine",
    divisionName: null,
    roleCategory: "full_time_faculty",
    pubCount: 255,
    grantCount: 5,
    hasActiveGrants: true,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...overrides,
  };
}

const props = {
  position: 0,
  q: "hiv",
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

const keyPaperConfig = {
  descriptorUis: ["D015658"],
  contentQuery: "hiv",
  conceptLabel: "HIV Infections",
};

// A publications-tagged evidence with NO inline pubs (the reason-from-doc shape):
// just the count. The key papers are fetched lazily on expand.
const taggedHit = makeHit({
  evidence: {
    kind: "publications",
    strength: "tagged",
    text: "162 of 255 publications tagged HIV",
    count: 255,
  },
});

function mockFetch(payload: { pubs: unknown[] }) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const chevron = () => screen.getByRole("button", { name: /key papers/i });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeopleResultCard — evidence-path lazy key paper (fetch on expand)", () => {
  it("does NOT fetch on render; fetches once on the first expand and reveals the top papers", async () => {
    const fetchFn = mockFetch({
      pubs: [
        { pmid: "1", title: "Early antiretroviral therapy in HIV", year: 2011 },
        { pmid: "2", title: "Broadly neutralizing antibodies", year: 2018 },
        { pmid: "3", title: "HIV reservoir dynamics", year: 2020 },
      ],
    });
    render(<PeopleResultCard {...props} hit={taggedHit} keyPaperConfig={keyPaperConfig} />);

    // The chevron is offered up front (optimistic), but NOTHING is fetched yet —
    // this is the per-visible-card load the chevron defers.
    expect(chevron()).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();

    fireEvent.click(chevron()); // expand → triggers the lazy fetch
    await waitFor(() =>
      expect(screen.getByText(/Early antiretroviral therapy in HIV/)).toBeTruthy(),
    );
    expect(screen.getByText(/HIV reservoir dynamics/)).toBeTruthy();
    // total (255) > shown (3) ⇒ "+252 more in profile".
    expect(screen.getByText(/\+252 more in profile/)).toBeTruthy();

    // The fetch hits the key-paper endpoint scoped to this scholar + concept.
    // #1351 — the resolved concept name rides as `label` so the title highlight can
    // mark the concept term, not just the literal query.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/search/key-paper?cwid=abc1234&q=hiv&descriptorUis=D015658&label=HIV+Infections",
    );

    // collapse + re-open must NOT re-fetch (once, cached in a ref).
    fireEvent.click(chevron()); // close
    fireEvent.click(chevron()); // re-open
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("#1357 — a mention-only card fetches with empty descriptorUis + label (literal scan), so the disclosure isn't empty", async () => {
    // A `mention` card is in the mention branch precisely because its tagged count
    // is 0 — it has no concept-tagged pubs. Fetching with the page-global concept
    // `descriptorUis` would return 0 (empty disclosure). It must fall to the literal
    // scan — the SAME predicate that produced its count — so descriptorUis + label
    // are cleared even though `keyPaperConfig` carries them.
    const mentionHit = makeHit({
      evidence: {
        kind: "publications",
        strength: "mention",
        text: "1 of 37 publications mention “hiv”",
        count: 37,
      },
    });
    const fetchFn = mockFetch({
      pubs: [{ pmid: "9", title: "An HIV mention in the title", year: 2019 }],
    });
    render(<PeopleResultCard {...props} hit={mentionHit} keyPaperConfig={keyPaperConfig} />);

    fireEvent.click(chevron());
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(fetchFn.mock.calls[0][0]).toBe(
      "/api/search/key-paper?cwid=abc1234&q=hiv&descriptorUis=&label=",
    );
  });

  it("drops the chevron (no dead control) when the fetch resolves with 0 papers", async () => {
    mockFetch({ pubs: [] });
    render(<PeopleResultCard {...props} hit={taggedHit} keyPaperConfig={keyPaperConfig} />);

    fireEvent.click(chevron());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /key papers/i })).toBeNull(),
    );
  });

  it("offers no chevron and never fetches when keyPaperConfig is absent (legacy path)", async () => {
    const fetchFn = mockFetch({ pubs: [{ pmid: "1", title: "x", year: 2020 }] });
    render(<PeopleResultCard {...props} hit={taggedHit} />);
    expect(screen.queryByRole("button", { name: /key papers/i })).toBeNull();
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
