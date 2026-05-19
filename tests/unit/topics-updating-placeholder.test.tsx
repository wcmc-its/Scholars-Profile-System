/**
 * Unit test for the TopicsUpdatingPlaceholder (#118 / B19) — the replace-state
 * shown in the profile Topics section while the rebuild window is open.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopicsUpdatingPlaceholder } from "@/components/profile/topics-updating-placeholder";

describe("TopicsUpdatingPlaceholder", () => {
  it("renders the Topics heading and the updating message", () => {
    render(<TopicsUpdatingPlaceholder />);
    expect(screen.getByRole("heading", { name: /topics/i })).toBeDefined();
    expect(screen.getByText("Topics are updating.")).toBeDefined();
    expect(screen.getByText(/updated topics appear shortly/i)).toBeDefined();
  });
});
