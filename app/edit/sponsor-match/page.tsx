/**
 * `/edit/sponsor-match` — the pre-Matcha URL, redirected to `/edit/matcha`.
 *
 * The rename moved the page, and bookmarks do not move with it. The console's own history drawer
 * deep-links here too, so this is not only about what someone saved — it is about links the app
 * itself already handed out.
 *
 * `permanentRedirect` (308), not `redirect` (307): the old URL is not coming back. That also lets
 * a browser cache it, so the hop costs nothing after the first visit.
 *
 * No auth or flag gate here on purpose — this is a signpost, not a surface. `/edit/matcha` is the
 * real boundary and re-checks both; gating the signpost would only mean maintaining the same
 * verdict in two places, and a wrong one here would 404 a person who is allowed in.
 */
import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function SponsorMatchRedirect(): never {
  permanentRedirect("/edit/matcha");
}
