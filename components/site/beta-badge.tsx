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
 * Small "Beta" pill shown beside the Scholars wordmark during the launch /
 * early-access period (#760). Presentational only — the header decides whether
 * to render it via {@link isBetaBadgeEnabled}. Sits on the maroon header, so it
 * is a translucent outline: white text, thin white/40 border, transparent fill.
 * Size + letter-spacing mirror the "WEILL CORNELL MEDICINE" subtitle so it reads
 * as part of the brand. The visible text carries the meaning for screen readers;
 * `title` adds a hover tooltip for sighted users.
 */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-white/40 bg-transparent px-2 py-[2px] font-sans font-semibold uppercase leading-none text-white/90",
        className,
      )}
      style={{ fontSize: "10px", letterSpacing: "0.12em" }}
      title="Scholars is in beta"
    >
      Beta
    </span>
  );
}
