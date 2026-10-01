// Install-time patch for Next's vendored React Flight client (#1995).
//
// Why: an App Router soft navigation can suspend on a Flight chunk in status
// `resolved_model`. React attaches its ping via `chunk.then(ping, ping)`, and
// Flight's `ReactPromise.prototype.then` initializes the chunk and calls
// `resolve` SYNCHRONOUSLY -- the ping fires mid-render, React drops it, and
// the navigation waits forever on an already-fulfilled chunk. Upstream:
// https://github.com/vercel/next.js/issues/98305 (fixed in Next 16).
//
// Fix: in the `case "fulfilled"` branch of `ReactPromise.prototype.then`,
// call `resolve` in a microtask instead of synchronously -- exactly what a
// native Promise (Promises/A+) does. Local A/B on the #1995 probe: 29/30 hung
// before, 0/30 after.
//
// Run by `postinstall`. Exits non-zero if a target file exists but no longer
// contains the expected snippet, so a Next bump forces a re-review.
// REMOVE this script (and its postinstall/Dockerfile wiring) when on Next 16.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "sps-1995-flight-then-async";

// Client bundles the browser loads (webpack build; experimental variant is
// used when Next enables experimental React features).
export const TARGETS = [
  "react-server-dom-webpack",
  "react-server-dom-webpack-experimental",
].flatMap((pkg) =>
  ["production", "development"].map(
    (mode) =>
      `node_modules/next/dist/compiled/${pkg}/cjs/${pkg.replace("-experimental", "")}-client.browser.${mode}.js`,
  ),
);

const THEN_START = "ReactPromise.prototype.then = function (resolve, reject) {";
const FULFILLED_RE =
  /\n([ \t]*)case "fulfilled":\n([ \t]*)"function" === typeof resolve && resolve\(this\.value\);\n([ \t]*)break;/;

/**
 * @param {string} src
 * @returns {{ status: "patched" | "already-patched", out: string }}
 */
export function transform(src) {
  if (src.includes(MARKER)) return { status: "already-patched", out: src };
  const start = src.indexOf(THEN_START);
  if (start === -1) {
    throw new Error("ReactPromise.prototype.then not found");
  }
  // Bound the search to the then() body: it ends at the first `};` line with
  // the same indentation as the `ReactPromise.prototype.then = ...` line.
  const lineStart = src.lastIndexOf("\n", start) + 1;
  const indent = src.slice(lineStart, start);
  const endRel = src.indexOf(`\n${indent}};`, start);
  const end = endRel === -1 ? src.length : endRel;
  const body = src.slice(start, end);
  const m = FULFILLED_RE.exec(body);
  if (!m) {
    throw new Error('expected `case "fulfilled": ... resolve(this.value)` not found in then()');
  }
  const [, caseIndent, stmtIndent, breakIndent] = m;
  const inner = stmtIndent + "  ";
  const replacement =
    `\n${caseIndent}case "fulfilled":\n` +
    `${stmtIndent}// ${MARKER}: defer like a native Promise (see scripts/patch-next-flight-then.mjs)\n` +
    `${stmtIndent}if ("function" === typeof resolve) {\n` +
    `${inner}var spsFulfilledValue = this.value;\n` +
    `${inner}queueMicrotask(function () {\n` +
    `${inner}  resolve(spsFulfilledValue);\n` +
    `${inner}});\n` +
    `${stmtIndent}}\n` +
    `${breakIndent}break;`;
  const newBody = body.slice(0, m.index) + replacement + body.slice(m.index + m[0].length);
  return { status: "patched", out: src.slice(0, start) + newBody + src.slice(end) };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(join(root, "node_modules/next/package.json"))) {
    console.log("[patch-next-flight-then] next not installed; nothing to patch");
    return;
  }
  for (const rel of TARGETS) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    let result;
    try {
      result = transform(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(
        `[patch-next-flight-then] ${rel}: ${err.message}\n` +
          "next's Flight client changed — re-verify #1995 patch (scripts/patch-next-flight-then.mjs)",
      );
      process.exit(1);
    }
    if (result.status === "patched") writeFileSync(file, result.out);
    console.log(`[patch-next-flight-then] ${result.status}: ${rel}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
