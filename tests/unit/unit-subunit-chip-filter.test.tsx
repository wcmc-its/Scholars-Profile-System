/**
 * Unit Page v2 — hero subunit chips filter the roster IN PLACE.
 *
 * Covered:
 *  - chip row: a chip without `filter` is a plain link (no interception); a
 *    filter chip with no roster listening falls through to its real href; a
 *    modified click is never intercepted; a broadcast selection drives
 *    `aria-current`, and clicking an active chip asks for "remove".
 *  - department: division chip → Division facet selected (checkbox ticked,
 *    fetch `div=`), URL `?div=<code>#people`, chip active, scroll to #people,
 *    "View division page" link; clicking the active chip clears it; unknown code
 *    stays unhandled.
 *  - center (grouped roster): program chip → Program facet narrows to that
 *    section, URL `?program=<code>#people`, "View program page" link; `?program=`
 *    seeds the facet on mount; active chip click clears.
 *  - a roster unmount (tab switch) clears the chips' active state, so a later
 *    chip click asks "only" and falls through to its href instead of a stale
 *    "remove"; a chip click moves focus to `#people-results` and, on a narrow
 *    viewport, scrolls there instead of to the facet stack.
 * PersonRow is stubbed; the fixtures are synthetic (no real faculty / CWIDs).
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({ hit }: { hit: { cwid: string; preferredName: string } }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
    </div>
  ),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

import { UnitSubunitChipRow } from "@/components/shared/unit-subunit-chip-row";
import { UnitSubunitChips } from "@/components/shared/unit-hero";
import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import { CenterMembersClient } from "@/components/center/center-members-client";
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import type { CenterMembersResult } from "@/lib/api/centers";
import {
  SUBUNIT_SELECT_EVENT,
  applySubunitSelect,
  broadcastSubunitSelection,
  type SubunitSelectDetail,
} from "@/lib/unit-subunit-filter";

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Click `el` and report whether the app cancelled the default action. A
 * last-in-line window listener records it and then cancels the navigation
 * itself (jsdom can't navigate and would log an error).
 */
function clickWasPrevented(el: HTMLElement, init: MouseEventInit = {}): boolean {
  let prevented = false;
  const sink = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener("click", sink);
  try {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  } finally {
    window.removeEventListener("click", sink);
  }
  return prevented;
}

// Chips are looked up inside the chip row only (the roster has its own links).
const chip = (name: RegExp) =>
  within(
    (document.querySelector('[data-testid="chips"]') as HTMLElement | null) ?? document.body,
  ).getByRole("link", { name });

describe("applySubunitSelect", () => {
  it("'only' replaces the selection; 'remove' drops just that value", () => {
    expect([...applySubunitSelect(new Set(["a", "b"]), "c", "only")]).toEqual(["c"]);
    expect([...applySubunitSelect(new Set(["a", "b"]), "a", "remove")]).toEqual(["b"]);
  });
});

describe("UnitSubunitChipRow", () => {
  beforeEach(() => window.history.replaceState(null, "", "/departments/dept-x"));

  it("renders a chip without `filter` as a plain page link", () => {
    render(
      <UnitSubunitChips
        noun={["division", "divisions"]}
        ariaLabel="Divisions"
        chips={[
          { key: "D1", label: "Alpha", href: "/departments/dept-x/divisions/alpha", count: 3 },
        ]}
      />,
    );
    const a = chip(/Alpha/);
    expect(a.getAttribute("href")).toBe("/departments/dept-x/divisions/alpha");
    expect(a.getAttribute("aria-current")).toBeNull();
    // Click is not intercepted (no listener involvement at all).
    expect(clickWasPrevented(a)).toBe(false);
  });

  it("falls through to the href when no roster handles the request", () => {
    render(
      <UnitSubunitChipRow
        chips={[
          {
            key: "D1",
            label: "Alpha",
            href: "/departments/dept-x?div=D1#people",
            filter: { param: "div", value: "D1" },
          },
        ]}
      />,
    );
    expect(clickWasPrevented(chip(/Alpha/))).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("never intercepts a modified (new-tab) click", () => {
    const seen = vi.fn();
    window.addEventListener(SUBUNIT_SELECT_EVENT, seen);
    onTestFinished(() => window.removeEventListener(SUBUNIT_SELECT_EVENT, seen));
    render(
      <UnitSubunitChipRow
        chips={[
          {
            key: "D1",
            label: "Alpha",
            href: "?div=D1#people",
            filter: { param: "div", value: "D1" },
          },
        ]}
      />,
    );
    expect(clickWasPrevented(chip(/Alpha/), { metaKey: true })).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it("tracks the broadcast selection and asks for 'remove' on an active chip", () => {
    const requests: SubunitSelectDetail[] = [];
    const listener = (e: Event) => {
      const d = (e as CustomEvent<SubunitSelectDetail>).detail;
      requests.push({ ...d });
      d.handled = true;
    };
    window.addEventListener(SUBUNIT_SELECT_EVENT, listener);
    onTestFinished(() => window.removeEventListener(SUBUNIT_SELECT_EVENT, listener));
    render(
      <>
        <section id="people" />
        <UnitSubunitChipRow
          chips={[
            {
              key: "D1",
              label: "Alpha",
              href: "?div=D1#people",
              filter: { param: "div", value: "D1" },
            },
            {
              key: "D2",
              label: "Beta",
              href: "?div=D2#people",
              filter: { param: "div", value: "D2" },
            },
          ]}
        />
      </>,
    );
    act(() => broadcastSubunitSelection("div", ["D2"]));
    expect(chip(/Beta/).getAttribute("aria-current")).toBe("true");
    expect(chip(/Alpha/).getAttribute("aria-current")).toBeNull();

    fireEvent.click(chip(/Beta/));
    fireEvent.click(chip(/Alpha/));
    expect(requests.map((r) => [r.value, r.action])).toEqual([
      ["D2", "remove"],
      ["D1", "only"],
    ]);
    // Selecting (not clearing) scrolls to the roster.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

function deptHit(cwid: string): DepartmentFacultyHit {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Department of Examples",
    identityImageEndpoint: "",
    roleCategory: "full_time_faculty",
    overview: null,
    pubCount: 0,
    grantCount: 0,
  };
}

describe("Department — division chip filters the roster in place", () => {
  const DIVS = [
    { value: "D1", label: "Alpha Division", count: 4, href: "/departments/dept-x/divisions/alpha" },
    { value: "D2", label: "Beta Division", count: 2, href: "/departments/dept-x/divisions/beta" },
  ];
  const CHIPS = DIVS.map((d) => ({
    key: d.value,
    label: d.label,
    href: `/departments/dept-x?div=${d.value}#people`,
    count: d.count,
    filter: { param: "div" as const, value: d.value },
  }));

  beforeEach(() => window.history.replaceState(null, "", "/departments/dept-x"));

  function renderPage() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: [deptHit("flt00001")], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    // Two roots, like the real page: the hero chip row and the roster are
    // separate client islands, so the roster can unmount (tab switch) alone.
    render(
      <div data-testid="chips">
        <UnitSubunitChipRow chips={CHIPS} />
      </div>,
    );
    const roster = render(
      <>
        <section id="people">
          <DepartmentFacultyClient
            faculty={[deptHit("ssr00001"), deptHit("ssr00002")]}
            total={2}
            roleCategoryCounts={{ "Full-time faculty": 2 }}
            page={1}
            pageSize={20}
            deptSlug="dept-x"
            divisionSlug={null}
            methodFacet={[]}
            divisionFacet={DIVS}
            unitKind="department"
            unitCode="DX"
          />
        </section>
      </>,
    );
    return Object.assign(fetchMock, { unmountRoster: roster.unmount });
  }

  it("selects the Division facet, syncs ?div=#people, and marks the chip active", async () => {
    const fetchMock = renderPage();
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      chip(/Beta Division/).dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("div=D2");
    expect(
      (screen.getByRole("checkbox", { name: /Beta Division/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    await waitFor(() => expect(window.location.search).toBe("?div=D2"));
    expect(window.location.hash).toBe("#people");
    expect(chip(/Beta Division/).getAttribute("aria-current")).toBe("true");

    // The division page stays reachable from under the facet.
    expect(
      screen.getByRole("link", { name: "View Beta Division division page" }).getAttribute("href"),
    ).toBe("/departments/dept-x/divisions/beta");
  });

  it("the facet checkbox lights the chip; clicking the active chip clears it", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: /Alpha Division/ }));
    await waitFor(() => expect(chip(/^Alpha Division/).getAttribute("aria-current")).toBe("true"));

    fireEvent.click(chip(/^Alpha Division/));
    await waitFor(() => expect(chip(/^Alpha Division/).getAttribute("aria-current")).toBeNull());
    expect(window.location.search).not.toContain("div=");
    expect(screen.queryByRole("link", { name: /division page/ })).toBeNull();
  });

  it("moves focus to the results and announces the count", async () => {
    renderPage();
    act(() => {
      fireEvent.click(chip(/Beta Division/));
    });
    const results = document.getElementById("people-results")!;
    expect(document.activeElement).toBe(results);
    // Wide viewport (no matchMedia match): the scroll goes to the section top.
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("people"));
    await waitFor(() =>
      expect(
        within(results)
          .getAllByText(/shown$/)
          .find((el) => el.getAttribute("aria-live") === "polite")?.textContent,
      ).toBe("1 scholar shown"),
    );
  });

  it("on a narrow viewport scrolls to the results, not the facet stack", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q === "(max-width: 767px)", media: q })),
    );
    renderPage();
    act(() => {
      fireEvent.click(chip(/Beta Division/));
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("people-results"));
  });

  it("a tab switch (roster unmounts) clears the chip; its click then SELECTS via the href", async () => {
    const page = renderPage();
    act(() => {
      fireEvent.click(chip(/Beta Division/));
    });
    await waitFor(() => expect(chip(/Beta Division/).getAttribute("aria-current")).toBe("true"));

    // Publications / Grants tab: soft navigation, hero stays, roster unmounts.
    act(() => page.unmountRoster());
    expect(chip(/Beta Division/).getAttribute("aria-current")).toBeNull();

    // The click now asks for "only" (not "remove"); nobody handles it, so the
    // chip falls through to `?div=D2#people` — the Scholars tab, D2 selected.
    const requests: SubunitSelectDetail[] = [];
    const spy = (e: Event) => requests.push({ ...(e as CustomEvent<SubunitSelectDetail>).detail });
    window.addEventListener(SUBUNIT_SELECT_EVENT, spy);
    onTestFinished(() => window.removeEventListener(SUBUNIT_SELECT_EVENT, spy));
    expect(clickWasPrevented(chip(/Beta Division/))).toBe(false);
    expect(requests.map((r) => r.action)).toEqual(["only"]);
  });

  it("leaves an unknown division code unhandled (the chip navigates)", () => {
    renderPage();
    const d: SubunitSelectDetail = { param: "div", value: "NOPE", action: "only", handled: false };
    window.dispatchEvent(new CustomEvent(SUBUNIT_SELECT_EVENT, { detail: d }));
    expect(d.handled).toBe(false);
  });
});

function centerHit(cwid: string) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Example Dept",
    identityImageEndpoint: "",
    roleCategory: "Full-time faculty",
    overview: null,
    professorialRank: null,
    primaryOrgCode: null,
    pubCount: 0,
    grantCount: 0,
    membershipType: "research" as const,
    membershipRoleLabel: null,
  };
}

const grouped: CenterMembersResult = {
  mode: "grouped",
  total: 3,
  groups: [
    { code: "PA", label: "Program Alpha", members: [centerHit("m1"), centerHit("m2")] },
    { code: "PB", label: "Program Beta", members: [centerHit("m3")] },
  ],
};

describe("Center — program chip filters the grouped roster in place", () => {
  const CHIPS = [
    {
      key: "PA",
      label: "Program Alpha",
      href: "/centers/ctr-x?program=PA#people",
      count: 2,
      filter: { param: "program" as const, value: "PA" },
    },
    {
      key: "PB",
      label: "Program Beta",
      href: "/centers/ctr-x?program=PB#people",
      count: 1,
      filter: { param: "program" as const, value: "PB" },
    },
  ];
  const cwids = () => screen.getAllByTestId("person").map((el) => el.getAttribute("data-cwid"));

  beforeEach(() => window.history.replaceState(null, "", "/centers/ctr-x"));

  function renderPage() {
    render(
      <div data-testid="chips">
        <UnitSubunitChipRow chips={CHIPS} />
      </div>,
    );
    return render(
      <section id="people">
        <CenterMembersClient result={grouped} centerSlug="ctr-x" programPagesEnabled />
      </section>,
    );
  }

  it("a tab switch (roster unmounts) clears the program chip", async () => {
    const roster = renderPage();
    fireEvent.click(chip(/^Program Alpha/));
    await waitFor(() => expect(chip(/^Program Alpha/).getAttribute("aria-current")).toBe("true"));
    expect(document.activeElement).toBe(document.getElementById("people-results"));

    act(() => roster.unmount());
    expect(chip(/^Program Alpha/).getAttribute("aria-current")).toBeNull();
    expect(clickWasPrevented(chip(/^Program Alpha/))).toBe(false);
  });

  it("narrows to the program, syncs ?program=#people and links the program page", async () => {
    renderPage();
    expect(cwids().sort()).toEqual(["m1", "m2", "m3"]);
    fireEvent.click(chip(/^Program Beta/));

    await waitFor(() => expect(cwids()).toEqual(["m3"]));
    expect(window.location.search).toBe("?program=PB");
    expect(window.location.hash).toBe("#people");
    expect(chip(/^Program Beta/).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("link", { name: "View Program Beta program page" }).getAttribute("href"),
    ).toBe("/centers/ctr-x/programs/PB");

    // Active chip click clears the program filter.
    fireEvent.click(chip(/^Program Beta/));
    await waitFor(() => expect(cwids().sort()).toEqual(["m1", "m2", "m3"]));
    expect(window.location.search).not.toContain("program=");
  });

  it("seeds the Program facet from ?program= on mount", async () => {
    window.history.replaceState(null, "", "/centers/ctr-x?program=PA#people");
    renderPage();
    await waitFor(() => expect(cwids().sort()).toEqual(["m1", "m2"]));
    expect(chip(/^Program Alpha/).getAttribute("aria-current")).toBe("true");
    expect(window.location.search).toBe("?program=PA");
  });
});
