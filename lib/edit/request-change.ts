/**
 * Server-side resolution for `POST /api/edit/request-change` (#160 Phase 2,
 * `docs/self-edit-request-change-server-mailer-plan.md`).
 *
 * The client sends only `(attribute, issueId, …)`; the recipient is resolved
 * here from the **server-trusted** `REQUEST_A_CHANGE` config — the client never
 * names an address (recipient-tampering guard, SPEC § 6). Only a `route` issue
 * (or an `explain` issue's `fallbackEmail`) sends; a `self-service` issue or a
 * no-fallback `explain` resolves to `no-send` (the UI never POSTs these, so this
 * is defense in depth, not the primary gate).
 */
import { REQUEST_A_CHANGE, type RequestAttribute } from "@/lib/edit/request-a-change";

/** Human label per attribute — drives the email subject + body (mirrors the dialog map). */
const ATTRIBUTE_LABEL: Record<RequestAttribute, string> = {
  "name-title": "Name & Title",
  photo: "Photo",
  appointments: "Positions & appointments",
  education: "Education",
  funding: "Funding",
  "funding-reporter": "Funding",
  publications: "Publications",
  "org-unit": "Org Unit",
  coi: "Conflicts of Interest",
  mentees: "Mentees",
  "profile-url": "Profile URL",
};

/** Type guard — is this client-supplied value a known attribute? */
export function isRequestAttribute(value: unknown): value is RequestAttribute {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REQUEST_A_CHANGE, value);
}

export type ResolvedRoute =
  | {
      kind: "send";
      to: string;
      cc?: string;
      office: string;
      sourceSystem?: string;
      issueLabel: string;
      attributeLabel: string;
    }
  | { kind: "no-send" };

/**
 * Resolve `(attribute, issueId)` to a recipient from the trusted config. Unknown
 * attribute/issue, or a non-routable shape, returns `no-send` (the endpoint 400s
 * `not_routable`).
 */
export function resolveRequestChange(attribute: RequestAttribute, issueId: string): ResolvedRoute {
  const issue = REQUEST_A_CHANGE[attribute]?.issues.find((i) => i.id === issueId);
  if (!issue) return { kind: "no-send" };

  const attributeLabel = ATTRIBUTE_LABEL[attribute];
  const a = issue.action;
  if (a.kind === "route") {
    return {
      kind: "send",
      to: a.email,
      cc: a.cc,
      office: a.office,
      sourceSystem: a.sourceSystem,
      issueLabel: issue.label,
      attributeLabel,
    };
  }
  if (a.kind === "explain" && a.fallbackEmail) {
    return {
      kind: "send",
      to: a.fallbackEmail,
      office: "Scholars support",
      issueLabel: issue.label,
      attributeLabel,
    };
  }
  return { kind: "no-send" };
}

/** Strip CR/LF from a single-line field so the structured body stays well-formed. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** The fixed subject for an attribute — never user free text (no injection vector). */
export function subjectFor(attributeLabel: string): string {
  return `Scholars profile correction — ${attributeLabel}`;
}

/**
 * Compose the structured plain-text body (SPEC § 3.4). The single-line fields
 * (issue, item, source, signature) are CR/LF-collapsed for format integrity; the
 * free-text `detail` is preserved as the multi-line message content. When the
 * actor is acting on another scholar (superuser), the signature names the target
 * — cheap, no name lookup (the receipt-with-name path is deferred).
 */
export function composeBody(opts: {
  issueLabel: string;
  itemLabel?: string;
  sourceSystem?: string;
  detail?: string;
  actorCwid: string;
  targetCwid: string;
}): string {
  const lines = [
    `Issue: ${oneLine(opts.issueLabel)}`,
    `Item: ${opts.itemLabel ? oneLine(opts.itemLabel) : "(whole section)"}`,
  ];
  if (opts.sourceSystem) lines.push(`Source: ${oneLine(opts.sourceSystem)}`);

  const detail = (opts.detail ?? "").trim();
  lines.push("", detail.length > 0 ? detail : "(no additional detail provided)", "");

  const actor = oneLine(opts.actorCwid);
  const onBehalf =
    opts.targetCwid && opts.targetCwid !== opts.actorCwid
      ? ` on behalf of ${oneLine(opts.targetCwid)}`
      : "";
  lines.push(`— Sent from the WCM Scholars profile editor by ${actor}${onBehalf}.`);

  return lines.join("\n");
}

/** The subject of the courtesy receipt sent back to the submitter. */
export function receiptSubjectFor(attributeLabel: string): string {
  return `Your Scholars profile change request — ${attributeLabel}`;
}

/**
 * Compose the courtesy receipt the submitter gets (opt-out, default on). It
 * restates what they sent and where it went — no action required of them. The
 * free-text `detail` is preserved; single-line fields are CR/LF-collapsed.
 */
export function composeReceiptBody(opts: {
  issueLabel: string;
  itemLabel?: string;
  office: string;
  detail?: string;
}): string {
  const lines = [
    "You submitted a change request from your WCM Scholars profile. Here's a copy for your records.",
    "",
    `Issue: ${oneLine(opts.issueLabel)}`,
    `Item: ${opts.itemLabel ? oneLine(opts.itemLabel) : "(whole section)"}`,
    `Routed to: ${oneLine(opts.office)}`,
  ];
  const detail = (opts.detail ?? "").trim();
  lines.push("", detail.length > 0 ? detail : "(no additional detail provided)", "");
  lines.push(
    `${oneLine(opts.office)} will follow up if they need more information — you don't need to do anything else.`,
    "",
    "— WCM Scholars",
  );
  return lines.join("\n");
}
