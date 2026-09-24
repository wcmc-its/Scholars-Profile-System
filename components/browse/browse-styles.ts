/** Section shell shared by the /browse peer sections (Departments, Centers,
 *  Cores). scroll-mt clears the sticky site header + anchor strip. */
export const BROWSE_SECTION_CLASS = "scroll-mt-[136px]";
export const BROWSE_H2_CLASS = "text-xl leading-7 font-medium";
export const BROWSE_COUNT_CLASS = "text-[13px] text-muted-foreground";
export const BROWSE_DESC_CLASS =
  "mt-2 max-w-[500px] text-[14px] leading-5 text-muted-foreground";

/** Card link for the Centers / Cores grids. Hover and keyboard focus get the
 *  same lift; the translate is dropped under prefers-reduced-motion. */
export const BROWSE_CARD_CLASS =
  "flex h-full flex-col rounded-[10px] border border-apollo-border-strong bg-white px-5 pt-[22px] pb-[18px] text-foreground shadow-[var(--apollo-shadow-card)] transition-[border-color,box-shadow,background-color,translate] duration-[120ms] ease-out hover:no-underline hover:-translate-y-px hover:border-apollo-slate hover:bg-apollo-page hover:shadow-[0_2px_6px_rgba(34,30,28,0.08),0_8px_20px_rgba(34,30,28,0.08)] focus-visible:-translate-y-px focus-visible:border-apollo-slate focus-visible:bg-apollo-page focus-visible:shadow-[0_2px_6px_rgba(34,30,28,0.08),0_8px_20px_rgba(34,30,28,0.08)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:focus-visible:translate-y-0";
