/**
 * ScholarHoverCard reused with a new cwid (the grant attribution queue's
 * detail pane keeps one instance and swaps the scholar) must load the new
 * person, not keep the previous person's card.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";

describe("ScholarHoverCard", () => {
  it("loads the new scholar when the cwid changes", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <ScholarHoverCard cwid="aaa1001">
        <span>First</span>
      </ScholarHoverCard>,
    );
    fireEvent.pointerEnter(screen.getByText("First"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <ScholarHoverCard cwid="bbb2002">
        <span>Second</span>
      </ScholarHoverCard>,
    );
    fireEvent.pointerEnter(screen.getByText("Second"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/edit/scholar-card/bbb2002");
    vi.unstubAllGlobals();
  });
});
