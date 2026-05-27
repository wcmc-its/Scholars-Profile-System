/**
 * SESv2 mailer for the self-edit "Request a change" server send (#160 Phase 2,
 * `docs/self-edit-request-change-server-mailer-plan.md`).
 *
 * Dormant until the flag is on AND a verified sender identity is configured —
 * exactly as the CloudFront invalidation in `lib/edit/revalidation.ts` is dormant
 * without its distribution id. While dormant the endpoint returns `503` and the
 * dialog falls back to the Phase-1 client `mailto:` (#494), so nothing changes
 * for users until ops verify the identity, exit the SES sandbox, and flip the
 * flag on.
 *
 * Header-injection guard (SPEC § 6): CR/LF is stripped from the subject and every
 * recipient before the command is built. The body is the only multi-line field
 * and is SESv2 `Simple` text content, which cannot inject headers.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/** Strip CR/LF so a value can't break out of its header (RFC 5322 guard). */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The server send is live only when it is both **enabled** (`SELF_EDIT_REQUEST_
 * CHANGE_SEND=on`) and **configured** (a verified `SCHOLARS_MAIL_FROM` identity).
 * Off ⇒ the endpoint `503`s `send_disabled` and the client uses the `mailto:`.
 */
export function isMailerConfigured(): boolean {
  return (
    process.env.SELF_EDIT_REQUEST_CHANGE_SEND === "on" &&
    typeof process.env.SCHOLARS_MAIL_FROM === "string" &&
    process.env.SCHOLARS_MAIL_FROM.length > 0
  );
}

let _client: SESv2Client | null = null;
function client(): SESv2Client {
  // Region + credentials resolve from the default chain (AWS_REGION / the ECS
  // task role), mirroring `new CloudFrontClient({})` in lib/edit/revalidation.ts.
  _client ??= new SESv2Client({});
  return _client;
}

export type OutboundMail = {
  to: string;
  cc?: string;
  subject: string;
  /** Plain-text body — the message content, not a header. */
  text: string;
};

/**
 * Send one plain-text email via SESv2. Throws on a send failure; the caller maps
 * that to the HTTP status (the endpoint returns `502 send_failed`). The subject
 * and recipients are CR/LF-stripped before the command is built.
 */
export async function sendMail(mail: OutboundMail): Promise<{ messageId: string }> {
  const from = process.env.SCHOLARS_MAIL_FROM;
  if (!from) throw new Error("SCHOLARS_MAIL_FROM is not set");

  const ccAddresses = mail.cc ? [sanitizeHeader(mail.cc)] : undefined;
  const out = await client().send(
    new SendEmailCommand({
      FromEmailAddress: sanitizeHeader(from),
      Destination: {
        ToAddresses: [sanitizeHeader(mail.to)],
        ...(ccAddresses ? { CcAddresses: ccAddresses } : {}),
      },
      Content: {
        Simple: {
          Subject: { Data: sanitizeHeader(mail.subject), Charset: "UTF-8" },
          Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
        },
      },
    }),
  );
  return { messageId: out.MessageId ?? "" };
}
