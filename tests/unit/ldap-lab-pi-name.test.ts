import { describe, expect, it } from "vitest";
import { labPiNameKey, personNameKey } from "@/lib/sources/ldap";

describe("labPiNameKey", () => {
  it("extracts the PI from HR's `<Given Surname> Research|Lab` unit names", () => {
    expect(labPiNameKey("Sallie Permar Research")).toBe("sallie permar");
    expect(labPiNameKey("Parag Goyal Research")).toBe("parag goyal");
    expect(labPiNameKey("Jeffrey P Greenfield Lab")).toBe("jeffrey greenfield");
    expect(labPiNameKey("Genevieve Fouda Research Program")).toBe("genevieve fouda");
    expect(labPiNameKey("Chenxu Zhu Start Up")).toBe("chenxu zhu");
    expect(labPiNameKey("Lisa Roth Clinical Research")).toBe("lisa roth");
  });

  it("passes generic two-word units through — the faculty lookup rejects those", () => {
    expect(labPiNameKey("Basic Science Research")).toBe("basic science");
  });

  it("rejects units with no lab suffix or only one token before it", () => {
    for (const unit of [
      "MRI Research Institute",
      "Clinical Research",
      "Administration",
      "Research",
      "",
      null,
    ]) {
      expect(labPiNameKey(unit), unit ?? "null").toBeNull();
    }
  });
});

describe("personNameKey", () => {
  it("drops initials so displayName and given+sn forms collide", () => {
    expect(personNameKey("M. Cary Reid")).toBe("cary reid");
    expect(personNameKey("Sallie R. Permar")).toBe(personNameKey("Sallie Permar"));
    expect(personNameKey("Bernhard Kühn")).toBe("bernhard kuhn");
  });
});
