/**
 * `components/edit/proxy-editor-card.tsx` (#779) — empty state, name hydration,
 * the add flow (POST /api/edit/proxy), and error mapping. The directory
 * typeahead is mocked so the picker is deterministic.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    value,
    onChange,
  }: {
    value: { cwid: string; name: string } | null;
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
  }) =>
    value ? (
      <span data-testid="proxy-picked">{value.name}</span>
    ) : (
      <button
        type="button"
        data-testid="proxy-pick"
        onClick={() => onChange({ cwid: "new9", name: "New Proxy", title: null })}
      >
        pick
      </button>
    ),
}));

import { ProxyEditorCard, type ProxyRow } from "@/components/edit/proxy-editor-card";

const SCHOLAR = "ras2022";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route the directory hydration and the grant POST to separate fakes. */
function stubFetch(grant: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/directory/people")) {
      return jsonResponse({
        ok: true,
        people: [{ cwid: "bec4010", name: "Beth Chunn", title: "Administrator" }],
      });
    }
    return grant();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ProxyEditorCard", () => {
  it("renders nothing when proxies is null (defensive)", () => {
    const { container } = render(
      <ProxyEditorCard scholarCwid={SCHOLAR} scholarName="Rahul Sharma" mode="self" proxies={null} />,
    );
    expect(container.querySelector('[data-slot="proxy-editor-card"]')).toBeNull();
  });

  it("shows the empty state with no grants", () => {
    stubFetch(() => jsonResponse({ ok: true, changed: true }));
    render(
      <ProxyEditorCard scholarCwid={SCHOLAR} scholarName="Rahul Sharma" mode="self" proxies={[]} />,
    );
    expect(screen.getByTestId("proxy-editor-empty")).toBeTruthy();
  });

  it("renders a grant row and hydrates the proxy's name from the directory", async () => {
    stubFetch(() => jsonResponse({ ok: true, changed: true }));
    const proxies: ProxyRow[] = [
      { proxyCwid: "bec4010", grantedBy: SCHOLAR, grantedAt: new Date("2026-06-01") },
    ];
    render(
      <ProxyEditorCard scholarCwid={SCHOLAR} scholarName="Rahul Sharma" mode="self" proxies={proxies} />,
    );
    expect(screen.getByTestId("proxy-editor-row-bec4010")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Beth Chunn")).toBeTruthy());
  });

  it("adds a proxy: POSTs grant to /api/edit/proxy and shows the new row", async () => {
    const fetchSpy = stubFetch(() => jsonResponse({ ok: true, changed: true }));
    render(
      <ProxyEditorCard scholarCwid={SCHOLAR} scholarName="Rahul Sharma" mode="self" proxies={[]} />,
    );
    fireEvent.click(screen.getByTestId("proxy-pick"));
    fireEvent.click(screen.getByTestId("proxy-editor-grant"));
    await waitFor(() => expect(screen.getByTestId("proxy-editor-row-new9")).toBeTruthy());
    const grantCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("/api/edit/proxy"));
    expect(grantCall).toBeTruthy();
    expect(JSON.parse(String(grantCall![1]!.body))).toEqual({
      scholarCwid: SCHOLAR,
      proxyCwid: "new9",
      action: "grant",
    });
  });

  it("maps proxy_ineligible to a friendly 'already has a role' message", async () => {
    stubFetch(() => jsonResponse({ ok: false, error: "proxy_ineligible" }, 403));
    render(
      <ProxyEditorCard scholarCwid={SCHOLAR} scholarName="Rahul Sharma" mode="self" proxies={[]} />,
    );
    fireEvent.click(screen.getByTestId("proxy-pick"));
    fireEvent.click(screen.getByTestId("proxy-editor-grant"));
    await waitFor(() => expect(screen.getByText(/already has a role/i)).toBeTruthy());
    expect(screen.queryByTestId("proxy-editor-row-new9")).toBeNull();
  });
});
