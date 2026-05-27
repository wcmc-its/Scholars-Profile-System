/**
 * `components/edit/slug-request-queue.tsx` — the superuser queue list + empty
 * state (#497 PR-3c, `slug-personalization-ui-spec.md` § 3). The row internals
 * are tested in `slug-request-row.test.tsx`; here the row is mocked to a button
 * that reports a decision, so we test the list's removal behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/edit/slug-request-row", () => ({
  SlugRequestRow: ({
    request,
    onDecided,
  }: {
    request: { id: string };
    onDecided: (id: string) => void;
  }) => (
    <div data-testid={`row-${request.id}`}>
      <button data-testid={`decide-${request.id}`} onClick={() => onDecided(request.id)}>
        decide
      </button>
    </div>
  ),
}));

import { SlugRequestQueue } from "@/components/edit/slug-request-queue";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";

function row(id: string): SlugRequestQueueRow {
  return {
    id,
    cwid: `cwid-${id}`,
    requestedSlug: `slug-${id}`,
    reason: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    currentSlug: `cur-${id}`,
    name: `Name ${id}`,
    department: null,
    warning: null,
    collidesWith: null,
  };
}

describe("SlugRequestQueue", () => {
  it("renders the empty state when there are no pending requests", () => {
    render(<SlugRequestQueue initialRequests={[]} />);
    expect(screen.getByTestId("slug-request-queue-empty").textContent).toMatch(
      /no pending url requests/i,
    );
    expect(screen.queryByTestId("slug-request-queue")).toBeNull();
  });

  it("renders one row per request, in the order given (oldest-first from the server)", () => {
    render(<SlugRequestQueue initialRequests={[row("a"), row("b"), row("c")]} />);
    expect(screen.getByTestId("slug-request-queue")).toBeTruthy();
    expect(screen.getByTestId("row-a")).toBeTruthy();
    expect(screen.getByTestId("row-b")).toBeTruthy();
    expect(screen.getByTestId("row-c")).toBeTruthy();
  });

  it("removes a row once it reports a decision", () => {
    render(<SlugRequestQueue initialRequests={[row("a"), row("b")]} />);
    fireEvent.click(screen.getByTestId("decide-a"));
    expect(screen.queryByTestId("row-a")).toBeNull();
    expect(screen.getByTestId("row-b")).toBeTruthy();
  });

  it("falls back to the empty state after the last row is decided", () => {
    render(<SlugRequestQueue initialRequests={[row("only")]} />);
    fireEvent.click(screen.getByTestId("decide-only"));
    expect(screen.queryByTestId("row-only")).toBeNull();
    expect(screen.getByTestId("slug-request-queue-empty")).toBeTruthy();
  });
});
