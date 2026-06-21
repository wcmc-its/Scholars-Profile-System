/**
 * Per-contribution source-PMID attribution for the NIH biosketch (#917 v6 follow-up).
 *
 * After the Contributions to Science are generated, one model call asks: for each numbered
 * contribution, which of the candidate publications (by pmid) does it draw from? This gives a
 * reviewer a traceable "Sources: PMID …" line per contribution, so any grounded claim can be
 * checked against the paper it came from. Every returned pmid is verified against the FACTS
 * candidate set; anything else is dropped (no invented pmids).
 *
 * Pure module (no Bedrock): the prompt builder + the tolerant parser. The single gateway call
 * lives in `biosketch-generator.ts`.
 */
import type { OverviewFacts } from "@/lib/edit/overview-facts";

/** The pmids one contribution draws from. */
export type BiosketchContributionSources = {
  /** 1-based contribution index. */
  contributionIndex: number;
  /** The source pmids (a subset of the FACTS candidate publications), in input order. */
  pmids: string[];
};

type CandidatePub = OverviewFacts["representativePublications"][number];

/** System prompt for the attribution call — a strict JSON, read-only task. */
export const SOURCE_ATTRIBUTION_SYSTEM_PROMPT = [
  "You map each numbered CONTRIBUTION of an NIH biosketch back to the PUBLICATIONS it draws on.",
  "You are given the already-written contributions and a list of candidate publications (pmid +",
  "title + one-line summary). For EACH contribution, list the pmids of the publications whose",
  "findings that contribution actually reflects — choose ONLY from the provided pmids, and include",
  "a publication only when its specific work is represented in that contribution's prose. A",
  "contribution may map to several pmids; a pmid may support more than one contribution; some",
  "candidate pmids may map to none. Do not invent pmids. Return STRICT JSON only, no prose:",
  '{"sources":[{"contributionIndex":N,"pmids":["...","..."]}]}.',
].join("\n");

/** Build the user turn for the attribution call. */
export function buildSourceAttributionPrompt(entries: string[], pubs: CandidatePub[]): string {
  const lines: string[] = [];
  lines.push("CONTRIBUTIONS (numbered):");
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. ${e}`);
    lines.push("");
  });
  lines.push("CANDIDATE PUBLICATIONS (choose pmids only from this list):");
  for (const p of pubs) {
    const summary = (p.synopsis ?? p.topicRationale ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(`- pmid ${p.pmid}: ${p.title.replace(/<[^>]+>/g, "")}${summary ? ` — ${summary}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Tolerantly parse the attribution JSON into per-contribution source pmids. Each entry's
 * `contributionIndex` is clamped to [1, entryCount]; pmids are filtered to the allowed FACTS set
 * and de-duplicated. Never throws — malformed output yields `[]` (the UI then shows no sources
 * rather than crashing the generate). Entries are returned sorted by contribution index, with at
 * most one entry per contribution (later duplicates merge).
 */
export function parseSourceAttribution(
  text: string,
  allowedPmids: Set<string>,
  entryCount: number,
): BiosketchContributionSources[] {
  const byIndex = new Map<number, string[]>();
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as { sources?: unknown };
    if (!Array.isArray(parsed.sources)) return [];
    for (const s of parsed.sources) {
      const ss = s as { contributionIndex?: unknown; pmids?: unknown };
      const idx = Math.floor(Number(ss.contributionIndex));
      if (!Number.isFinite(idx) || idx < 1 || idx > entryCount) continue;
      if (!Array.isArray(ss.pmids)) continue;
      const seen = new Set(byIndex.get(idx) ?? []);
      const merged = byIndex.get(idx) ?? [];
      for (const p of ss.pmids) {
        if (typeof p === "string" && allowedPmids.has(p) && !seen.has(p)) {
          seen.add(p);
          merged.push(p);
        }
      }
      byIndex.set(idx, merged);
    }
  } catch {
    return [];
  }
  return [...byIndex.entries()]
    .filter(([, pmids]) => pmids.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([contributionIndex, pmids]) => ({ contributionIndex, pmids }));
}
