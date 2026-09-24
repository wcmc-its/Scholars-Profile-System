/**
 * `app/(public)/centers/[slug]/page.tsx` — the route's `?tab=` parse. The center
 * page / tabs tests call `CenterPage` / `CenterTabs` with `tab` already set, so a
 * reverted ternary (`?tab=grants` silently falling back to Scholars) would pass
 * them all. This pins the parse itself: the route returns a `<CenterPage>`
 * element, whose props are what the page will receive.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/components/center/center-page", () => ({
  CenterPage: () => null,
}));
vi.mock("@/lib/api/centers", () => ({ getCenter: vi.fn() }));

import CenterRoute from "@/app/(public)/centers/[slug]/page";

async function propsFor(sp: Record<string, string | string[] | undefined>) {
  const el = (await CenterRoute({
    params: Promise.resolve({ slug: "synthetic-center" }),
    searchParams: Promise.resolve(sp),
  })) as { props: Record<string, unknown> };
  return el.props;
}

describe("CenterRoute ?tab= parse", () => {
  it("passes tab 'grants' with its sort and page through to CenterPage", async () => {
    expect(await propsFor({ tab: "grants", sort: "end_date", page: "2" })).toEqual({
      centerSlug: "synthetic-center",
      tab: "grants",
      sort: "end_date",
      page: 2,
    });
  });

  it("takes the first value of a repeated ?tab=grants", async () => {
    expect((await propsFor({ tab: ["grants", "publications"] })).tab).toBe("grants");
  });

  it("falls back to scholars for an unknown or missing tab", async () => {
    expect((await propsFor({ tab: "bogus" })).tab).toBe("scholars");
    expect((await propsFor({})).tab).toBe("scholars");
  });
});
