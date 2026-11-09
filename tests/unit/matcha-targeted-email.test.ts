/** Matcha targeted messages: `buildTargetedEmail` (the "Email individually" per-person body) and
 *  the plain-text → HTML copy (`emailBodyToHtml`). */
import { describe, expect, it } from "vitest";

import {
  buildEml,
  buildTargetedEmail,
  emailBodyToHtml,
  parseEmailBody,
} from "@/lib/edit/matcha-email";

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

describe("buildEml", () => {
  const decode = (b64: string) =>
    new TextDecoder().decode(
      Uint8Array.from(atob(b64.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
    );
  const eml = buildEml({
    to: "ada@researcher.example.org",
    subject: "Northwind Bio collaboration: café research",
    body: "Dear Dr. Example,\n\nWhy I thought of you:\n• One\n• Two",
  });
  const [head, ...parts] = eml.split("--matcha-alt-boundary");

  it("is an unsent draft addressed to the person, with a UTF-8 encoded subject", () => {
    expect(head).toMatch(/^X-Unsent: 1\r\n/);
    expect(head).toContain("To: ada@researcher.example.org\r\n");
    const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)![1];
    expect(decode(subject)).toBe("Northwind Bio collaboration: café research");
    expect(head).toContain('Content-Type: multipart/alternative; boundary="matcha-alt-boundary"');
    expect(eml.endsWith("--matcha-alt-boundary--\r\n")).toBe(true);
  });

  it("carries the plain text and the HTML (real list, bold label)", () => {
    const body = (part: string) => decode(part.split("\r\n\r\n")[1].trim());
    expect(parts[0]).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body(parts[0])).toBe("Dear Dr. Example,\r\n\r\nWhy I thought of you:\r\n• One\r\n• Two");
    expect(parts[1]).toContain("Content-Type: text/html; charset=UTF-8");
    const html = body(parts[1]);
    expect(html).toContain("<b>Why I thought of you:</b>");
    expect(html).toContain("<ul><li>One</li><li>Two</li></ul>");
  });

  it("keeps a header on one line", () => {
    expect(buildEml({ to: "a@b.org", subject: "Line\r\nBcc: x@y.org", body: "x" })).toContain(
      "Subject: Line Bcc: x@y.org\r\n",
    );
  });
});
