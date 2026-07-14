/**
 * The per-card `Contact` button (#1699).
 *
 * THE LOAD-BEARING TEST HERE IS "no contact-email fetch at render". A paste ranks up to ~341
 * candidates, so resolving addresses eagerly would fire ~341 uncached directory lookups per
 * search to populate a button almost nobody presses. The obvious implementation — a `useEffect`
 * per row — is the bug, it typechecks, and every other assertion in this file still passes with
 * it in place. Only the render-time call count catches it. Mutate `ContactButton` to fetch on
 * mount and this file must go red; if it stays green the test is worthless.
 *
 * Everything else here is the consent story, which is the reason this button is per-card and not
 * the mockup's `Contact selected` + compose modal (bulk email: a standing policy no-go, and out
 * of scope by name in `docs/2026-07-14-sponsor-reskin-handoff.md` §3). `/api/profile/[cwid]/
 * contact-email` fails CLOSED — release gate off, external viewer, or an unreleased
 * `email_visibility` each return `{ email: null }` — so the null path is not an edge case, it is
 * PROD'S CURRENT STATE (the release gate is off and the backfill has never run). It gets a test.
 *
 * No address may reach the match payload; the candidates below carry none, which is the point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SponsorMatchPanel } from "@/components/edit/sponsor-match-panel";
import type { SponsorCandidate, SponsorConcept } from "@/lib/api/sponsor-match-contract";

const CONCEPTS: SponsorConcept[] = [
  {
    term: "Immuno-oncology",
    kind: "concept",
    members: ["Immuno-oncology"],
    centrality: 0.9,
    weightFactor: 3.0,
  },
];

const CANDIDATES: SponsorCandidate[] = [
  {
    cwid: "aaa1001",
    name: "Alice Alpha",
    profileSlug: "slug-alice",
    title: "Professor of Medicine",
    department: "Medicine",
    fusedScore: 0.05,
    contributions: [{ term: "Immuno-oncology", rank: 1 }],
    technologyCount: 0,
  },
  {
    cwid: "bbb1002",
    name: "Bob Beta",
    profileSlug: "slug-bob",
    title: "Assistant Professor",
    department: "Medicine",
    fusedScore: 0.02,
    contributions: [{ term: "Immuno-oncology", rank: 2 }],
    technologyCount: 0,
  },
];

/** `email: null` is the fail-closed answer the route really gives when the gate is off. */
function stub(contactEmail: string | null) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (String(url).includes("/contact-email")) {
      return { ok: true, json: async () => ({ email: contactEmail, viewer: "internal" }) };
    }
    if ((init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, concepts: CONCEPTS, candidates: CANDIDATES }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const contactCalls = (m: { mock: { calls: unknown[][] } }) =>
  m.mock.calls.filter((c) => String(c[0]).includes("/contact-email"));

async function renderAndSearch() {
  render(<SponsorMatchPanel />);
  fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Alice Alpha");
}

beforeEach(() => {
  window.localStorage.clear();
  // A plain object, so `window.location.href = "mailto:…"` records instead of navigating.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sponsor-match Contact button", () => {
  it("resolves NO addresses at render — one button per card, zero directory lookups", async () => {
    // THE FAN-OUT GUARD. Two candidates here; a real paste ranks ~341. Eager resolution would be
    // one uncached lookup per card, per search, for a button most rows never get pressed on.
    const fetchMock = stub("alice@med.cornell.edu");
    await renderAndSearch();

    expect(screen.getAllByRole("button", { name: "Contact" })).toHaveLength(2);
    expect(contactCalls(fetchMock)).toHaveLength(0);
  });

  it("click resolves ONE address and hands off to mailto:", async () => {
    const fetchMock = stub("alice@med.cornell.edu");
    await renderAndSearch();

    fireEvent.click(screen.getAllByRole("button", { name: "Contact" })[0]);

    await waitFor(() => expect(window.location.href).toBe("mailto:alice@med.cornell.edu"));
    // ALICE'S ROW ONLY — one lookup, for the one cwid the officer pressed. No bulk resolution
    // rode along on the click, which is the whole distinction between this button and the
    // `Contact selected` the mockup draws.
    expect(contactCalls(fetchMock)).toHaveLength(1);
    expect(String(contactCalls(fetchMock)[0][0])).toContain("aaa1001");
    // Both buttons still read "Contact": the row returns to idle after handing off, so the
    // officer can press it again. Bob's was never touched.
    expect(screen.getAllByRole("button", { name: "Contact" })).toHaveLength(2);
  });

  it("an unreleased email says so, and navigates nowhere — PROD'S CURRENT STATE", async () => {
    // The release gate is OFF in prod and `email_visibility` has never been backfilled, so the
    // route returns `{ email: null }` for everyone. The button must degrade quietly and must not
    // assert a fact about the scholar: "no email released" is what happened; "has no email" is a
    // claim we cannot make. Absent ≠ zero, applied to an address.
    stub(null);
    await renderAndSearch();

    fireEvent.click(screen.getAllByRole("button", { name: "Contact" })[0]);

    await waitFor(() => expect(screen.getByText("No email released")).toBeTruthy());
    expect(window.location.href).toBe("");
  });
});
