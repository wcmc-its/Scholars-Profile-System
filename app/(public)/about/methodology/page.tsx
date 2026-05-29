import { permanentRedirect } from "next/navigation";

/**
 * Retired route. The standalone methodology page was folded into the single
 * /about documentation page (#573 follow-up); its per-surface explanations now
 * live in the /about reference sections, deep-linked via lib/methodology-anchors.
 * This stub 308-redirects any stale inbound link to /about. (Hash fragments
 * aren't sent to the server, so #anchor links land at the top of /about.)
 */
export default function MethodologyRedirect(): never {
  permanentRedirect("/about");
}
