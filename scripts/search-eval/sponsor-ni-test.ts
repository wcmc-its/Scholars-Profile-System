/**
 * Non-inferiority test for the recency A/B.
 *
 * THE QUESTION THIS ASKS, AND WHY IT IS NOT "IS RECENCY BETTER?"
 * The gold set cannot answer the latter. Its rubric is topical — `_grades`: "3 = name-first
 * expert, work centers on the topic" — and its `_method` blends "citation impact", which
 * accumulates with age. So the gold is not merely recency-neutral, it is mildly recency-
 * ANTAGONISTIC: a name-first, highly-cited expert who last published in 2009 is a grade 3, and
 * D1 multiplies them by ~0.5 (RECENCY_FLOOR .. 0.5^(age/8)) and demotes them. The eval scores
 * that as a loss. The expected sign of Δ on this gold is therefore ≤ 0 BY CONSTRUCTION, and any
 * gate demanding that recency "clear the noise floor" upward asks for a result the instrument
 * cannot produce — whether run paired or via two deploys.
 *
 * What the gold CAN do is detect BREAKAGE. So the gate is non-inferiority:
 *
 *     H0 (inferior):     mean Δ ≤ −δ          Δ_f = nDCG@k(on, f) − nDCG@k(off, f)
 *     H1 (non-inferior): mean Δ >  −δ
 *
 * Rejecting H0 says: folding recency into the fused score does not damage topical ranking by
 * more than δ. Whether recency HELPS is a product judgment (officers want active groups), and
 * D3's dial makes it per-ask reversible ("Any" = ×1). That judgment is not this script's to make.
 *
 * TEST: exact paired sign-flip permutation — 2^n enumerated in full, no asymptotics — because
 * n=15 is far too small for a t-test to be trusted, and a bounded [0.5,1] multiplier produces
 * exact zeros that a Wilcoxon would drop. Plus a BCa bootstrap CI, reported AGAINST δ rather
 * than as a p against 0.
 *
 *   npx tsx sponsor-ni-test.ts --selftest               # verify the math (no infra, known answers)
 *   npx tsx sponsor-ni-test.ts <off.json> <on.json>     # the JSON_OUT= files from sponsor-eval.sh
 *   DELTA=0.01 ALPHA=0.05 npx tsx sponsor-ni-test.ts ...
 */
import { readFileSync } from "node:fs";

type Score = { id: string; ndcg_at_k: number | null; unmeasured?: boolean };

/** The non-inferiority margin. PRE-REGISTER THIS — choosing δ after seeing Δ is not a test. */
const DELTA = Number(process.env.DELTA ?? 0.01);
const ALPHA = Number(process.env.ALPHA ?? 0.05);
const B = Number(process.env.BOOTSTRAP ?? 20000);

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const mulberry32 = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** Abramowitz & Stegun 7.1.26 */
const erf = (x: number) => {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
};
const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
/** Acklam's inverse normal CDF */
const phiInv = (p: number) => {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

type NiResult = { theta: number; lo: number; hi: number; p: number; degenerate: boolean; flips: number };

function niTest(deltas: readonly number[], delta: number, alpha: number, boots = B): NiResult {
  const n = deltas.length;
  const theta = mean(deltas);

  // ── exact sign-flip permutation ──────────────────────────────────────────────────────────
  // Shift by δ so the H0 boundary (mean Δ = −δ) becomes a mean of zero, then enumerate all 2^n
  // sign assignments. Exhaustive: n=15 ⇒ 32768.
  //
  // No add-one correction here, deliberately. The (1+r)/(1+B) form (Phipson & Smyth 2010) exists
  // because RANDOM permutation sampling may miss the observed assignment; an exhaustive
  // enumeration already contains it, so r/2^n is exact. Adding one would double-count the
  // observed flip and make the test conservative while the header claims exact.
  if (n > 24) throw new Error(`n=${n} too large to enumerate exhaustively; this test is exact-only`);
  const y = deltas.map((d) => d + delta);
  const yObs = mean(y);
  const flips = 2 ** n;
  let atLeast = 0;
  for (let mask = 0; mask < flips; mask++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (mask >> i) & 1 ? -y[i] : y[i];
    if (s / n >= yObs - 1e-12) atLeast++;
  }
  const p = atLeast / flips;

  // ── BCa bootstrap CI on mean Δ ───────────────────────────────────────────────────────────
  const sd = Math.sqrt(mean(deltas.map((d) => (d - theta) ** 2)));
  if (sd === 0) return { theta, lo: theta, hi: theta, p, degenerate: true, flips };

  const rnd = mulberry32(20260716); // fixed seed — the run must be reproducible
  const stars: number[] = [];
  for (let b = 0; b < boots; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[(rnd() * n) | 0];
    stars.push(s / n);
  }
  stars.sort((a, b) => a - b);
  const below = stars.filter((t) => t < theta).length;
  const z0 = phiInv(below === 0 ? 1 / (2 * boots) : below / boots);
  // jackknife acceleration
  const jack = deltas.map((_, i) => mean(deltas.filter((__, j) => j !== i)));
  const jbar = mean(jack);
  const num = jack.reduce((s, t) => s + (jbar - t) ** 3, 0);
  const den = jack.reduce((s, t) => s + (jbar - t) ** 2, 0);
  const a = den === 0 ? 0 : num / (6 * den ** 1.5);
  const adj = (zq: number) => phi(z0 + (z0 + zq) / (1 - a * (z0 + zq)));
  const q = (frac: number) => stars[Math.min(boots - 1, Math.max(0, Math.round(frac * (boots - 1))))];
  return { theta, lo: q(adj(phiInv(alpha / 2))), hi: q(adj(phiInv(1 - alpha / 2))), p, degenerate: false, flips };
}

// ── selftest: known answers, no infra ────────────────────────────────────────────────────────
if (process.argv[2] === "--selftest") {
  const ok = (label: string, cond: boolean, got: string) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}  ${got}`);
    if (!cond) process.exitCode = 1;
  };
  // 1. Recency changes nothing ⇒ non-inferior. Only the all-positive flip reaches yObs, so
  //    p = 1/(2^15+1); CI is degenerate at 0, which clears −δ.
  const zero = niTest(new Array(15).fill(0), 0.01, 0.05);
  ok("all Δ=0 → non-inferior", zero.p < 0.05 && zero.lo > -0.01 && zero.degenerate, `p=${zero.p.toExponential(2)} lo=${zero.lo}`);
  // Exhaustive ⇒ exactly one of the 2^15 flips (the all-positive one) reaches yObs.
  ok("all Δ=0 → p = 1/2^15 exactly", Math.abs(zero.p - 1 / 32768) < 1e-15, `p=${zero.p}`);
  // 2. A uniform loss far past δ ⇒ every flip beats the observed (it is the minimum) ⇒ p=1.
  const loss = niTest(new Array(15).fill(-0.05), 0.01, 0.05);
  ok("uniform −0.05 loss → NOT established", loss.p >= 0.05 && loss.lo <= -0.01, `p=${loss.p.toFixed(3)} lo=${loss.lo.toFixed(4)}`);
  // 3. A tiny loss well inside δ ⇒ non-inferior, and the CI must exclude −δ.
  const tiny = niTest(new Array(15).fill(-0.001), 0.01, 0.05);
  ok("uniform −0.001 loss → non-inferior", tiny.p < 0.05 && tiny.lo > -0.01, `p=${tiny.p.toExponential(2)} lo=${tiny.lo.toFixed(4)}`);
  // 4. Sanity on the machinery itself.
  ok("Φ(0)=0.5", Math.abs(phi(0) - 0.5) < 1e-9, phi(0).toFixed(6));
  ok("Φ⁻¹(0.975)≈1.95996", Math.abs(phiInv(0.975) - 1.959964) < 1e-4, phiInv(0.975).toFixed(6));
  ok("Φ(Φ⁻¹(0.3))≈0.3", Math.abs(phi(phiInv(0.3)) - 0.3) < 1e-6, phi(phiInv(0.3)).toFixed(6));
  // 5. BCa must be reproducible across calls (fixed seed).
  const r1 = niTest([-0.02, 0.01, 0, 0.03, -0.01, 0, 0.02, -0.03, 0.01, 0, 0.04, -0.02, 0, 0.01, 0.02], 0.01, 0.05);
  const r2 = niTest([-0.02, 0.01, 0, 0.03, -0.01, 0, 0.02, -0.03, 0.01, 0, 0.04, -0.02, 0, 0.01, 0.02], 0.01, 0.05);
  ok("BCa reproducible", r1.lo === r2.lo && r1.hi === r2.hi, `[${r1.lo.toFixed(4)}, ${r1.hi.toFixed(4)}]`);
  console.log(process.exitCode ? "\nselftest FAILED" : "\nselftest PASS");
  process.exit(process.exitCode ?? 0);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
const [offPath, onPath] = process.argv.slice(2);
if (!offPath || !onPath) {
  console.error("usage: tsx sponsor-ni-test.ts <off.json> <on.json>   [DELTA=0.01 ALPHA=0.05]");
  console.error("       tsx sponsor-ni-test.ts --selftest");
  process.exit(1);
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Score[];
const byId = (rows: Score[]) => new Map(rows.map((r) => [r.id, r]));
const off = byId(read(offPath));
const on = byId(read(onPath));

// An UNMEASURED fixture (breaker 502, stale cookie) is NOT a ranking of zero — it must be
// excluded, not scored. Same discipline as sponsor-summary.jq. Pairing requires both arms.
const paired: { id: string; d: number }[] = [];
const dropped: string[] = [];
for (const [id, o] of off) {
  const n = on.get(id);
  const bad = (s?: Score) => !s || s.unmeasured === true || s.ndcg_at_k == null;
  if (bad(o) || bad(n)) {
    dropped.push(id);
    continue;
  }
  paired.push({ id, d: n!.ndcg_at_k! - o.ndcg_at_k! });
}
if (paired.length < 2) {
  console.error(`only ${paired.length} paired fixtures — cannot test. dropped: ${dropped.join(",")}`);
  process.exit(1);
}

const r = niTest(paired.map((p) => p.d), DELTA, ALPHA);
const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);

console.log(`sponsor recency A/B — NON-INFERIORITY   δ=${DELTA}  α=${ALPHA}  n=${paired.length} paired`);
if (dropped.length) console.log(`  dropped (unmeasured in an arm, NOT scored 0): ${dropped.join(", ")}`);
console.log();
for (const { id, d } of [...paired].sort((a, b) => a.d - b.d)) {
  console.log(`  ${d === 0 ? " " : d > 0 ? "▲" : "▼"} ${id.padEnd(26)} Δ nDCG = ${f(d)}`);
}
console.log();
console.log(`  mean Δ            ${f(r.theta)}      (negative = recency costs topical nDCG)`);
console.log(`  ${(100 * (1 - ALPHA)).toFixed(0)}% BCa CI        [${f(r.lo)}, ${f(r.hi)}]${r.degenerate ? "   (degenerate: every Δ identical)" : ""}`);
console.log(`  exact perm. p     ${r.p.toExponential(3)}   (H0: mean Δ ≤ −δ; ${r.flips} sign flips enumerated)`);
console.log();

if (r.p < ALPHA && r.lo > -DELTA) {
  console.log(`  VERDICT: NON-INFERIOR at δ=${DELTA}. CI lower bound ${f(r.lo)} > −δ, and H0 rejected.`);
  console.log(`  This clears the BREAKAGE gate. It is NOT evidence recency ranks better — this gold`);
  console.log(`  set is recency-blind and cannot produce that evidence. The flip is a product call;`);
  console.log(`  D3's "Any" makes it per-ask reversible.`);
} else {
  const why = [r.p >= ALPHA ? `p=${r.p.toExponential(2)} ≥ α` : "", r.lo <= -DELTA ? `CI lower ${f(r.lo)} ≤ −δ` : ""].filter(Boolean).join("; ");
  console.log(`  VERDICT: NOT ESTABLISHED at δ=${DELTA}. ${why}.`);
  console.log(`  Do NOT flip prod on this. Either the loss is real, or n is too small to exclude it.`);
}
console.log();
console.log(`  ⚠ ε UNMEASURED unless this ran over ≥2 independent draws (>30 min apart — the route`);
console.log(`    caches on sha256(description) for 5 min, stale-served to 30). One draw removes`);
console.log(`    WITHIN-pair extractor noise by construction, but leaves the ESTIMATE itself`);
console.log(`    dependent on which extraction was captured. If the CI sits near −δ, take more draws.`);
