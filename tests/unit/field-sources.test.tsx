/**
 * Per-field data provenance (#511) — the source map, the FieldSourceLine
 * component, and its wiring into the three sourced `/edit` panels.
 *
 * Asserts: every routed attribute has a source label (no panel left unlabeled),
 * the line renders "Source: <system>", and each panel header surfaces it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { FIELD_SOURCE, fieldSource } from "@/lib/edit/field-sources";
import { REQUEST_A_CHANGE, type RequestAttribute } from "@/lib/edit/request-a-change";
import { FieldSourceLine } from "@/components/edit/field-source-line";
import { ReadonlyAttributePanel } from "@/components/edit/readonly-attribute-panel";
import { EntityPanel, type EntityRow } from "@/components/edit/entity-panel";
import { PublicationsCard } from "@/components/edit/publications-card";

describe("FIELD_SOURCE map", () => {
  it("labels every routable attribute (no sourced panel left unlabeled)", () => {
    const routed = Object.keys(REQUEST_A_CHANGE).sort();
    expect(Object.keys(FIELD_SOURCE).sort()).toEqual(routed);
  });

  it("has a non-empty label for each attribute", () => {
    for (const [attr, label] of Object.entries(FIELD_SOURCE)) {
      expect(label, attr).toMatch(/\S/);
    }
  });

  it("maps the expected systems of record", () => {
    expect(fieldSource("name-title")).toBe("Enterprise Directory");
    expect(fieldSource("photo")).toBe("Enterprise Directory");
    expect(fieldSource("appointments")).toBe("ASMS by way of Enterprise Directory");
    expect(fieldSource("education")).toBe("ASMS");
    expect(fieldSource("funding")).toBe("InfoEd");
    expect(fieldSource("publications")).toBe("PubMed (attributed by ReCiter)");
  });
});

describe("FieldSourceLine", () => {
  it.each(Object.keys(REQUEST_A_CHANGE) as RequestAttribute[])(
    "renders 'Source: <system>' for %s",
    (attr) => {
      const { container } = render(<FieldSourceLine attribute={attr} />);
      const line = container.querySelector('[data-slot="field-source"]')!;
      expect(line).not.toBeNull();
      expect(line.textContent).toBe(`Source: ${fieldSource(attr)}`);
    },
  );

  it("renders an overridden label for a multi-source panel (Funding)", () => {
    const { container } = render(
      <FieldSourceLine attribute="funding" label="InfoEd and NIH RePORTER" />,
    );
    const line = container.querySelector('[data-slot="field-source"]')!;
    expect(line.textContent).toBe("Source: InfoEd and NIH RePORTER");
  });
});

describe("panel wiring — source line is surfaced in each sourced panel", () => {
  it("ReadonlyAttributePanel (Name & Title)", () => {
    render(
      <ReadonlyAttributePanel
        attribute="name-title"
        cwid="self01"
        heading="Name & Title"
        description="Name, title, department, email, and ORCID come from the WCM directory."
      />,
    );
    const line = document.querySelector('[data-slot="field-source"]')!;
    expect(line.textContent).toBe("Source: Enterprise Directory");
  });

  it.each([
    ["appointment", "ASMS by way of Enterprise Directory"],
    ["education", "ASMS"],
    ["grant", "InfoEd"],
  ] as const)("EntityPanel (%s) shows its source", (entityType, expected) => {
    type Row = EntityRow & { title: string };
    const { container } = render(
      <EntityPanel<Row>
        slot={`${entityType}-panel`}
        cwid="self01"
        mode="self"
        scholarName="Alex Self"
        entityType={entityType}
        entities={[]}
        copy={{ heading: "H", description: "D", empty: "none", one: "x", other: "xs" }}
        getTitle={(e) => e.title}
        renderMeta={(e) => <>{e.title}</>}
      />,
    );
    const line = within(container).getByText(
      (_, el) => el?.getAttribute("data-slot") === "field-source",
    );
    expect(line.textContent).toBe(`Source: ${expected}`);
  });

  it("PublicationsCard shows the PubMed source", () => {
    render(<PublicationsCard cwid="self01" publications={[]} />);
    const line = document.querySelector('[data-slot="field-source"]')!;
    expect(line.textContent).toBe("Source: PubMed (attributed by ReCiter)");
  });
});
