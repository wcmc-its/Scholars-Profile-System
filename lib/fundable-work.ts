/** `/edit/fundable-work` — dark unless FUNDABLE_WORK=on (cdk/lib/app-stack.ts). */
export function isFundableWorkEnabled(): boolean {
  return process.env.FUNDABLE_WORK === "on";
}

export type FundableWorkFunder = {
  name: string;
  kind: "pharma" | "biotech" | "device" | "diagnostics" | "foundation" | "other";
  why: string;
};
