import { cn } from "@/lib/utils";

/**
 * #760 — launch-period beta marker gate. Default ON: the badge renders unless
 * SHOW_BETA_BADGE is explicitly "off" (the house style for default-on flags,
 * cf. #722's `!= "off"`). The off-switch at full launch is a single env flip
 * (`SHOW_BETA_BADGE=off` in cdk/lib/app-stack.ts + `cdk deploy Sps-App-<env>`),
 * no code revert.
 *
 * Reads process.env ONLY — never cookies/session — so it stays a build/runtime
 * constant and does not flip statically generated pages to dynamic, keeping the
 * header CloudFront-cache compatible (cf. #640). `env` is injectable for tests.
 */
export function isBetaBadgeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SHOW_BETA_BADGE !== "off";
}

/**
 * Small solid "Beta" tag shown beside the Scholars wordmark during the launch /
 * early-access period (#760). Presentational only — the header decides whether
 * to render it via {@link isBetaBadgeEnabled} and positions it on the wordmark
 * row. A solid light chip (warm off-white fill, WCM carnelian text) that inverts
 * the surrounding white-on-red, so the tag is the one element that breaks the
 * pattern and reads unmistakably as a label (≈6.4:1 contrast, well over WCAG AA
 * 4.5:1). Non-interactive: a plain, non-focusable <span> with no hover/click
 * affordance of its own; the visible text is its full accessible meaning.
 */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center rounded-full bg-[#FBF1EE] px-2 py-0.5 font-sans text-[11px] font-medium uppercase leading-none tracking-[0.08em] text-[#A32D2D]",
        className,
      )}
    >
      Beta
    </span>
  );
}
