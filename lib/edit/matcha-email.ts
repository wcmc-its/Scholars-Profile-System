/**
 * Matcha contact: the standard outreach text and the `mailto:` builder. CLIENT-SAFE (the panel
 * bundles it): never import `@/lib/db` or anything server-only here.
 *
 * The templates are plain constants so the wording is easy to change in one place. Placeholders
 * are `{name}`; an unknown placeholder is left as typed.
 *
 * Nothing is sent from Scholars: the officer's own mail app composes, from a `mailto:` link, or
 * the officer pastes the copied addresses into Bcc. A `mailto:` body is plain text only, so the
 * messages are written to read well as plain text; Copy also puts an HTML version (real bullets,
 * bold labels) on the clipboard (`emailBodyToHtml`).
 */
import { TITLE_ORG_JOIN } from "@/lib/api/matcha-contract";
import { stripUnitDisambiguation } from "@/lib/name-sort";

/** `{focus}` = the search's focus (its title without the requester prefix). */
export const MATCHA_EMAIL_SUBJECT = "Possible industry collaboration: {focus}";

/** The group (Bcc) body. `{requesterPhrase}`, `{focus}`, `{signature}`. */
export const MATCHA_EMAIL_BODY =
  "Dear colleague,\n\n" +
  "I'm reaching out because {requesterPhrase} is looking for Weill Cornell investigators working on {focus}, and your work stood out.\n\n" +
  "Would you be open to a brief conversation about a possible collaboration? I'm happy to share more details.\n\n" +
  "{signature}";

/** The per-person greeting. */
export const MATCHA_EMAIL_PERSON_GREETING = "Dear Dr. {lastName},";

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

/** "Sleep apnea in older adults" → "sleep apnea in older adults", for use
 *  mid-sentence. Only an ordinary capitalised first word is lowered: "HIV vaccines" and
 *  "McArdle disease" stay as they are. */
export function focusPhrase(focus: string): string {
  const f = focus.trim();
  return /^[A-Z][a-z]+(?![A-Za-z])/.test(f) ? f[0].toLowerCase() + f.slice(1) : f;
}

export type EmailContext = {
  /** The search focus (see `emailFocus`). */
  focus: string;
  /** Who is asking: the officer's correction wins over the model's; empty/absent ⇒ fallback. */
  requester?: string | null;
  /** The signing officer; "" leaves the sign-off blank for them to fill in. */
  officerName?: string | null;
  /** The officer's department: the signature's last line, "{dept}, Weill Cornell Medicine". */
  officerDept?: string | null;
};

/** "Best regards," + the officer's name + (when known) "{dept}, Weill Cornell Medicine". */
export function emailSignature(ctx: Pick<EmailContext, "officerName" | "officerDept">): string {
  const dept = ctx.officerDept?.trim();
  const lines = ["Best regards,", ctx.officerName?.trim() ?? ""];
  if (dept) lines.push(`${dept}, Weill Cornell Medicine`);
  return lines.join("\n");
}

function vars(ctx: EmailContext): Record<string, string> {
  return {
    focus: focusPhrase(ctx.focus) || "your area of research",
    requesterPhrase: ctx.requester?.trim() || MATCHA_EMAIL_NO_REQUESTER,
    officerName: ctx.officerName?.trim() ?? "",
    signature: emailSignature(ctx),
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

/** "Dear Dr. {lastName}," — or "Dear colleague," when the name gives no surname. */
export function personGreeting(name: string): string {
  const surname = salutationSurname(name);
  return surname
    ? fillTemplate(MATCHA_EMAIL_PERSON_GREETING, { lastName: surname })
    : "Dear colleague,";
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

/** The two labels of the targeted message, bold in the HTML copy and the preview. */
export const MATCHA_EMAIL_WHY_LABEL = "Why I thought of you:";
export const MATCHA_EMAIL_IDEA_LABEL = "One idea to discuss:";
/** The plain-text bullet: a bullet character and a space. */
export const EMAIL_BULLET = "• ";
/** The targeted message's opening when the officer left the pitch empty. */
export const MATCHA_EMAIL_FALLBACK_PITCH =
  "{requesterPhrase} is looking for Weill Cornell investigators working on {focus}.";
export const MATCHA_EMAIL_TARGETED_ASK =
  "Would you be open to a brief conversation? I'm happy to share more details.";

/**
 * One investigator's TARGETED message (the "Email individually" review queue), plain text:
 *
 *   Dear Dr. {lastName},
 *   {pitch}                        (or the fallback sentence)
 *   Why I thought of you:          (only with bullets)
 *   • {bullet}
 *   One idea to discuss: {idea}    (only with an idea)
 *   {ask}
 *   {signature}
 *
 * The bullets and idea come already written to the reader (`generateEmailLines`); the brief's
 * own third-person text never goes into the message.
 */
export function buildTargetedEmail(
  ctx: EmailContext & {
    name: string;
    pitch?: string | null;
    /** The drafted subject; empty ⇒ the template subject. */
    subject?: string | null;
    bullets?: readonly string[] | null;
    idea?: string | null;
  },
): { subject: string; body: string } {
  const v = vars(ctx);
  const pitch = ctx.pitch?.trim() || fillTemplate(MATCHA_EMAIL_FALLBACK_PITCH, v);
  const bullets = (ctx.bullets ?? []).map((b) => b.trim()).filter(Boolean);
  const idea = ctx.idea?.trim();
  const paragraphs = [
    personGreeting(ctx.name),
    pitch[0].toUpperCase() + pitch.slice(1),
    bullets.length > 0
      ? [MATCHA_EMAIL_WHY_LABEL, ...bullets.map((b) => EMAIL_BULLET + b)].join("\n")
      : "",
    idea ? `${MATCHA_EMAIL_IDEA_LABEL} ${idea}` : "",
    MATCHA_EMAIL_TARGETED_ASK,
    v.signature,
  ].filter(Boolean);
  return {
    subject: ctx.subject?.trim() || fillTemplate(MATCHA_EMAIL_SUBJECT, v),
    body: paragraphs.join("\n\n"),
  };
}

/** A plain-text message as blocks: paragraphs of lines (a known label split off so it can be
 *  bold) and bullet lists. Shared by the HTML copy and the dialog's preview. */
export type EmailBlock =
  { kind: "p"; lines: { label: string; text: string }[] } | { kind: "ul"; items: string[] };

const BOLD_LABELS = [MATCHA_EMAIL_WHY_LABEL, MATCHA_EMAIL_IDEA_LABEL];
const BULLET_LINE = /^\s*[•*-]\s+/;

export function parseEmailBody(body: string): EmailBlock[] {
  const blocks: EmailBlock[] = [];
  for (const para of body.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    let current: EmailBlock | null = null;
    for (const line of para.split("\n")) {
      if (BULLET_LINE.test(line)) {
        if (current?.kind !== "ul") blocks.push((current = { kind: "ul", items: [] }));
        current.items.push(line.replace(BULLET_LINE, ""));
      } else {
        if (current?.kind !== "p") blocks.push((current = { kind: "p", lines: [] }));
        const label = BOLD_LABELS.find((l) => line.startsWith(l)) ?? "";
        current.lines.push({ label, text: line.slice(label.length) });
      }
    }
  }
  return blocks;
}

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The HTML copy of a plain-text message: real `<ul>` bullets and the two labels in bold, all text
 * escaped. Outlook renders pasted HTML with no font in Times, hence the wrapper's font.
 */
export function emailBodyToHtml(body: string): string {
  const html = parseEmailBody(body)
    .map((b) =>
      b.kind === "ul"
        ? `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
        : `<p style="margin:0 0 12px">${b.lines
            .map((l) => (l.label ? `<b>${escapeHtml(l.label)}</b>` : "") + escapeHtml(l.text))
            .join("<br>")}</p>`,
    )
    .join("");
  return `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt">${html}</div>`;
}
