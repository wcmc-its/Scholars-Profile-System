/**
 * `components/edit/opportunity-intake-panel.tsx` — the per-row Delete /
 * Suppress cleanup actions (Submissions sub-tab):
 *  - action affordance per status (Delete on pending/rejected, Suppress on
 *    processed, nothing on suppressed);
 *  - the inline confirm step before either destructive call;
 *  - the DELETE / PATCH request contracts + the post-success list refresh;
 *  - a 409's mapped error message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OpportunityIntakePanel } from "@/components/edit/opportunity-intake-panel";

const SUBMISSIONS = [
  {
    submissionId: "2026-07-06T12:00:00.000Z#pending01",
    url: "https://x.org/grants",
    normalizedUrl: "https://x.org/grants",
    note: null,
    submittedBy: "flm4001",
    submittedAt: "2026-07-06T12:00:00.000Z",
    status: "pending",
    processedAt: null,
    producedOpportunityIds: [],
    rejectReason: null,
  },
  {
    submissionId: "2026-07-05T12:00:00.000Z#processed1",
    url: "https://y.org/rfa",
    normalizedUrl: "https://y.org/rfa",
    note: null,
    submittedBy: "flm4001",
    submittedAt: "2026-07-05T12:00:00.000Z",
    status: "processed",
    processedAt: "2026-07-06T02:00:00.000Z",
    producedOpportunityIds: ["manual_url:y-abc123"],
    rejectReason: null,
  },
  {
    submissionId: "2026-07-04T12:00:00.000Z#suppress01",
    url: "https://z.org/award",
    normalizedUrl: "https://z.org/award",
    note: null,
    submittedBy: "paa2013",
    submittedAt: "2026-07-04T12:00:00.000Z",
    status: "suppressed",
    processedAt: "2026-07-05T02:00:00.000Z",
    producedOpportunityIds: [],
    rejectReason: null,
  },
];

/** GET → the fixture list; DELETE/PATCH → `mutation`. Records every call. */
function stubFetch(mutation: { status: number; body?: object } = { status: 200 }) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({ ok: true, submissions: SUBMISSIONS }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(mutation.body ?? { ok: mutation.status === 200 }), {
        status: mutation.status,
      });
    });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OpportunityIntakePanel row actions", () => {
  it("offers Delete on pending, Suppress on processed, nothing on suppressed", async () => {
    stubFetch();
    render(<OpportunityIntakePanel />);
    await screen.findByText("https://x.org/grants");

    expect(screen.getAllByTestId("intake-action-delete")).toHaveLength(1);
    expect(screen.getAllByTestId("intake-action-suppress")).toHaveLength(1);
    // The suppressed row renders its badge but no action affordance.
    expect(screen.getByText("suppressed")).toBeTruthy();
    const suppressedRow = screen.getByText("https://z.org/award").closest("li")!;
    expect(suppressedRow.querySelector("button")).toBeNull();
  });

  it("Delete: arm → confirm → DELETE {submissionId} → list refresh", async () => {
    const f = stubFetch();
    render(<OpportunityIntakePanel />);
    await screen.findByText("https://x.org/grants");

    fireEvent.click(screen.getByTestId("intake-action-delete"));
    // Nothing fired yet — the confirm step is armed.
    expect(f.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("intake-action-confirm"));
    await waitFor(() =>
      expect(f.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1),
    );
    const [, init] = f.mock.calls.find(([, i]) => i?.method === "DELETE")!;
    expect(JSON.parse(init!.body as string)).toEqual({
      submissionId: "2026-07-06T12:00:00.000Z#pending01",
    });
    // The list re-fetches after the mutation (initial GET + refresh GET).
    await waitFor(() =>
      expect(f.mock.calls.filter(([, i]) => (i?.method ?? "GET") === "GET").length).toBe(2),
    );
  });

  it("Cancel disarms without firing", async () => {
    const f = stubFetch();
    render(<OpportunityIntakePanel />);
    await screen.findByText("https://x.org/grants");

    fireEvent.click(screen.getByTestId("intake-action-delete"));
    fireEvent.click(screen.getByTestId("intake-action-cancel"));
    expect(screen.queryByTestId("intake-action-confirm")).toBeNull();
    expect(f.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });

  it("Suppress: confirm → PATCH {submissionId, action:'suppress'}", async () => {
    const f = stubFetch();
    render(<OpportunityIntakePanel />);
    await screen.findByText("https://y.org/rfa");

    fireEvent.click(screen.getByTestId("intake-action-suppress"));
    fireEvent.click(screen.getByTestId("intake-action-confirm"));
    await waitFor(() =>
      expect(f.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1),
    );
    const [, init] = f.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(init!.body as string)).toEqual({
      submissionId: "2026-07-05T12:00:00.000Z#processed1",
      action: "suppress",
    });
  });

  it("maps a 409 to its message (drain won the race)", async () => {
    stubFetch({ status: 409, body: { ok: false, error: "submission_processed" } });
    render(<OpportunityIntakePanel />);
    await screen.findByText("https://x.org/grants");

    fireEvent.click(screen.getByTestId("intake-action-delete"));
    fireEvent.click(screen.getByTestId("intake-action-confirm"));
    const alert = await screen.findByTestId("intake-row-action-error");
    expect(alert.textContent).toContain("use Suppress");
  });
});
