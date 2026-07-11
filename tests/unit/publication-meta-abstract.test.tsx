import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicationMeta } from "@/components/publication/publication-meta";

/**
 * Tests cover the #288 PR-A abstract behavior on the meta row:
 *   - "Abstract" link appears as a peer of PMID/PMC/DOI when abstract is non-empty
 *   - Link is omitted entirely when abstract is null/empty
 *   - Click reveals a clamped (line-clamp-3) panel below the row + Show more
 *   - Show more flips to Show less and removes the clamp
 *   - Collapsing the row removes the panel
 *   - defaultAbstractOpen renders open out of the gate
 *   - aria-expanded flips on both buttons
 */
describe("PublicationMeta — abstract disclosure (#288 PR-A)", () => {
  const longAbstract =
    "Calciphylaxis is a rare complication in patients undergoing hemodialysis. " +
    "The pathogenesis and risk factors for this disease are poorly understood.";

  it("omits the Abstract link when abstract is null", () => {
    render(<PublicationMeta pmid="12345" abstract={null} />);
    expect(screen.queryByRole("button", { name: "Abstract" })).toBeNull();
  });

  it("omits the Abstract link when abstract is empty", () => {
    render(<PublicationMeta pmid="12345" abstract="" />);
    expect(screen.queryByRole("button", { name: "Abstract" })).toBeNull();
  });

  it("renders an Abstract link in the meta row when abstract is present", () => {
    render(<PublicationMeta pmid="12345" abstract={longAbstract} />);
    const btn = screen.getByRole("button", { name: "Abstract" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(longAbstract)).toBeNull();
  });

  it("clicking Abstract reveals a clamped panel with Show more", () => {
    const { container } = render(
      <PublicationMeta pmid="12345" abstract={longAbstract} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    const trigger = screen.getByRole("button", { name: "Abstract" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const para = container.querySelector("p");
    expect(para?.textContent).toBe(longAbstract);
    expect(para?.className).toContain("line-clamp-3");
    const showMore = screen.getByRole("button", { name: "Show more" });
    expect(showMore.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking Show more removes the clamp and flips the label", () => {
    const { container } = render(
      <PublicationMeta pmid="12345" abstract={longAbstract} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    const showMore = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(showMore);
    expect(showMore.getAttribute("aria-expanded")).toBe("true");
    expect(showMore.textContent).toBe("Show less");
    const para = container.querySelector("p");
    expect(para?.className).not.toContain("line-clamp-");
  });

  it("clicking Abstract a second time collapses the panel back", () => {
    render(<PublicationMeta pmid="12345" abstract={longAbstract} />);
    const trigger = screen.getByRole("button", { name: "Abstract" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(longAbstract)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("defaultAbstractOpen renders the panel expanded out of the gate", () => {
    render(
      <PublicationMeta
        pmid="12345"
        abstract={longAbstract}
        defaultAbstractOpen
      />,
    );
    const trigger = screen.getByRole("button", { name: "Abstract" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(longAbstract)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("Abstract link sits at the trailing edge after impact when both present", () => {
    const { container } = render(
      <PublicationMeta
        pmid="12345"
        impactScore={42}
        abstract={longAbstract}
      />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const abstractIdx = buttons.findIndex((b) => b.textContent === "Abstract");
    expect(abstractIdx).toBe(buttons.length - 1);
  });
});

// #1537 — the profile ships hasAbstract:boolean instead of the text; the meta
// row fetches it from the gated /api/publications/[pmid] route on first open.
describe("PublicationMeta — lazy abstract (#1537)", () => {
  const abstractText = "Fetched abstract body for the lazy path.";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits the Abstract link when lazyAbstract is set without a pmid", () => {
    render(<PublicationMeta doi="10.1/x" lazyAbstract />);
    expect(screen.queryByRole("button", { name: "Abstract" })).toBeNull();
  });

  it("renders the Abstract link with no fetch until opened", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicationMeta pmid="12345" lazyAbstract />);
    expect(screen.getByRole("button", { name: "Abstract" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clicking Abstract fetches the detail route and renders the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ abstract: abstractText }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicationMeta pmid="12345" lazyAbstract />);
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/publications/12345");
    expect(screen.getByText("Loading abstract…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(abstractText)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("does not refetch when reopened after a successful load", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ abstract: abstractText }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicationMeta pmid="12345" lazyAbstract />);
    const trigger = screen.getByRole("button", { name: "Abstract" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText(abstractText)).toBeTruthy());
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the error line on fetch failure, then refetches on reopen", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ ok: true, json: async () => ({ abstract: abstractText }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicationMeta pmid="12345" lazyAbstract />);
    const trigger = screen.getByRole("button", { name: "Abstract" });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByText("Couldn't load the abstract.")).toBeTruthy(),
    );
    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // reopen → retry
    await waitFor(() => expect(screen.getByText(abstractText)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows 'Abstract unavailable.' when the route returns no abstract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ abstract: null }) }),
    );
    render(<PublicationMeta pmid="12345" lazyAbstract />);
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    await waitFor(() =>
      expect(screen.getByText("Abstract unavailable.")).toBeTruthy(),
    );
  });

  it("an eager abstract wins over lazyAbstract — no fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicationMeta pmid="12345" abstract={abstractText} lazyAbstract />);
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    expect(screen.getByText(abstractText)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
