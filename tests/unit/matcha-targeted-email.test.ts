/** Matcha targeted messages: `buildTargetedEmail` (the "Email individually" per-person body). */
import { describe, expect, it } from "vitest";

import { buildTargetedEmail } from "@/lib/edit/matcha-email";

const BASE = {
  focus: "antibody-drug conjugates",
  requester: "Northwind Bio",
  officerName: "Olive Officer",
  name: "Ada Q. Example",
};
const P1 =
  "I'm reaching out because Northwind Bio is looking for Weill Cornell investigators working on antibody-drug conjugates. Your research came up as a strong match.";
const CLOSING =
  "Would you be open to a brief conversation about a possible collaboration? I'm happy to share more details.\n\n" +
  "Best regards,\nOlive Officer";
const PITCH = "Northwind Bio wants partners to test new linker chemistry in solid tumors.";

describe("buildTargetedEmail", () => {
  it("assembles every part in order", () => {
    const { subject, body } = buildTargetedEmail({
      ...BASE,
      pitch: PITCH,
      angle: "Could lead validation in existing tumor models.",
      angleRole: "Validation partner",
      topic: "Linker stability in xenograft studies",
    });
    expect(subject).toBe("Possible industry collaboration: antibody-drug conjugates");
    expect(body).toBe(
      [
        "Dear Dr. Example,",
        P1,
        PITCH,
        "Why we thought of you: Validation partner. Could lead validation in existing tumor models.",
        "A possible starting point: Linker stability in xenograft studies",
        CLOSING,
      ].join("\n\n"),
    );
  });

  it("drops the role lead cleanly when there is no role", () => {
    const { body } = buildTargetedEmail({ ...BASE, pitch: PITCH, angle: "Could lead validation." });
    expect(body).toContain("\n\nWhy we thought of you: Could lead validation.\n\n");
  });

  it("omits the Why line when there is no angle, even with a role", () => {
    const { body } = buildTargetedEmail({ ...BASE, pitch: PITCH, angleRole: "Validation partner" });
    expect(body).not.toContain("Why we thought of you");
    expect(body).not.toContain("Validation partner");
  });

  it("omits the topic line when there is no topic", () => {
    const { body } = buildTargetedEmail({ ...BASE, pitch: PITCH, angle: "A." });
    expect(body).not.toContain("A possible starting point");
  });

  it("with an empty pitch and no brief is the plain per-person message", () => {
    const { body } = buildTargetedEmail({ ...BASE, pitch: "   " });
    expect(body).toBe(["Dear Dr. Example,", P1, CLOSING].join("\n\n"));
    expect(body).not.toMatch(/\n{3,}/);
  });

  it("keeps a role that already ends in punctuation as is", () => {
    const { body } = buildTargetedEmail({
      ...BASE,
      angle: "Runs trials.",
      angleRole: "Trial lead!",
    });
    expect(body).toContain("Why we thought of you: Trial lead! Runs trials.");
  });
});
