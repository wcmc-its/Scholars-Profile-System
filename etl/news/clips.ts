/**
 * "WCM in the News" media clips → news_mention (Media Highlights).
 *
 * Run via `npm run etl:news-clips`; wired into the nightly chain as ClipsNightly
 * in cdk/lib/etl-stack.ts. External Affairs mails the curated daily digest to
 * External Affairs' clips list; `clips@scholars-mail.weill.cornell.edu` is subscribed,
 * and SES (cdk/lib/inbound-mail-stack.ts) drops each raw message into S3. This
 * step reads the recent messages, parses each clip (headline, outlet, link,
 * the "• Dr. X ..." summary line), and runs the newsroom matcher over it.
 *
 * Every clip lands `pending`: comms reviews all of them in /edit/media-highlights-queue.
 * A clip row is a news_mention with `outlet` set — that column is the whole
 * newsroom-vs-press distinction (the profile renders the two in separate
 * sections). Upsert and review-state discipline are shared with etl:news.
 *
 * Usage:
 *   npm run etl:news-clips                     read INBOUND_MAIL_BUCKET/CLIPS_PREFIX
 *   npm run etl:news-clips -- a.eml b.eml      load hand-forwarded emails
 *
 * Env:
 *   INBOUND_MAIL_BUCKET  SES receipt bucket (required unless files are given);
 *                        shared with etl/opportunities/funding-digest.ts.
 *   CLIPS_PREFIX         key prefix SES writes under (default "clips/").
 *   CLIPS_LOOKBACK_DAYS  re-read window (default 30). The upsert is idempotent,
 *                        so re-reading a message is harmless.
 */
import { readFileSync } from "node:fs";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { dropHeadlineRepeats } from "@/lib/edit/clip-repeats";
import { withEtlRun } from "@/lib/etl-run";
import { articlesToMentions, upsertMentions } from "./index";
import { NEWS_ORIGIN, type ScrapedArticle } from "./seed";

/** Bucket mail must come from WCM. The list address itself is kept out of this
 *  public repo; tighten to it (or to an SES DKIM/SPF verdict) once real list
 *  deliveries show which of those survive the list server. */
export const WCM_FROM_RE = /@med\.cornell\.edu>?\s*$/i;
const SUBJECT_RE = /\bin the news\b/i;
/** Replies to the digest also land in the bucket via the list, usually without
 *  the digest body. Forwards are kept: a forwarded digest carries the whole
 *  digest (that is how the 2026 backlog arrives), and it parses the same. */
export const REPLY_RE = /^\s*re\s*:/i;
/** A zero-clip digest fails the run only while it is this fresh, so one stray
 *  email reds at most a night or two, while real format drift (every new
 *  digest) keeps the step red. */
const UNPARSED_FAIL_MS = 36 * 3_600_000;

// ---------------------------------------------------------------------------
// Minimal MIME reader. The input is a raw RFC 822 message as a latin1 string
// (one char per byte) so 8bit parts survive until their charset is applied.
// ponytail: handles multipart/*, base64, quoted-printable and any charset
// TextDecoder knows; no RFC 2047 encoded-word decoding in headers (we only
// read From/Subject, and only for a substring test).

type Part = { headers: Map<string, string>; body: string };

function splitPart(raw: string): Part {
  const cut = raw.search(/\r?\n\r?\n/);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? "" : raw.slice(cut).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!headers.has(k)) headers.set(k, line.slice(i + 1).trim());
    }
  }
  return { headers, body };
}

function param(value: string | undefined, name: string): string | undefined {
  const m = value?.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodeBody(p: Part): string {
  const cte = (p.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  let bytes: Buffer;
  if (cte === "base64") bytes = Buffer.from(p.body.replace(/\s+/g, ""), "base64");
  else if (cte === "quoted-printable") {
    bytes = Buffer.from(
      p.body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    );
  } else bytes = Buffer.from(p.body, "latin1");
  const charset = param(p.headers.get("content-type"), "charset") ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Walk the MIME tree; return the first text/plain and text/html bodies. */
export function readEmail(raw: string): {
  from: string;
  subject: string;
  /** The Date header, raw; null when absent. */
  date: string | null;
  virusVerdict: string | null;
  spamVerdict: string | null;
  /** SPF/DKIM verdicts SES stamps; logged so the first real deliveries show
   *  which survive the list server before the sender check is tightened. */
  authVerdict: string;
  plain: string | null;
  html: string | null;
} {
  const top = splitPart(raw);
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (p: Part) => {
    const ct = (p.headers.get("content-type") ?? "text/plain").toLowerCase();
    if (ct.startsWith("multipart/")) {
      const boundary = param(p.headers.get("content-type"), "boundary");
      if (!boundary) return;
      const chunks = p.body.split(`--${boundary}`).slice(1);
      for (const c of chunks) {
        if (c.startsWith("--")) break; // closing delimiter
        walk(splitPart(c.replace(/^\r?\n/, "")));
      }
      return;
    }
    if (/attachment/i.test(p.headers.get("content-disposition") ?? "")) return;
    if (ct.startsWith("text/plain") && plain === null) plain = decodeBody(p);
    else if (ct.startsWith("text/html") && html === null) html = decodeBody(p);
  };
  walk(top);
  return {
    from: top.headers.get("from") ?? "",
    subject: top.headers.get("subject") ?? "",
    date: top.headers.get("date") ?? null,
    virusVerdict: top.headers.get("x-ses-virus-verdict") ?? null,
    spamVerdict: top.headers.get("x-ses-spam-verdict") ?? null,
    authVerdict: `spf=${top.headers.get("x-ses-spf-verdict") ?? "none"} dkim=${top.headers.get("x-ses-dkim-verdict") ?? "none"}`,
    plain,
    html,
  };
}

// ---------------------------------------------------------------------------
// Both bodies are reduced to the same line shape Outlook renders as plain text:
//   Headline<https://link>
//   Outlet
//   • Dr. First Last ...

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", bull: "•", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToLines(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/\s+/g, " ")
      .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, dq: string | undefined, sq: string | undefined, inner: string) =>
        // Sentinels, not "<>", so the tag strip below cannot eat the link —
        // including a non-http one, which must still end the previous item.
        `${inner.replace(/<[^>]+>/g, "")}\u0001${(dq ?? sq ?? "").replace(/&amp;/g, "&")}\u0002`,
      )
      .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/td)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\u0001/g, "<").replace(/\u0002/g, ">");
}

/** Outlook Safe Links wraps every href on delivery; the real target is `url=`. */
export function unwrapLink(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.hostname.endsWith(".safelinks.protection.outlook.com")) {
    const inner = u.searchParams.get("url");
    return inner ? unwrapLink(inner) : null;
  }
  // The url becomes an href on a public profile: http(s) only.
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.toString();
}

/**
 * A clip link normalized so one story compares equal across digests: tracking
 * params and the fragment dropped (URL lowercases the host). The path is left
 * alone — this becomes the public href, and not every site redirects a
 * trailing-slash variant; dropHeadlineRepeats catches that case instead.
 * Clips only: the funding digest reads fragments (`#/…` portal routes) to skip.
 */
export function normalizeClipUrl(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}

/** Query params that only track the click — never part of the story's identity. */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ocid|cmpid|smid|sr_share|mkt_tok)$/i;

export type Clip = {
  url: string;
  title: string;
  outlet: string | null;
  summary: string | null;
  publishedAt: string | null;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_LINE = /^(?:mon|tues|wednes|thurs|fri|satur|sun)day,\s+([a-z]+)\s+(\d{1,2}),\s+(\d{4})$/i;
// Any "text<link>" line starts a new item, even one whose link unwrapLink
// refuses — else that item's bullets would be glued onto the previous clip.
const HEADLINE = /^(.+?)\s*<([^\s<>]+)>$/;
const BULLET = /^[•·▪*-]\s*(.+)$/;
const FOOTER = /^for (a complete copy|more news)\b/i;
const INLINE_LINK = /<[^\s<>]+>/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Parse one digest body (already in line shape). Items are read only between
 * the dated header ("Tuesday, September 22, 2026") and the footer, so a
 * forwarder's signature links are never mistaken for clips.
 */
export function parseClipLines(text: string): Clip[] {
  const clips: Clip[] = [];
  let date: string | null = null;
  let cur: (Clip & { bullets: string[] }) | null = null;
  const flush = () => {
    if (!cur) return;
    const summary = cur.bullets.join(" ").trim();
    clips.push({ url: cur.url, title: cur.title, outlet: cur.outlet, summary: summary || null, publishedAt: cur.publishedAt });
    cur = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(CONTROL, "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const d = line.match(DATE_LINE);
    if (d) {
      const m = MONTHS.indexOf(d[1].toLowerCase());
      if (m >= 0) {
        flush();
        date = `${d[3]}-${String(m + 1).padStart(2, "0")}-${d[2].padStart(2, "0")}`;
      }
      continue;
    }
    if (!date) continue;
    if (FOOTER.test(line)) break;
    const b = line.match(BULLET);
    if (b) {
      cur?.bullets.push(b[1].replace(INLINE_LINK, "").trim());
      continue;
    }
    const h = line.match(HEADLINE);
    if (h) {
      flush();
      const unwrapped = unwrapLink(h[2]);
      const url = unwrapped && normalizeClipUrl(unwrapped);
      if (url && url.length <= 512 && h[1].length <= 512) {
        cur = { url, title: h[1], outlet: null, summary: null, publishedAt: date, bullets: [] };
      }
      continue;
    }
    if (cur && cur.outlet === null && cur.bullets.length === 0) cur.outlet = line.slice(0, 255);
    // ponytail: other lines (editor asides like "(This article originally
    // appeared in …)") are dropped; append them to the summary if comms asks.
  }
  flush();
  return clips;
}

/** Every "Dr. First [M.] Last" in the summary — comms' own answer to "who is this about". */
export function doctorNames(summary: string): string[] {
  return [...summary.matchAll(/\bDr\.?\s+((?:[A-Z][\p{L}'’-]*\.?\s+){0,3}[A-Z][\p{L}'’-]+)/gu)].map((m) => m[1]);
}

/** Parse a raw email into clips: the HTML part when it yields any, else the plain part. */
export function parseClipsEmail(raw: string): Clip[] {
  const e = readEmail(raw);
  const fromHtml = e.html ? parseClipLines(htmlToLines(e.html)) : [];
  return fromHtml.length ? fromHtml : e.plain ? parseClipLines(e.plain) : [];
}

export function clipToArticle(c: Clip): ScrapedArticle {
  return {
    url: c.url,
    title: c.title,
    excerpt: c.summary ? c.summary.slice(0, 2000) : null,
    thumbnailUrl: null,
    publishedAt: c.publishedAt,
    cwids: [],
    bodyText: c.summary ?? "",
    // The summary line names people as "Dr. X"; feeding those as tags gives
    // them the TAG (curated) basis. Any other name still matches as BODY.
    tags: c.summary ? doctorNames(c.summary) : [],
    captionText: "",
    outlet: c.outlet ?? "",
  };
}

const NEWSROOM_HOST = new URL(NEWS_ORIGIN).hostname;

/**
 * Mention rows for a batch of clips. Two things the shared newsroom path does
 * not need:
 *  - A clip linking a WCM Newsroom story is dropped: etl:news owns that url,
 *    and a clip row on the same (cwid, url) would move the story into Media
 *    Highlights (reconcile refreshes `outlet`) without review.
 *  - Rows are deduped on (cwid, url). articlesToMentions keys on the story
 *    (title + DATE), so one url in two digests — a repeat or a weekend recap —
 *    would otherwise be created twice and trip @@unique([cwid, url]), rolling
 *    back the whole run.
 */
export function clipMentionRows(
  articles: ScrapedArticle[],
  scholars: Parameters<typeof articlesToMentions>[1],
): ReturnType<typeof articlesToMentions> {
  const offsite = articles.filter((a) => new URL(a.url).hostname !== NEWSROOM_HOST);
  const seen = new Set<string>();
  return articlesToMentions(offsite, scholars).filter((r) => {
    const k = `${r.cwid} ${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------

export type RawEmail = { raw: string; receivedAt: number };

/** Raw messages SES stored under `prefix` in the last CLIPS_LOOKBACK_DAYS. */
export async function readBucketEmails(prefix: string): Promise<RawEmail[]> {
  const bucket = process.env.INBOUND_MAIL_BUCKET;
  if (!bucket) throw new Error("[inbound-mail] INBOUND_MAIL_BUCKET is unset and no .eml files were given");
  const since = Date.now() - (Number(process.env.CLIPS_LOOKBACK_DAYS) || 30) * 86_400_000;
  const s3 = new S3Client({});
  const keys: { Key: string; at: number }[] = [];
  let token: string | undefined;
  do {
    let page;
    try {
      page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    } catch (err) {
      // Sps-InboundMail is a manual, prod-app deploy; until it exists there is
      // simply no mail yet. Anything else (AccessDenied) still fails the run.
      if ((err as { name?: string }).name === "NoSuchBucket") {
        console.warn(`[inbound-mail] bucket ${bucket} does not exist yet (Sps-InboundMail not deployed); nothing to read`);
        return [];
      }
      throw err;
    }
    for (const o of page.Contents ?? []) {
      const at = o.LastModified?.getTime();
      if (o.Key && at !== undefined && at >= since) keys.push({ Key: o.Key, at });
    }
    token = page.NextContinuationToken;
  } while (token);
  const out: RawEmail[] = [];
  for (const { Key, at } of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
    out.push({ raw: Buffer.from(await obj.Body!.transformToByteArray()).toString("latin1"), receivedAt: at });
  }
  return out;
}

async function main(): Promise<number> {
  const files = process.argv.slice(2);
  const fromBucket = files.length === 0;
  const raws: RawEmail[] = fromBucket
    ? await readBucketEmails(process.env.CLIPS_PREFIX ?? "clips/")
    : files.map((f) => ({ raw: readFileSync(f).toString("latin1"), receivedAt: Date.now() }));

  const articles: ScrapedArticle[] = [];
  const unparsed: string[] = [];
  let skipped = 0;
  const auth: Record<string, number> = {};
  for (const { raw, receivedAt } of raws) {
    const e = readEmail(raw);
    // Bucket mail is from anyone who knows the address, and the From header is
    // forgeable, so this is a noise filter, not the trust boundary: every row
    // is pending until comms approves it. A hand-given file is an operator's
    // forward, so only the subject is checked.
    const trusted =
      SUBJECT_RE.test(e.subject) &&
      (!fromBucket ||
        (!REPLY_RE.test(e.subject) &&
          WCM_FROM_RE.test(e.from) &&
          e.virusVerdict !== "FAIL" &&
          e.spamVerdict !== "FAIL"));
    if (!trusted) {
      skipped++;
      continue;
    }
    auth[e.authVerdict] = (auth[e.authVerdict] ?? 0) + 1;
    const clips = parseClipsEmail(raw);
    if (clips.length === 0 && Date.now() - receivedAt <= UNPARSED_FAIL_MS) unparsed.push(e.subject);
    articles.push(...clips.map(clipToArticle));
  }

  const scholars = await db.write.scholar.findMany({
    where: { deletedAt: null },
    select: { cwid: true, fullName: true, preferredName: true, primaryTitle: true, primaryDepartment: true },
  });
  // Clips carry no VIVO cwids, so every row is a NAME match: `pending`.
  const candidates = clipMentionRows(articles, scholars);
  // The same headline under another url within HEADLINE_REPEAT_DAYS — a later
  // digest, a syndicated copy — is the same story: keep the first.
  const existing = await db.write.newsMention.findMany({
    where: { cwid: { in: [...new Set(candidates.map((r) => r.cwid))] }, outlet: { not: null } },
    select: { cwid: true, url: true, title: true, publishedAt: true },
  });
  const { kept: rows, dropped: repeats } = dropHeadlineRepeats(candidates, existing);
  const { inserted, updated, preserved, deduped } = await upsertMentions(rows);
  console.log(
    `[NewsClips] ${JSON.stringify({ event: "news_clips_complete", emails: raws.length, skipped, auth, clips: articles.length, mentions: rows.length, repeats, inserted, updated, preserved, deduped })}`,
  );
  // A digest that yields no clips means the email format moved under us. Fail
  // AFTER upserting the rest so one odd email does not hold back the others.
  if (unparsed.length) {
    throw new Error(`[NewsClips] ${unparsed.length} digest(s) parsed to zero clips: ${unparsed.join(" | ")}`);
  }
  return inserted + updated;
}

if (process.env.NODE_ENV !== "test" && process.argv[1] && /etl[\\/]news[\\/]clips/.test(process.argv[1])) {
  withEtlRun("NewsClips", main)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.write.$disconnect());
}
