import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PersonRow } from "@/components/department/person-row";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

const baseHit: DepartmentFacultyHit = {
  cwid: "test123",
  preferredName: "Jane Smith",
  slug: "jane-smith",
  primaryTitle: "Associate Professor",
  divisionName: null,
  departmentName: "Medicine",
  identityImageEndpoint: "",
  roleCategory: null,
  overview: null,
  pubCount: 0,
  grantCount: 0,
};

describe("PersonRow", () => {
  it("shows NO appointment label for full-time faculty (the default appointment, Unit Page v2)", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FULL_TIME_FACULTY" }} />);
    expect(screen.queryByText(/Full-time faculty/)).toBeNull();
  });

  it("formats VOLUNTARY_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "VOLUNTARY_FACULTY" }} />);
    expect(screen.getByText("Voluntary faculty")).toBeTruthy();
  });

  it("formats ADJUNCT_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "ADJUNCT_FACULTY" }} />);
    expect(screen.getByText("Adjunct faculty")).toBeTruthy();
  });

  it("formats COURTESY_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "COURTESY_FACULTY" }} />);
    expect(screen.getByText("Courtesy faculty")).toBeTruthy();
  });

  it("formats FACULTY_EMERITUS enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FACULTY_EMERITUS" }} />);
    expect(screen.getByText("Faculty emeritus")).toBeTruthy();
  });

  it("formats INSTRUCTOR enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "INSTRUCTOR" }} />);
    expect(screen.getByText("Instructor")).toBeTruthy();
  });

  it("formats LECTURER enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "LECTURER" }} />);
    expect(screen.getByText("Lecturer")).toBeTruthy();
  });

  it("formats POSTDOC enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "POSTDOC" }} />);
    expect(screen.getByText("Postdoc")).toBeTruthy();
  });

  it("formats FELLOW enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FELLOW" }} />);
    expect(screen.getByText("Fellow")).toBeTruthy();
  });

  it("formats RESEARCH_STAFF enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "RESEARCH_STAFF" }} />);
    expect(screen.getByText("Research staff")).toBeTruthy();
  });

  it("formats DOCTORAL_STUDENT enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "DOCTORAL_STUDENT" }} />);
    expect(screen.getByText("Doctoral student")).toBeTruthy();
  });

  it("always renders both stat lines, with an em dash for zero (Unit Page v2)", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 0, grantCount: 0 }} />
    );
    expect(container.textContent).toContain("— pubs");
    expect(container.textContent).toContain("— grants");
  });

  it("uses singular 'pub' when N=1, plural 'pubs' otherwise", () => {
    const { container: c1 } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 1, grantCount: 0 }} />
    );
    expect(c1.textContent).toContain("1 pub");
    expect(c1.textContent).not.toContain("pubs");

    const { container: c2 } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 5, grantCount: 0 }} />
    );
    expect(c2.textContent).toContain("5 pubs");
  });

  it("renders department/division line with middle-dot when division present", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, divisionName: "Cardiology", departmentName: "Medicine" }} />
    );
    expect(container.textContent).toContain("Cardiology · Department of Medicine");
  });

  it("renders 'Department of {Name}' when no division", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, divisionName: null, departmentName: "Medicine" }} />
    );
    expect(container.textContent).toContain("Department of Medicine");
    expect(container.textContent).not.toContain("·");
  });

  it("component exports (RED: implementation pending Plan 08)", () => {
    expect(typeof PersonRow).toBe("function");
  });

  // #2202 — the four unit-roster loaders put a display LABEL in `roleCategory`.
  // Before the fix, `isPubliclyDisplayed("Doctoral student")` returned true and
  // every hidden student rendered as a clickable link to a route that 404s.
  describe("#536 carve reads the raw role, not the display label (#2202)", () => {
    const studentHit = {
      ...baseHit,
      preferredName: "Alex Doe",
      roleCategory: "Doctoral student",
      roleCategoryRaw: "doctoral_student",
    };

    it("renders a doctoral student as plain text, never a profile link", () => {
      const { container } = render(<PersonRow hit={studentHit} />);
      expect(container.textContent).toContain("Alex Doe");
      expect(container.querySelector("a")).toBeNull();
    });

    it("hides the suffixed variants too", () => {
      for (const raw of ["doctoral_student_md", "doctoral_student_phd", "doctoral_student_mdphd"]) {
        const { container } = render(
          <PersonRow hit={{ ...studentHit, roleCategory: "MD student", roleCategoryRaw: raw }} />
        );
        expect(container.querySelector("a")).toBeNull();
      }
    });

    it("still links faculty", () => {
      const { container } = render(
        <PersonRow
          hit={{ ...baseHit, roleCategory: "Full-time faculty", roleCategoryRaw: "full_time_faculty" }}
        />
      );
      expect(container.querySelector("a")).not.toBeNull();
    });

    it("de-links rather than leaks when a producer omits roleCategoryRaw", () => {
      // Fail-closed fallback: the label alone is unrecognized.
      const { container } = render(
        <PersonRow hit={{ ...baseHit, roleCategory: "Doctoral student" }} />
      );
      expect(container.querySelector("a")).toBeNull();
    });
  });

  // #2519 — Cornell (Ithaca) external member render.
  describe("primary institution badge (non-WCMC only)", () => {
    it("badges an HSS scholar and shows nothing for a WCMC one", () => {
      const { unmount } = render(<PersonRow hit={{ ...baseHit, primaryOrgCode: "HSS" }} />);
      expect(screen.getByText("Hospital for Special Surgery")).toBeTruthy();
      unmount();
      render(<PersonRow hit={{ ...baseHit, primaryOrgCode: "WCMC" }} />);
      expect(screen.queryByText(/Weill Cornell Medicine/)).toBeNull();
    });
  });

  describe("external CTSC feed member (no SPS profile)", () => {
    const ctscHit: DepartmentFacultyHit = {
      ...baseHit,
      cwid: "ctsc:42",
      preferredName: "Grace Hopper",
      slug: "",
      isExternal: true,
      externalInstitution: "Hospital for Special Surgery",
    };

    it("renders a plain name with no link and the feed institution badge", () => {
      const { container } = render(<PersonRow hit={ctscHit} />);
      expect(screen.queryByRole("link", { name: "Grace Hopper" })).toBeNull();
      expect(within(container).getByText("Grace Hopper")).toBeTruthy();
      expect(within(container).getByText("Hospital for Special Surgery")).toBeTruthy();
    });
  });

  describe("external (Cornell) member", () => {
    const externalHit: DepartmentFacultyHit = {
      ...baseHit,
      cwid: "ab123",
      preferredName: "Ada Byron",
      slug: "",
      isExternal: true,
      externalProfileUrl: "https://www.cornell.edu/search/sso/people.cfm?netid=ab123",
      externalInstitution: "Cornell University",
    };

    it("links out to the Cornell directory in a new tab instead of a WCM profile", () => {
      render(<PersonRow hit={externalHit} />);
      const link = screen.getByRole("link", { name: "Ada Byron" });
      expect(link.getAttribute("href")).toBe(
        "https://www.cornell.edu/search/sso/people.cfm?netid=ab123",
      );
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("renders the Cornell University badge", () => {
      render(<PersonRow hit={externalHit} />);
      expect(screen.getByText("Cornell University")).toBeTruthy();
    });

    it("does not render a WCM profile link (no PersonPopover, no profilePath)", () => {
      const { container } = render(<PersonRow hit={externalHit} />);
      const link = screen.getByRole("link", { name: "Ada Byron" });
      expect(link.getAttribute("href")).not.toContain("/scholar/");
      // Exactly one link on the row — the external anchor — not a popover trigger.
      expect(container.querySelectorAll("a").length).toBe(1);
    });

    it("a normal WCM hit renders unaffected — no Cornell badge, ordinary profile link", () => {
      render(<PersonRow hit={{ ...baseHit, roleCategory: "FULL_TIME_FACULTY" }} />);
      expect(screen.queryByText("Cornell University")).toBeNull();
      const link = screen.getByRole("link", { name: "Jane Smith" });
      expect(link.getAttribute("target")).toBeNull();
    });

    it("renders the raw Cornell dept with no 'Department of' prefix and no division segment", () => {
      const { container } = render(
        <PersonRow
          hit={{
            ...externalHit,
            departmentName: "CIO - IT Security Office",
            divisionName: "Some Division",
          }}
        />,
      );
      expect(container.textContent).toContain("CIO - IT Security Office");
      expect(container.textContent).not.toContain("Department of");
      expect(container.textContent).not.toContain("Some Division");
    });

    it("renders no department line at all when the external member has no dept", () => {
      const { container } = render(
        <PersonRow hit={{ ...externalHit, departmentName: "" }} />,
      );
      expect(container.textContent).not.toContain("Department of");
    });

    it("a WCM hit still renders 'Department of …' unaffected by the external fix", () => {
      const { container } = render(
        <PersonRow hit={{ ...baseHit, departmentName: "Medicine" }} />,
      );
      expect(container.textContent).toContain("Department of Medicine");
    });
  });

  describe("Unit Page v2 appointment + meta lines", () => {
    it("joins a non-full-time role and a non-WCMC institution: '{role} at {institution}'", () => {
      render(
        <PersonRow
          hit={{ ...baseHit, roleCategory: "VOLUNTARY_FACULTY", primaryOrgCode: "HSS" }}
        />,
      );
      expect(screen.getByText("Voluntary faculty at Hospital for Special Surgery")).toBeTruthy();
    });

    it("drops the role label when a narrower Appointment chip is active", () => {
      render(
        <PersonRow
          hit={{ ...baseHit, roleCategory: "VOLUNTARY_FACULTY", primaryOrgCode: "HSS" }}
          activeAppointment="Affiliated faculty"
        />,
      );
      expect(screen.queryByText(/Voluntary faculty/)).toBeNull();
      expect(screen.getByText("Hospital for Special Surgery")).toBeTruthy();
    });

    it("renders no uppercase role tag beside the name", () => {
      const { container } = render(
        <PersonRow hit={{ ...baseHit, roleCategory: "POSTDOC" }} activeAppointment="Postdocs & non-faculty" />,
      );
      expect(container.textContent).not.toContain("Postdoc");
    });

    it("on the department's own roster shows only the division (no 'Department of')", () => {
      const { container, unmount } = render(
        <PersonRow hit={{ ...baseHit, divisionName: "Cardiology" }} departmentContext />,
      );
      expect(container.textContent).toContain("Cardiology");
      expect(container.textContent).not.toContain("Department of");
      unmount();
      const { container: c2 } = render(<PersonRow hit={baseHit} departmentContext />);
      expect(c2.textContent).not.toContain("Department of");
    });

    it("clamps the overview snippet to two lines", () => {
      const { container } = render(
        <PersonRow hit={{ ...baseHit, overview: "Studies widgets." }} />,
      );
      const p = within(container).getByText("Studies widgets.");
      expect(p.className).toContain("line-clamp-2");
    });
  });
});

describe("PersonRow TOPICS (MeSH) chips — Unit Page v2", () => {
  const ftHit: DepartmentFacultyHit = {
    ...baseHit,
    roleCategory: "Full-time faculty",
    roleCategoryRaw: "full_time_faculty",
  };
  const mesh = [
    { ui: "D000001", label: "Alpha Term" },
    { ui: null, label: "Legacy Term" },
  ];
  const methods = [{ value: "sc::Imaging", familyLabel: "Imaging", exemplarTools: [] }];

  it("renders the TOPICS label and linked chips by default", () => {
    const { container } = render(<PersonRow hit={ftHit} meshChips={mesh} methodChips={methods} />);
    const row = within(container);
    expect(row.getByText("TOPICS")).toBeTruthy();
    const list = row.getByRole("list", { name: "Research topics" });
    const link = within(list).getByRole("link", { name: "Alpha Term" });
    expect(link.getAttribute("href")).toBe("/jane-smith?mesh=D000001#publications");
    // Full label in the title: a long descriptor truncates on a phone.
    expect(link.getAttribute("title")).toBe("Alpha Term — see this topic on the scholar's profile");
    // Mesh mode shows ONE tag row: no wrench method chips.
    expect(row.queryByText("Imaging")).toBeNull();
  });

  it("chips shrink and truncate instead of overflowing the 1fr column", () => {
    const long = "Antineoplastic Combined Chemotherapy Protocols";
    const { container } = render(
      <PersonRow
        hit={ftHit}
        meshChips={[
          { ui: "D000002", label: long },
          { ui: null, label: "Legacy Term" },
        ]}
      />,
    );
    const link = within(container).getByRole("link", { name: long });
    expect(link.className).toContain("max-w-full");
    expect(link.className).toContain("min-w-0");
    expect(within(link).getByText(long).className).toContain("truncate");
    const plain = within(container).getByText("Legacy Term");
    expect(plain.className).toContain("truncate");
    expect(plain.parentElement?.getAttribute("title")).toBe("Legacy Term");
  });

  it("renders a null-ui chip as plain text, not a link", () => {
    const { container } = render(<PersonRow hit={ftHit} meshChips={mesh} />);
    const legacy = within(container).getByText("Legacy Term");
    expect(legacy.tagName).toBe("SPAN");
    expect(legacy.closest("a")).toBeNull();
  });

  it('rowTags="methods" renders the wrench chips and no TOPICS row', () => {
    const { container } = render(
      <PersonRow hit={ftHit} rowTags="methods" meshChips={mesh} methodChips={methods} />,
    );
    const row = within(container);
    expect(row.getByText("Imaging")).toBeTruthy();
    expect(row.queryByText("TOPICS")).toBeNull();
    expect(row.queryByText("Alpha Term")).toBeNull();
  });

  it("mesh mode with method chips but no MeSH terms renders neither row", () => {
    const { container } = render(<PersonRow hit={ftHit} methodChips={methods} />);
    const row = within(container);
    expect(row.queryByText("TOPICS")).toBeNull();
    expect(row.queryByText("Imaging")).toBeNull();
  });

  it("external and hidden-role rows render no MeSH links", () => {
    const ext = render(
      <PersonRow
        hit={{ ...ftHit, isExternal: true, externalProfileUrl: "https://example.org/p" }}
        meshChips={mesh}
      />,
    );
    expect(within(ext.container).queryByText("TOPICS")).toBeNull();
    expect(within(ext.container).queryByText("Alpha Term")).toBeNull();

    const hidden = render(
      <PersonRow
        hit={{ ...ftHit, roleCategory: "Doctoral student", roleCategoryRaw: "doctoral_student" }}
        meshChips={mesh}
      />,
    );
    expect(within(hidden.container).queryByText("TOPICS")).toBeNull();
    expect(within(hidden.container).queryByText("Alpha Term")).toBeNull();
  });
});
