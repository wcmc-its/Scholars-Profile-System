import { describe, expect, it } from "vitest";

import { buildConsoleLinks } from "@/lib/auth/console-links";
import { GLOBAL_ROLE_HOME } from "@/lib/auth/global-roles";
import { ROLE_LINKS } from "@/components/site/impersonation-banner";

// One front door for the development role. The dropdown, the /edit landing and the
// View-as "can access" list each name it separately; this pins them together.
describe("development role entry points agree", () => {
  it("dropdown row, role home and View-as list all lead with Matcha", () => {
    const [row] = buildConsoleLinks({
      isSuperuser: false,
      isCommsSteward: false,
      managesUnits: false,
      isDeveloper: true,
    });
    expect(row.href).toBe("/edit/matcha");
    expect(GLOBAL_ROLE_HOME.development.href).toBe(row.href);
    expect(ROLE_LINKS.development.map((l) => l.href)).toEqual(["/edit/matcha", "/edit/grant-matcha"]);
  });
});
