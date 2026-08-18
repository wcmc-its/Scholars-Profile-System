/**
 * `components/site/impersonation-switcher.tsx` — the exact-CWID fallback
 * (#637 widen for the four global LDAP-group roles, `lib/auth/global-roles.ts`).
 * Search can never enumerate them (no LDAP group-listing capability), so the
 * empty state offers "View as this exact CWID" as an escape hatch. This suite
 * covers that path only; the search/candidate-row flow is exercised manually
 * (no candidates-route test harness exists for this component today).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ImpersonationSwitcher } from "@/components/site/impersonation-switcher";

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Stub every fetch: the candidates search always returns `rows`; a POST to
 *  `/api/impersonation` returns `postStatus`. */
function stubFetches(rows: unknown[], postStatus = 204) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/impersonation/candidates")) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: postStatus });
  });
}

describe("ImpersonationSwitcher exact-CWID fallback", () => {
  it("offers it once a single-token search returns no rows, and POSTs that CWID on confirm", async () => {
    const fetchMock = stubFetches([]);
    render(<ImpersonationSwitcher />);

    fireEvent.change(screen.getByLabelText("Search people to view as"), {
      target: { value: "cvg001" },
    });

    const fallback = await screen.findByTestId("impersonation-view-as-exact-cwid");
    expect(fallback.textContent).toContain("cvg001");

    fireEvent.click(fallback);
    fireEvent.click(await screen.findByTestId("impersonation-confirm"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => String(c[0]) === "/api/impersonation" && (c[1] as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ targetCwid: "cvg001" });
    });
  });

  it("does NOT offer the fallback for a multi-word query (a name search, never a CWID)", async () => {
    stubFetches([]);
    render(<ImpersonationSwitcher />);

    fireEvent.change(screen.getByLabelText("Search people to view as"), {
      target: { value: "Jane Smith" },
    });

    await screen.findByText("No matching people.");
    expect(screen.queryByTestId("impersonation-view-as-exact-cwid")).toBeNull();
  });

  it("does not offer the fallback when the search already found matches", async () => {
    stubFetches([
      { cwid: "sch001", preferredName: "Jane Scholar", slug: "jane-scholar", role: "scholar", unitKind: null, unit: "Medicine" },
    ]);
    render(<ImpersonationSwitcher />);

    fireEvent.change(screen.getByLabelText("Search people to view as"), {
      target: { value: "sch001" },
    });

    await screen.findByText("Jane Scholar");
    expect(screen.queryByTestId("impersonation-view-as-exact-cwid")).toBeNull();
  });
});
