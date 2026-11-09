/** Matcha targeted messages: `buildTargetedEmail` (the "Email individually" per-person body) and
 *  the plain-text → HTML copy (`emailBodyToHtml`). */
import { describe, expect, it } from "vitest";

import { buildTargetedEmail, emailBodyToHtml, parseEmailBody } from "@/lib/edit/matcha-email";

const BASE = {
  focus: "Antibody-drug conjugates",
  requester: "Northwind Bio",
  officerName: "Olive Officer",
  officerDept: "Example Library",
  name: "Ada Q. Example",
};
const PITCH = "Northwind Bio wants partners to test new linker chemistry in solid tumors.";
const CLOSING =
  "Would you be open to a brief conversation? I'm happy to share more details.\n\n" +
  "Best regards,\nOlive Officer\nExample Library, Weill Cornell Medicine";

describe("buildTargetedEmail", () => {
  it("assembles every part in order, in the second person, with real bullets", () => {
    const { subject, body } = buildTargetedEmail({
      ...BASE,
      pitch: PITCH,
      subject: "Northwind Bio collaboration: linker chemistry",
      bullets: ["Nine tumor-model studies", " Linker stability assays "],
      idea: "linker stability in xenograft studies.",
    });
    expect(subject).toBe("Northwind Bio collaboration: linker chemistry");
    expect(body).toBe(
      [
        "Dear Dr. Example,",
        PITCH,
        "Why I thought of you:\n• Nine tumor-model studies\n• Linker stability assays",
        "One idea to discuss: linker stability in xenograft studies.",
        CLOSING,
      ].join("\n\n"),
    );
    // The pitch appears once: no second "is looking for" paragraph.
    expect(body).not.toContain("is looking for");
  });

  it("falls back to the template subject and a lowercased focus sentence", () => {
    const { subject, body } = buildTargetedEmail({ ...BASE, pitch: "   ", subject: "" });
    expect(subject).toBe("Possible industry collaboration: antibody-drug conjugates");
    expect(body).toBe(
      [
        "Dear Dr. Example,",
        "Northwind Bio is looking for Weill Cornell investigators working on antibody-drug conjugates.",
        CLOSING,
      ].join("\n\n"),
    );
  });

  it("capitalises the fallback with no requester", () => {
    const { body } = buildTargetedEmail({ ...BASE, requester: null, pitch: "" });
    expect(body.split("\n\n")[1]).toMatch(/^An industry partner is looking for/);
  });

  it("leaves out the Why block and idea when there are none", () => {
    const { body } = buildTargetedEmail({ ...BASE, pitch: PITCH, bullets: [" "], idea: "" });
    expect(body).not.toContain("Why I thought of you");
    expect(body).not.toContain("One idea");
    expect(body).not.toMatch(/\n{3,}/);
  });
});

describe("emailBodyToHtml", () => {
  const body = buildTargetedEmail({
    ...BASE,
    pitch: "Tests <script> & more.",
    bullets: ["One", "Two"],
    idea: "this.",
  }).body;

  it("turns bullet lines into a <ul> and bolds the two labels only", () => {
    const html = emailBodyToHtml(body);
    expect(html).toContain(
      '<p style="margin:0 0 12px"><b>Why I thought of you:</b></p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(html).toContain("<b>One idea to discuss:</b> this.");
    expect(html.match(/<b>/g)).toHaveLength(2);
    expect(html).toContain("Best regards,<br>Olive Officer<br>Example Library");
  });

  it("escapes the text", () => {
    expect(emailBodyToHtml(body)).toContain("Tests &lt;script&gt; &amp; more.");
  });

  it("reads an officer's hand-typed '-' bullets too", () => {
    expect(parseEmailBody("Points:\n- a\n- b")).toEqual([
      { kind: "p", lines: [{ label: "", text: "Points:" }] },
      { kind: "ul", items: ["a", "b"] },
    ]);
  });
});
