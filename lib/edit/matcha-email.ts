/**
 * Matcha contact: the standard outreach text and the `mailto:` builder. CLIENT-SAFE (the panel
 * bundles it): never import `@/lib/db` or anything server-only here.
 *
 * The templates are plain constants so the wording is easy to change in one place. Placeholders
 * are `{name}`; an unknown placeholder is left as typed.
 *
 * Nothing is sent from Scholars: the officer's own mail app composes, from a `mailto:` link, or
 * the officer pastes the copied addresses into Bcc.
 */
import { TITLE_ORG_JOIN } from "@/lib/api/matcha-contract";
import { stripUnitDisambiguation } from "@/lib/name-sort";

/** `{focus}` = the search's focus (its title without the requester prefix). */
export const MATCHA_EMAIL_SUBJECT = "Possible industry collaboration: {focus}";

/** The group (Bcc) body. `{requesterPhrase}`, `{focus}`, `{officerName}`. */
export const MATCHA_EMAIL_BODY =
  "Dear colleague,\n\n" +
  "I'm reaching out because {requesterPhrase} is looking for Weill Cornell investigators working on {focus}. Your research came up as a strong match.\n\n" +
  "Would you be open to a brief conversation about a possible collaboration? I'm happy to share more details.\n\n" +
  "Best regards,\n" +
  "{officerName}";

/** The per-person greeting, replacing the group body's first line. */
export const MATCHA_EMAIL_PERSON_GREETING = "Dear Dr. {lastName},";

/** The per-person paragraph inserted after the first paragraph when the brief has an angle. */
export const MATCHA_EMAIL_ANGLE_LINE = "Why we thought of you: {angle}";

/** `{requesterPhrase}` when the search names no requester. */
export const MATCHA_EMAIL_NO_REQUESTER = "an industry partner";

/** Past roughly this many characters some mail apps truncate or refuse a `mailto:` link. */
export const MAILTO_SOFT_LIMIT = 1800;

/** Replace `{key}` placeholders. Unknown keys stay as typed. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/**
 * The focus phrase from the search's displayed title: the requester prefix ("{requester} — ")
 * dropped, so the body never reads "working on Acme — obesity".
 */
export function emailFocus(title: string | null | undefined, requester?: string | null): string {
  const t = (title ?? "").trim();
  const r = (requester ?? "").trim();
  if (r && t.startsWith(`${r}${TITLE_ORG_JOIN}`))
    return t.slice(r.length + TITLE_ORG_JOIN.length).trim();
  return t;
}

export type EmailContext = {
  /** The search focus (see `emailFocus`). */
  focus: string;
  /** Who is asking: the officer's correction wins over the model's; empty/absent ⇒ fallback. */
  requester?: string | null;
  /** The signing officer; "" leaves the sign-off blank for them to fill in. */
  officerName?: string | null;
};

function vars(ctx: EmailContext): Record<string, string> {
  return {
    focus: ctx.focus.trim() || "your area of research",
    requesterPhrase: ctx.requester?.trim() || MATCHA_EMAIL_NO_REQUESTER,
    officerName: ctx.officerName?.trim() ?? "",
  };
}

/** The group (Bcc) message. */
export function buildGroupEmail(ctx: EmailContext): { subject: string; body: string } {
  const v = vars(ctx);
  return {
    subject: fillTemplate(MATCHA_EMAIL_SUBJECT, v),
    body: fillTemplate(MATCHA_EMAIL_BODY, v),
  };
}

/** Generational suffixes skipped when picking the surname for the greeting. */
const NAME_SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;

/** "Jane Q. Doe Jr" → "Doe". The last token of the preferred name, case kept. "" for no name. */
export function salutationSurname(name: string): string {
  const tokens = (stripUnitDisambiguation(name) || name).trim().split(/\s+/).filter(Boolean);
  let end = tokens.length;
  while (end > 1 && NAME_SUFFIXES.test(tokens[end - 1])) end -= 1;
  return (tokens[end - 1] ?? "").replace(/,$/, "");
}

/** One investigator's message: "Dear Dr. {lastName}," and, with an angle, a "Why we thought of
 *  you" paragraph after the first paragraph. */
export function buildPersonEmail(ctx: EmailContext & { name: string; angle?: string | null }): {
  subject: string;
  body: string;
} {
  const group = buildGroupEmail(ctx);
  const surname = salutationSurname(ctx.name);
  const greeting = surname
    ? fillTemplate(MATCHA_EMAIL_PERSON_GREETING, { lastName: surname })
    : "Dear colleague,";
  const paragraphs = group.body.split("\n\n");
  paragraphs[0] = paragraphs[0].replace(/^Dear colleague,/, greeting);
  const angle = ctx.angle?.trim();
  if (angle) paragraphs.splice(2, 0, fillTemplate(MATCHA_EMAIL_ANGLE_LINE, { angle }));
  return { subject: group.subject, body: paragraphs.join("\n\n") };
}

/** An address for a mailto: URL — encoded, with "@" kept literal (some clients mishandle %40). */
function encAddr(a: string): string {
  return encodeURIComponent(a.trim()).replace(/%40/g, "@");
}

/** `mailto:` link. Every part is `encodeURIComponent`-encoded; Bcc addresses are comma-joined. */
export function buildMailto(parts: {
  to?: string | null;
  bcc?: readonly string[];
  subject: string;
  body: string;
}): string {
  const query = [
    parts.bcc && parts.bcc.length > 0 ? `bcc=${parts.bcc.map(encAddr).join(",")}` : null,
    `subject=${encodeURIComponent(parts.subject)}`,
    // Mail clients expect CRLF line breaks in a mailto body.
    `body=${encodeURIComponent(parts.body.replace(/\r?\n/g, "\r\n"))}`,
  ].filter(Boolean);
  return `mailto:${parts.to ? encAddr(parts.to) : ""}?${query.join("&")}`;
}

/** The addresses as Outlook takes them in Bcc. */
export function addressList(emails: readonly string[]): string {
  return emails.join("; ");
}
