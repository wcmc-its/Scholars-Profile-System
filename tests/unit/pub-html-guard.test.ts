/**
 * #946 guardrail — RAW publication-string render detector.
 *
 * Bug class #946: a PubMed publication title / journal / abstract rendered as
 * plain JSX text (`{pub.title}`) or via a bare `<em>{pub.journal}</em>` instead
 * of being routed through the sanctioned `sanitizePubmedHtml` path. Plain-text
 * renders escape inline `<i>/<sub>` markup so the user sees literal angle
 * brackets; bare `dangerouslySetInnerHTML` without the sanitizer is an
 * injection vector. The SINGLE sanctioned render path is
 * `components/publication/pub-html.tsx` (`PubTitle` / `PubJournal` /
 * `PubAbstract`), which sanitizes internally.
 *
 * This test scans `app/` and `components/` source and FAILS if any
 * publication-shaped variable's `.title` / `.journal` / `.abstract` is rendered
 * as a JSX child without a sanctioning token. The migration step routes the raw
 * sites through `<PubTitle value={pub.title} />` etc. — a prop assignment the
 * detector treats as sanctioned — so the scan passes once #946 is migrated.
 *
 * ── HOW TO ALLOWLIST A LEGITIMATE NON-PUBLICATION USE ──────────────────────
 * Some `.title` accesses are NOT PubMed strings (person job titles, grant
 * titles, COI entity names, UI heading literals). If the detector flags one of
 * those, suppress it ONE of two ways:
 *
 *   1. Inline marker — add a trailing comment ON THE SAME LINE:
 *        <span>{e.title}</span> {/* pub-html-ok: grant title, sanitized upstream *​/}
 *      The reason after `pub-html-ok:` is required and is surfaced in the
 *      allowlist audit below.
 *
 *   2. File+line entry — add to the ALLOWLIST array in this file with a reason.
 *      Use this for shared-prop render sites whose prop name (itemLabel,
 *      pubTitle, targetLabel) is reused by non-publication callers, where the
 *      pub path is fixed at the call site by passing an already-sanitized
 *      value into `<PubTitle .../>`.
 *
 * Do NOT allowlist a genuine publication render to silence the guard — route it
 * through `@/components/publication/pub-html` instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["app", "components"];
const SOURCE_EXT = /\.(tsx|jsx)$/;

/** Variable names that, by convention in this codebase, hold a publication. */
const PUBLICATION_VARS = ["pub", "p", "publication", "hit", "c", "citing"];
/** PubMed-sourced string fields that must be sanitized before render. */
const PUB_FIELDS = ["title", "journal", "abstract"];

/**
 * Tokens that mean "this `{...}` is already on the sanctioned path." Presence of
 * any one inside the braces clears the expression.
 *  - `sanitizePubmedHtml` / `sanitizePubTitle` — the whitelist sanitizer.
 *  - `dangerouslySetInnerHTML` — the only render verb the sanitizer feeds.
 *  - `PubTitle` / `PubJournal` / `PubAbstract` / `PubHtml` — the sanctioned component.
 *  - `titleHtml` / `highlightedTitleHtml` — precomputed-sanitized title locals.
 *  - `stripTags` / `htmlToPlainText` — explicit plain-text downgrades (no markup leak).
 *  - `formatCitationContext` — the modal's plain-text citation builder.
 */
const SANCTION =
  /sanitizePubmedHtml|sanitizePubTitle|dangerouslySetInnerHTML|PubTitle|PubJournal|PubAbstract|PubHtml|titleHtml|highlightedTitleHtml|stripTags|htmlToPlainText|formatCitationContext/;

const ALLOWLIST_MARKER = /pub-html-ok:\s*(.+)$/;

/**
 * File+line allowlist for legitimate non-publication or call-site-sanitized
 * render sites. Each entry MUST carry a human reason. `line` is optional — omit
 * it to allowlist an entire file (use sparingly).
 *
 * NOTE: the three shared-prop dialogs/banner flagged in the #946 audit
 * (reject-notice-dialog, request-a-change-dialog, superuser-banner) are NOT
 * listed here because the detector keys on publication-shaped *variable* names
 * (`pub`, `hit`, …) and those sites render through generic props
 * (`pubTitle`, `itemLabel`, `targetLabel`) that are also used by grant/COI
 * callers — so the detector never flags them. Their publication path is fixed
 * by sanitizing at the publications-card call site that passes `pub.title`.
 */
const ALLOWLIST: { file: string; line?: number; reason: string }[] = [
  // (empty) — add { file, line, reason } here for false positives.
];

function isAllowlisted(relFile: string, line: number): boolean {
  return ALLOWLIST.some(
    (e) => e.file === relFile && (e.line === undefined || e.line === line),
  );
}

interface Violation {
  file: string;
  line: number;
  field: string;
  text: string;
}

/**
 * Strip occurrences of `VAR.field` that are pure boolean GUARDS (so a separator
 * like `{pub.journal && " · "}` isn't mistaken for a render of the journal),
 * while preserving render forms — including the nullish-coalescing render
 * `{pub.journal ?? "Unknown journal"}` and optional chaining `pub?.journal`.
 *
 * Guards removed:
 *  - negated tests: `!pub.title`, `!!hit.abstract`
 *  - left of `&&` / `||`
 *  - left of a comparison: `=== !== == != < > <= >=`
 *  - the test of a ternary: `pub.journal ? <a/> : null`  (a single `?`, NOT `??`/`?.`)
 */
function stripGuardUses(inner: string): string {
  let s = inner;
  for (const v of PUBLICATION_VARS) {
    for (const f of PUB_FIELDS) {
      const tok = `${v}\\.${f}`;
      s = s.replace(new RegExp(`!{1,2}\\b${tok}\\b`, "g"), "");
      s = s.replace(
        new RegExp(`\\b${tok}\\b\\s*(?=(&&|\\|\\|(?!\\|)|===|!==|==|!=|<=|>=|<|>))`, "g"),
        "",
      );
      s = s.replace(new RegExp(`\\b${tok}\\b\\s*(?=\\?(?![?.]))`, "g"), "");
    }
  }
  return s;
}

/**
 * Scan one file's source for RAW publication renders. Pure (string in →
 * violations out) so it is unit-testable against fixture strings.
 */
export function scanSource(source: string, relFile = "<fixture>"): Violation[] {
  const out: Violation[] = [];
  const lines = source.split("\n");
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    // Skip comment lines and explicit inline allowlist markers.
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
    if (ALLOWLIST_MARKER.test(line)) return;

    // Each top-level `{...}` group on the line. A leading `ident=` means it is a
    // JSX attribute (e.g. `value={pub.title}`, `abstract={hit.abstract}`) which
    // routes the value into the sanctioned component / a sanitizing child — not
    // a raw render.
    const groupRe = /([A-Za-z_][\w]*\s*=\s*)?\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = groupRe.exec(line)) !== null) {
      if (m[1]) continue; // JSX attribute prop
      const inner = m[2];
      if (SANCTION.test(inner)) continue;
      const stripped = stripGuardUses(inner);
      for (const v of PUBLICATION_VARS) {
        for (const f of PUB_FIELDS) {
          if (!new RegExp(`\\b${v}\\.${f}\\b`).test(stripped)) continue;
          // Object-literal property value (`name: p.title`) — a data copy in a
          // roster map, not a render.
          if (new RegExp(`:\\s*${v}\\.${f}\\b`).test(stripped)) continue;
          if (isAllowlisted(relFile, lineNo)) continue;
          out.push({ file: relFile, line: lineNo, field: `${v}.${f}`, text: trimmed.slice(0, 110) });
        }
      }
    }
  });
  return out;
}

function listSourceFiles(): string[] {
  const acc: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const fp = path.join(dir, name);
      const st = statSync(fp);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".next") continue;
        walk(fp);
      } else if (SOURCE_EXT.test(name)) {
        acc.push(fp);
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    walk(abs);
  }
  return acc;
}

// ── Self-validation: prove the detector is not a no-op ──────────────────────

const BAD_FIXTURES: { name: string; src: string }[] = [
  { name: "plain title text", src: `<span className="font-medium">{p.title}</span>` },
  { name: "bare em journal", src: `<em>{p.journal}</em>` },
  { name: "title on its own line", src: `  {pub.title}` },
  { name: "nullish-coalesced journal", src: `{pub.journal ?? "Unknown journal"} · {pub.year}` },
  { name: "ternary that re-renders journal", src: `{hit.journal ? <em>{hit.journal}</em> : null}` },
  { name: "journal inside join", src: `{[p.journal, p.year].filter(Boolean).join(" · ")}` },
  { name: "CardTitle pub title", src: `<CardTitle>{publication.title}</CardTitle>` },
  { name: "citing-pub journal", src: `<em className="not-italic">{c.journal}</em>` },
];

const GOOD_FIXTURES: { name: string; src: string }[] = [
  { name: "sanctioned component", src: `<PubTitle as="p" className="font-medium" value={pub.title} />` },
  { name: "sanctioned journal", src: `<PubJournal value={pub.journal} className="not-italic" />` },
  { name: "dangerouslySetInnerHTML + sanitizer", src: `<em dangerouslySetInnerHTML={{ __html: sanitizePubTitle(pub.journal) }} />` },
  { name: "precomputed titleHtml", src: `<button dangerouslySetInnerHTML={{ __html: titleHtml }} />` },
  { name: "journal used only as a guard", src: `{pub.journal && pub.year ? <span>·</span> : null}` },
  { name: "abstract passed as prop to sanitizing child", src: `<PublicationMeta abstract={hit.abstract} />` },
  { name: "abstract used as boolean arg", src: `{expandLabel(hit.pubCount, !!hit.abstract)}` },
  { name: "roster object copy", src: `next.set(p.cwid, { name: p.name, title: p.title })` },
  { name: "inline allowlist marker", src: `<span>{e.title}</span> {/* pub-html-ok: grant title *​/}` },
  { name: "year only", src: `{pub.year ?? "Year unknown"}` },
];

describe("#946 RAW-publication-render detector — self validation", () => {
  it("flags every known-BAD inline fixture", () => {
    for (const f of BAD_FIXTURES) {
      const hits = scanSource(f.src);
      expect(hits.length, `expected a violation for: ${f.name}`).toBeGreaterThan(0);
    }
  });

  it("returns zero hits for every known-GOOD (sanctioned) fixture", () => {
    for (const f of GOOD_FIXTURES) {
      const hits = scanSource(f.src);
      expect(hits, `expected no violation for: ${f.name} → ${JSON.stringify(hits)}`).toHaveLength(0);
    }
  });

  it("catches the original #946 offenders (highlights-card / publications-card shapes)", () => {
    // The literal pre-fix snippets from the audit map must trip the detector.
    expect(scanSource(`<span className="text-sm leading-snug font-medium">{p.title}</span>`)).toHaveLength(1);
    expect(
      scanSource(
        `<p className={cn("text-foreground font-medium", isHidden && "line-through")}>\n  {pub.title}\n</p>`,
      ),
    ).toHaveLength(1);
  });
});

describe("#946 codebase scan — app/ + components/ must have no RAW publication renders", () => {
  it("has zero raw publication title/journal/abstract render sites outside the sanctioned component", () => {
    const violations: Violation[] = [];
    for (const fp of listSourceFiles()) {
      // The sanctioned component itself documents the bug shape in a comment;
      // its own renders go through PubHtml. Skip it to avoid self-matching.
      if (fp.endsWith(path.join("components", "publication", "pub-html.tsx"))) continue;
      const rel = path.relative(REPO_ROOT, fp);
      for (const v of scanSource(readFileSync(fp, "utf8"), rel)) violations.push(v);
    }
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line}  [${v.field}]  ${v.text}`)
        .join("\n");
      throw new Error(
        `#946: ${violations.length} RAW publication render site(s) found. Route each through ` +
          `@/components/publication/pub-html (PubTitle / PubJournal / PubAbstract), or — if it is ` +
          `NOT a PubMed string — allowlist it (see the top-of-file comment in this test):\n${report}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
