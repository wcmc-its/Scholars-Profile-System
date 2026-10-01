/**
 * `components/site/impersonation-switcher.tsx` — the exact-CWID fallback
 * (#637 widen for the four global LDAP-group roles, `lib/auth/global-roles.ts`).
 * Search can never enumerate them (no LDAP group-listing capability), so the
 * empty state offers "View as this exact CWID" as an escape hatch. This suite
 * covers that path only; the search/candidate-row flow is exercised manually
 * (no candidates-route test harness exists for this component today).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  type Candidate,
  ImpersonationSwitcher,
  ViewAsConfirmDialog,
} from "@/components/site/impersonation-switcher";

/** The account menu's wiring: a pick opens the confirm dialog. */
function Harness() {
  const [pending, setPending] = useState<Candidate | null>(null);
  return (
    <>
      <ImpersonationSwitcher onPick={setPending} />
      <ViewAsConfirmDialog candidate={pending} onClose={() => setPending(null)} />
    </>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Stub every fetch: the candidates search always returns `rows`; a POST to
 *  `/api/impersonation` returns `postStatus`. */
function stubFetches(rows: unknown[], postStatus = 204, postBody: unknown = null) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/impersonation/candidates")) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(postBody === null ? null : JSON.stringify(postBody), {
      status: postStatus,
    });
  });
}

describe("ImpersonationSwitcher exact-CWID fallback", () => {
  it("offers it once a single-token search returns no rows, and POSTs that CWID on confirm", async () => {
    const fetchMock = stubFetches([]);
    render(<Harness />);

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

  it("surfaces the route's reason when the start POST fails, not the search error", async () => {
    stubFetches([], 404, { ok: false, error: "target_not_found", field: "targetCwid" });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Search people to view as"), {
      target: { value: "meb2011" },
    });
    fireEvent.click(await screen.findByTestId("impersonation-view-as-exact-cwid"));
    fireEvent.click(await screen.findByTestId("impersonation-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing to view as");
    expect(alert.textContent).not.toContain("Couldn’t load people");
  });

  it("does NOT offer the fallback for a multi-word query (a name search, never a CWID)", async () => {
    stubFetches([]);
    render(<Harness />);

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
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Search people to view as"), {
      target: { value: "sch001" },
    });

    await screen.findByText("Jane Scholar");
    expect(screen.queryByTestId("impersonation-view-as-exact-cwid")).toBeNull();
  });

  it("shows the CWID on each result row and asks the server for org-unit roles on that tab", async () => {
    const fetchMock = stubFetches([
      { cwid: "tew2004", preferredName: "Terrie Rose Wheeler", slug: "t", role: "curator", unitKind: "department", unit: "Library" },
    ]);
    render(<Harness />);

    expect((await screen.findByText("Terrie Rose Wheeler")).nextElementSibling?.textContent).toBe(
      "tew2004 · Curator · Library (Dept)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Org unit roles" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("kind=unit"))).toBe(true),
    );
  });

  it("confirm dialog: target's first name, the TTL in minutes, maroon primary", async () => {
    stubFetches([
      { cwid: "tew2004", preferredName: "Terrie Rose Wheeler", slug: "t", role: "curator", unitKind: "department", unit: "Library" },
    ]);
    render(<Harness />);
    fireEvent.click(await screen.findByTestId("impersonation-view-as"));

    const confirm = await screen.findByTestId("impersonation-confirm");
    expect(confirm.textContent).toBe("Start viewing as Terrie");
    expect(confirm.getAttribute("data-variant")).toBe("apollo");
    expect(screen.getByRole("dialog").textContent).toContain("Ends automatically after 30 minutes.");
  });
});
