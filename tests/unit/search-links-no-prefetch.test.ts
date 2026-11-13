// Every <Link> on the /search surface must opt out of prefetch: a prefetched
// facet/sort/scope link is an uncached OpenSearch query per visible link
// (~19 per results page), and the Usage rollup counts it as a search (#3368).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsxFiles(join(dir, e.name))
      : e.name.endsWith(".tsx") && !e.name.includes(".test.")
        ? [join(dir, e.name)]
        : [],
  );
}

function linkTagsWithoutPrefetch(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<Link\b/g)) {
    let depth = 0;
    let j = m.index! + 5;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index!, j);
    if (!tag.includes("prefetch")) out.push(tag.slice(0, 80));
  }
  return out;
}

describe("/search links never prefetch", () => {
  const files = [...tsxFiles("components/search"), ...tsxFiles("app/(public)/search")];
  it.each(files)("%s", (file) => {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(linkTagsWithoutPrefetch(code)).toEqual([]);
  });
});
