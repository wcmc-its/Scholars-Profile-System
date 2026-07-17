/**
 * `/api/edit/sponsor-match` — the pre-Matcha path, ALIASED to `/api/edit/matcha`.
 *
 * Sponsor match became Matcha and the route moved. This exists for one reason: a console tab
 * opened BEFORE the rename deployed is still running the old client bundle, and that bundle
 * POSTs here. Without the alias its next search 404s — an officer mid-ask loses the ask, and the
 * paste with it. The window is "until every open tab has reloaded", not "until the next deploy".
 *
 * A re-export, not a redirect: a 307 would work for GET, but the POST carries the paste as a body
 * and this route is the authorization boundary. Re-exporting runs the SAME handlers, so the auth
 * check, the flag gate and the 404 posture are identical by construction rather than by
 * duplication — there is no second implementation here to drift.
 *
 * ⚠ TEMPORARY. Delete this file once no client is plausibly still on the old bundle. It is
 * deliberately the whole file, so deleting it is `rm`, not surgery.
 */
export { POST, GET, DELETE } from "../matcha/route";
