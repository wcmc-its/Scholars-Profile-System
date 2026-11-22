/**
 * Home-page /methods links must not prefetch. /methods pages are force-dynamic,
 * so a viewport prefetch is a full origin render; on 2026-11-21 home-page views
 * alone caused ~446k of them.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const linkProps: Array<Record<string, unknown>> = [];
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    linkProps.push(props);
    return <a href={String(props.href)}>{props.children}</a>;
  },
}));

import { MethodBeaconLink } from "@/components/home/method-beacon-link";

describe("MethodBeaconLink", () => {
  it("renders a next/link with prefetch disabled", () => {
    render(
      <MethodBeaconLink
        href="/methods/animal-cell-models"
        event="home_method_category_click"
        slug="animal-cell-models"
      >
        Animal and cell models
      </MethodBeaconLink>,
    );
    expect(linkProps).toHaveLength(1);
    expect(linkProps[0].href).toBe("/methods/animal-cell-models");
    expect(linkProps[0].prefetch).toBe(false);
  });
});
