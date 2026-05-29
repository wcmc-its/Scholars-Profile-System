/**
 * Shared prose typography for /docs article pages. Mirrors the type scale used
 * by `/about/help/[slug]` and `/about/methodology` so the docs site reads
 * consistently with the rest of `/about`. Applied once via Tailwind descendant
 * variants so prose JSX stays decoupled from presentation.
 */
export const DOCS_PROSE_CLASS = [
  "mt-8",
  "[&_p]:mt-4 [&_p]:text-base",
  "[&_ul]:mt-4 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:text-base",
  "[&_ol]:mt-4 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:text-base",
  "[&_li]:mt-1.5",
  "[&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_a]:text-[var(--color-accent-slate)] [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:no-underline",
  "[&_strong]:font-semibold",
  "[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border-b [&_th]:border-border [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:align-top [&_th]:font-semibold",
  "[&_td]:border-b [&_td]:border-border [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top",
].join(" ");
