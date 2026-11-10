/**
 * Crawler refusal for the uncacheable internal-viewer reveal routes
 * (/api/profile/[cwid]/contact-email, /api/profile/[cwid]/sensitive-families).
 *
 * "Internal" includes anonymous on-WCM-network viewers (#866), so a JS-rendering
 * indexer with WCM egress would otherwise receive — and publicly index — data
 * meant only for people on the network. Those routes answer a bot-like UA with
 * the same shape as an external viewer.
 *
 * ponytail: UA regex, not a bot-detection dep. Well-behaved crawlers
 * self-identify; one spoofing a browser UA gets through. Upgrade path: a per-IP
 * WAF rate rule on /api/profile/*.
 */
const BOT_UA = /bot|crawl|spider|slurp|headless|python|curl|wget|httpclient|java\//i;

export function isBotUserAgent(request: Request): boolean {
  return BOT_UA.test(request.headers.get("user-agent") ?? "");
}
