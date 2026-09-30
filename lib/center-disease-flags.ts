/**
 * Feature flag for the public center page's curated disease layer
 * (`CENTER_DISEASE_FACET`): the Scholars tab "Disease focus" facet and the
 * DISEASES row on each member card. Curated diseases sit BESIDE topics (D1,
 * `docs/cancer-center-disease-taxonomy-decisions.md`); they never replace or
 * override `TopicAssignment` / the TOPICS row.
 *
 * Default OFF. When off, `getCenterMembers` loads nothing and the roster
 * payload is byte-identical to before. Additionally data-gated: only a center
 * with a `CenterProgram` taxonomy renders the grouped roster the diseases hang
 * off (today only the Meyer Cancer Center), and the facet renders only when a
 * member has a published disease (`lib/cancer-center-disease-publish.ts`).
 *
 * Server-only (reads `process.env`); do not import from a client component.
 * Per the flag-parity rule, wired per-env in `cdk/lib/app-stack.ts`
 * (staging "on" / prod "off").
 */
export function isCenterDiseaseFacetEnabled(): boolean {
  return process.env.CENTER_DISEASE_FACET === "on";
}
