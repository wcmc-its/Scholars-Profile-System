/**
 * Shared prestige contract for funding opportunities.
 *
 * PURE TypeScript — no db/server imports, no `process.env` reads — so it is safe
 * to import from client components (e.g. `components/edit/prestige-badge`) as
 * well as the server-side matcher (`lib/api/match-opportunities`).
 *
 * `Prestige.label` is kept a free string (not a union) for producer
 * forward-compat: the ReciterAI producer may emit new tiers ahead of the
 * consumer learning about them.
 */
export type Prestige = {
  score: number; // 0..1
  label: string; // "Flagship" | "Major" | "Standard" (string for producer fwd-compat)
  mechanism_tier?: string | null;
  size_bucket?: string | null;
  sponsor_tier?: string | null;
  selectivity?: number | null;
  rationale?: string | null;
};

/**
 * Narrow an unknown value (e.g. a raw JSON column) to `Prestige`, or `null`.
 * Requires a non-null, non-array object carrying a numeric `score` and a string
 * `label`; optional fields are coerced with the same typeof guards and default
 * to `null` when absent or the wrong type.
 */
export function asPrestige(v: unknown): Prestige | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.score !== "number" || typeof obj.label !== "string") return null;

  const str = (k: string): string | null => (typeof obj[k] === "string" ? (obj[k] as string) : null);
  const num = (k: string): number | null => (typeof obj[k] === "number" ? (obj[k] as number) : null);

  return {
    score: obj.score,
    label: obj.label,
    mechanism_tier: str("mechanism_tier"),
    size_bucket: str("size_bucket"),
    sponsor_tier: str("sponsor_tier"),
    selectivity: num("selectivity"),
    rationale: str("rationale"),
  };
}

/**
 * Human-readable award ceiling: `500000 -> "up to $500k/yr"`,
 * `2_000_000 -> "up to $2M/yr"`. Returns `null` for null/undefined/<=0.
 */
export function formatCeiling(n: number | null | undefined): string | null {
  if (n === null || n === undefined || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `up to $${m}M/yr`;
  }
  return `up to $${Math.round(n / 1000)}k/yr`;
}

/**
 * Runnable self-check for the contract above. NOT auto-invoked — guarded behind
 * an explicit export so it never runs in app code. Call it from a scratch script
 * or a test if you want to exercise the asserts.
 */
export function __prestigeSelfCheck__(): void {
  console.assert(asPrestige(null) === null, "asPrestige(null) should be null");
  console.assert(asPrestige({ score: 0.9, label: "Flagship" })?.score === 0.9, "score 0.9");
  console.assert(formatCeiling(500000) === "up to $500k/yr", "formatCeiling(500000)");
  console.assert(formatCeiling(2_000_000) === "up to $2M/yr", "formatCeiling(2_000_000)");
  console.assert(formatCeiling(0) === null, "formatCeiling(0)");
}
