/**
 * LLM-answer share-of-voice (#594 §6) — the citation-RAG analogue of the
 * organic-SERP `standings.ts`. Given a citation-RAG snapshot (`LlmRankSnapshot`)
 * and a set of institution groups, it answers: for the expert basket, what
 * fraction of LLM answers cite each institution's research-profile platform.
 *
 * It pools at the ANSWER level (query × provider × sample) off the snapshot's
 * raw per-sample placements — a group "wins" an answer if ANY of its member
 * hosts (e.g. WCM's scholars + legacy vivo) was cited in that answer — and
 * reports a Wilson rate + CI per group, plus a per-provider split.
 *
 * Pure and network-free; reuses `groupByInstitution`/`RankGroup` from
 * `standings.ts` so an LLM snapshot and a SERP snapshot group identically.
 */
import { wilsonInterval, type RateCI } from "./llm-rank";
import type { LlmRankSnapshot } from "./llm-rank";
import type { RankGroup } from "./standings";

export interface LlmShareRow {
  groupKey: string;
  label: string;
  platform?: string;
  /** Answers (query × provider × sample) that cited any of the group's hosts. */
  citedAnswers: number;
  /** Total answers considered. */
  answers: number;
  /** Pooled Wilson rate + CI. */
  rate: RateCI;
  /** Per-provider cite rate. */
  byProvider: { provider: string; citedAnswers: number; answers: number; rate: number }[];
}

function answerCitesGroup(
  placements: { targetKey: string; citationIndex: number | null }[],
  targetKeys: string[],
): boolean {
  return placements.some((p) => targetKeys.includes(p.targetKey) && p.citationIndex !== null);
}

/**
 * Share-of-voice across LLM answers, one row per group, sorted by cite rate
 * desc. Each answer counts once per group (group cited iff any member host was
 * cited in that answer).
 */
export function computeLlmShareOfVoice(
  snapshot: LlmRankSnapshot,
  groups: RankGroup[],
): LlmShareRow[] {
  const out: LlmShareRow[] = groups.map((g) => {
    let answers = 0;
    let cited = 0;
    const prov = new Map<string, { answers: number; cited: number }>();
    for (const row of snapshot.rows) {
      const pp = prov.get(row.provider) ?? { answers: 0, cited: 0 };
      for (const sample of row.rawSamples) {
        answers++;
        pp.answers++;
        if (answerCitesGroup(sample.placements, g.targetKeys)) {
          cited++;
          pp.cited++;
        }
      }
      prov.set(row.provider, pp);
    }
    return {
      groupKey: g.key,
      label: g.label,
      platform: g.platform,
      citedAnswers: cited,
      answers,
      rate: wilsonInterval(cited, answers),
      byProvider: [...prov.entries()].map(([provider, v]) => ({
        provider,
        citedAnswers: v.cited,
        answers: v.answers,
        rate: v.answers ? v.cited / v.answers : 0,
      })),
    };
  });
  return out.sort((a, b) => b.rate.rate - a.rate.rate);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** The "LLM-answer" column for the #593 standings report. */
export function toLlmShareMarkdown(rows: LlmShareRow[], title: string): string {
  const providers = [...new Set(rows.flatMap((r) => r.byProvider.map((p) => p.provider)))];
  const lines = [
    `### ${title}`,
    "",
    "Share of LLM answers (query × provider × sample) that cite each group's profile platform.",
    "",
    `| Group | Cite rate [95% CI] | Cited / answers | ${providers.join(" | ")} |`,
    `|---|---|---|${providers.map(() => "---").join("|")}|`,
  ];
  for (const r of rows) {
    const byP = providers.map((p) => {
      const hit = r.byProvider.find((x) => x.provider === p);
      return hit ? pct(hit.rate) : "—";
    });
    lines.push(
      `| ${r.label} | ${pct(r.rate.rate)} [${pct(r.rate.lower)}–${pct(r.rate.upper)}] | ${r.citedAnswers}/${r.answers} | ${byP.join(" | ")} |`,
    );
  }
  return lines.join("\n");
}
