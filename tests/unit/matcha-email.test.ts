/** Matcha contact: the standard outreach text and the `mailto:` builder. */
import { describe, expect, it } from "vitest";

import {
  MATCHA_EMAIL_NO_REQUESTER,
  addressList,
  buildGroupEmail,
  buildMailto,
  buildPersonEmail,
  emailFocus,
  fillTemplate,
  salutationSurname,
} from "@/lib/edit/matcha-email";

describe("buildGroupEmail", () => {
  it("names the requester when the search has one", () => {
    const { subject, body } = buildGroupEmail({
      focus: "antibody-drug conjugates",
      requester: "Northwind Bio",
      officerName: "Olive Officer",
    });
    expect(subject).toBe("Possible industry collaboration: antibody-drug conjugates");
    expect(body).toBe(
      "Dear colleague,\n\n" +
        "I'm reaching out because Northwind Bio is looking for Weill Cornell investigators working on antibody-drug conjugates. Your research came up as a strong match.\n\n" +
        "Would you be open to a brief conversation about a possible collaboration? I'm happy to share more details.\n\n" +
        "Best regards,\nOlive Officer",
    );
  });

  it("falls back to 'an industry partner' with no requester", () => {
    for (const requester of [undefined, null, "", "   "]) {
      const { body } = buildGroupEmail({ focus: "obesity", requester, officerName: "O" });
      expect(body).toContain(`because ${MATCHA_EMAIL_NO_REQUESTER} is looking`);
    }
  });

  it("leaves the sign-off blank when the officer is unknown", () => {
    expect(buildGroupEmail({ focus: "x" }).body.endsWith("Best regards,\n")).toBe(true);
  });
});

describe("buildPersonEmail", () => {
  const ctx = { focus: "obesity", requester: "Acme Labs", officerName: "Olive Officer" };

  it("greets by surname and adds the partnership angle after the first paragraph", () => {
    const { subject, body } = buildPersonEmail({
      ...ctx,
      name: "Jane Q. Doe",
      angle: "Could lead a trial with an existing patient cohort.",
    });
    expect(subject).toBe("Possible industry collaboration: obesity");
    const paras = body.split("\n\n");
    expect(paras[0]).toBe("Dear Dr. Doe,");
    expect(paras[1]).toContain("Acme Labs is looking for");
    expect(paras[2]).toBe(
      "Why we thought of you: Could lead a trial with an existing patient cohort.",
    );
    expect(paras[3]).toMatch(/^Would you be open/);
  });

  it("has no angle paragraph when the brief has none", () => {
    const { body } = buildPersonEmail({ ...ctx, name: "Jane Doe", angle: "" });
    expect(body).not.toContain("Why we thought of you");
    expect(body.split("\n\n")).toHaveLength(4);
  });

  it("falls back to 'Dear colleague,' with no usable name", () => {
    expect(buildPersonEmail({ ...ctx, name: "" }).body.startsWith("Dear colleague,")).toBe(true);
  });
});

describe("salutationSurname", () => {
  it("skips generational suffixes and unit disambiguation, keeping case", () => {
    expect(salutationSurname("Sam Smith Jr")).toBe("Smith");
    expect(salutationSurname("Ana del Rio (Radiology)")).toBe("Rio");
    expect(salutationSurname("Mary Smith-Jones")).toBe("Smith-Jones");
  });
});

describe("emailFocus", () => {
  it("drops the '{requester} — ' prefix from the title", () => {
    expect(emailFocus("Acme Labs — obesity", "Acme Labs")).toBe("obesity");
    expect(emailFocus("My renamed search", "Acme Labs")).toBe("My renamed search");
    expect(emailFocus("Acme Labs — obesity", null)).toBe("Acme Labs — obesity");
  });
});

describe("buildMailto", () => {
  it("encodes subject and body, comma-joins Bcc, and puts the officer in To", () => {
    const href = buildMailto({
      to: "officer@example.org",
      bcc: ["a@example.org", "b+x@example.org"],
      subject: "Hello & welcome?",
      body: "Line 1\nLine 2 = 100%",
    });
    expect(href).toBe(
      "mailto:officer@example.org?bcc=a@example.org,b%2Bx@example.org" +
        "&subject=Hello%20%26%20welcome%3F&body=Line%201%0D%0ALine%202%20%3D%20100%25",
    );
  });

  it("omits Bcc when there is none and To when unknown", () => {
    expect(buildMailto({ subject: "s", body: "b" })).toBe("mailto:?subject=s&body=b");
  });
});

it("addressList joins with semicolons for Outlook", () => {
  expect(addressList(["a@x.org", "b@x.org"])).toBe("a@x.org; b@x.org");
});

it("fillTemplate leaves unknown placeholders as typed", () => {
  expect(fillTemplate("{a} {b}", { a: "1" })).toBe("1 {b}");
});
