/**
 * Scholar-assigned proxy editor — grant notifications (#779 / scholar-proxy-spec
 * § Notification, D2). On a successful grant BOTH the proxy and the scholar are
 * emailed; the scholar copy branches on who granted (self vs a superuser on
 * their behalf — CD-7). Revoke sends nothing (D2 / open-question 1, confirmed:
 * silent on revoke).
 *
 * Best-effort and DORMANT BY CONFIGURATION, exactly like the "Request a change"
 * mailer: nothing is sent until ops verify the SES identity and flip
 * `SCHOLAR_PROXY_NOTIFY_SEND=on`. The grant has ALREADY committed by the time
 * this runs (commit-first, notify-after — CD-7), so any failure here is logged
 * and swallowed; it never affects the grant outcome.
 *
 * The proxy is typically pure administrative staff with no Scholar row, so their
 * name/email come from the enterprise directory; the scholar's come from the
 * Scholar row (passed in by the caller).
 */
import { sendMail } from "@/lib/edit/mailer";
import { fetchDirectoryPeopleByCwid } from "@/lib/sources/ldap";

const SITE_HOST = "scholars.weill.cornell.edu";

/** Live only when enabled AND a verified sender identity is configured. Off ⇒
 *  every {@link notifyProxyGrant} is an immediate no-op (the grant still
 *  succeeds). */
export function isProxyNotifyConfigured(): boolean {
  return (
    process.env.SCHOLAR_PROXY_NOTIFY_SEND === "on" &&
    typeof process.env.SCHOLARS_MAIL_FROM === "string" &&
    process.env.SCHOLARS_MAIL_FROM.length > 0
  );
}

export type ProxyGrantNotice = {
  proxyCwid: string;
  scholarCwid: string;
  scholarName: string;
  scholarEmail: string | null;
  /** true ⇒ the scholar assigned their own proxy; false ⇒ a superuser did (D1). */
  byScholarSelf: boolean;
  /** The real grantor's cwid — resolved to a display name for the scholar copy
   *  when the grant was superuser-on-behalf. */
  grantorCwid: string;
};

/**
 * Notify the proxy and the scholar of a new grant. Best-effort: returns void,
 * never throws, no-op when dormant.
 */
export async function notifyProxyGrant(notice: ProxyGrantNotice): Promise<void> {
  if (!isProxyNotifyConfigured()) return; // dormant — grant already succeeded
  try {
    // Resolve the proxy (and, for a superuser-on-behalf grant, the grantor) from
    // the enterprise directory in one batch.
    const toResolve = notice.byScholarSelf
      ? [notice.proxyCwid]
      : [notice.proxyCwid, notice.grantorCwid];
    const people = await fetchDirectoryPeopleByCwid(toResolve);
    const byCwid = new Map(people.map((p) => [p.cwid.toLowerCase(), p]));
    const proxy = byCwid.get(notice.proxyCwid.toLowerCase());
    const proxyName = proxy?.name ?? notice.proxyCwid;
    const grantorName = byCwid.get(notice.grantorCwid.toLowerCase())?.name ?? null;

    const editUrl = `https://${SITE_HOST}/edit/scholar/${notice.scholarCwid}`;

    // To the proxy — what they can do and where.
    if (proxy?.email) {
      await sendMail({
        to: proxy.email,
        subject: `You can now edit ${notice.scholarName}'s Scholars profile`,
        text:
          `Hello ${proxyName},\n\n` +
          `You have been designated as a proxy editor for ${notice.scholarName} ` +
          `(${notice.scholarCwid}) on the WCM Scholars Profile System.\n\n` +
          `You can edit their profile overview and hide misattributed publications. ` +
          `Name, title, and contact details come from WCM systems; the profile URL is ` +
          `set by a Scholars administrator.\n\n` +
          `Edit their profile: ${editUrl}\n\n` +
          `Access can be revoked at any time by ${notice.scholarName} or a Scholars ` +
          `administrator.\n`,
      });
    }

    // To the scholar — copy branches on who granted (CD-7).
    if (notice.scholarEmail) {
      const who = notice.byScholarSelf
        ? `You have designated ${proxyName} (${notice.proxyCwid}) as a proxy editor for your profile.`
        : `A Scholars administrator${grantorName ? ` (${grantorName})` : ""} assigned ` +
          `${proxyName} (${notice.proxyCwid}) as a proxy editor for your profile.`;
      await sendMail({
        to: notice.scholarEmail,
        subject: `A proxy editor was added to your Scholars profile`,
        text:
          `Hello ${notice.scholarName},\n\n` +
          `${who}\n\n` +
          `They can edit your profile overview and hide misattributed publications; ` +
          `they cannot change your name, title, or contact details, or your profile URL.\n\n` +
          `Review or revoke this from your profile editor (https://${SITE_HOST}/edit), ` +
          `or contact a Scholars administrator.\n`,
      });
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "proxy_notify_failed",
        proxy_cwid: notice.proxyCwid,
        scholar_cwid: notice.scholarCwid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
