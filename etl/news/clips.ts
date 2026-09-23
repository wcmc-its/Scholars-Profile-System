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
 * Every clip lands `pending`: comms reviews all of them in /edit/news-queue.
 * A clip row is a news_mention with `outlet` set — that column is the whole
 * newsroom-vs-press distinction (the profile renders the two in separate
 * sections). Upsert and review-state discipline are shared with etl:news.
 *
 * Usage:
 *   npm run etl:news-clips                     read CLIPS_BUCKET/CLIPS_PREFIX
 *   npm run etl:news-clips -- a.eml b.eml      load hand-forwarded emails
 *
 * Env:
 *   CLIPS_BUCKET         SES receipt bucket (required unless files are given).
 *   CLIPS_PREFIX         key prefix SES writes under (default "clips/").
 *   CLIPS_LOOKBACK_DAYS  re-read window (default 30). The upsert is idempotent,
 *                        so re-reading a message is harmless.
 */
import { readFileSync } from "node:fs";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { articlesToMentions, upsertMentions } from "./index";
import type { ScrapedArticle } from "./seed";

/** Bucket mail must come from WCM. The list address itself is kept out of this
 *  public repo; tighten to it (or to an SES DKIM/SPF verdict) once real list
 *  deliveries show which of those survive the list server. */
const CLIPS_FROM_RE = /@med\.cornell\.edu>?\s*$/i;
const SUBJECT_RE = /\bin the news\b/i;

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
  virusVerdict: string | null;
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
    virusVerdict: top.headers.get("x-ses-virus-verdict") ?? null,
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
      .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) =>
        // Sentinels, not "<>", so the tag strip below cannot eat the link —
        // including a non-http one, which must still end the previous item.
        `${inner.replace(/<[^>]+>/g, "")}\u0001${href.replace(/&amp;/g, "&")}\u0002`,
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
      const url = unwrapLink(h[2]);
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

// ---------------------------------------------------------------------------

async function readBucketEmails(): Promise<string[]> {
  const bucket = process.env.CLIPS_BUCKET;
  if (!bucket) throw new Error("[NewsClips] CLIPS_BUCKET is unset and no .eml files were given");
  const prefix = process.env.CLIPS_PREFIX ?? "clips/";
  const since = Date.now() - (Number(process.env.CLIPS_LOOKBACK_DAYS) || 30) * 86_400_000;
  const s3 = new S3Client({});
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key && o.LastModified && o.LastModified.getTime() >= since) keys.push(o.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  const out: string[] = [];
  for (const Key of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
    out.push(Buffer.from(await obj.Body!.transformToByteArray()).toString("latin1"));
  }
  return out;
}

async function main(): Promise<number> {
  const files = process.argv.slice(2);
  const fromBucket = files.length === 0;
  const raws = fromBucket
    ? await readBucketEmails()
    : files.map((f) => readFileSync(f).toString("latin1"));

  const articles: ScrapedArticle[] = [];
  const unparsed: string[] = [];
  let skipped = 0;
  for (const raw of raws) {
    const e = readEmail(raw);
    // Bucket mail is from anyone who knows the address. Only the list's own
    // digest is read; every row it yields is still pending review regardless.
    // A hand-given file is an operator's forward, so only the subject is checked.
    const trusted =
      SUBJECT_RE.test(e.subject) &&
      (!fromBucket || (CLIPS_FROM_RE.test(e.from) && e.virusVerdict !== "FAIL"));
    if (!trusted) {
      skipped++;
      continue;
    }
    const clips = parseClipsEmail(raw);
    if (clips.length === 0) unparsed.push(e.subject);
    articles.push(...clips.map(clipToArticle));
  }

  const scholars = await db.write.scholar.findMany({
    where: { deletedAt: null },
    select: { cwid: true, fullName: true, preferredName: true, primaryTitle: true, primaryDepartment: true },
  });
  // Clips carry no VIVO cwids, so every row is a NAME match: `pending`.
  const rows = articlesToMentions(articles, scholars);
  const { inserted, updated, preserved, deduped } = await upsertMentions(rows);
  console.log(
    `[NewsClips] ${JSON.stringify({ event: "news_clips_complete", emails: raws.length, skipped, clips: articles.length, mentions: rows.length, inserted, updated, preserved, deduped })}`,
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
