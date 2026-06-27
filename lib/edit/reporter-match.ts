/**
 * `REPORTER_MATCH_V2` flag — the single switch for the RePORTER grants v2
 * PMID-overlap matcher (docs/reporter-grants-v2-matcher-spec.md §9). The ETL
 * branch reads `process.env.REPORTER_MATCH_V2` directly (`etl/reporter-grants/
 * index.ts`); this app-side helper gates the `/edit` "Is this you?" card — the
 * `EditContext` load (`lib/api/edit-context.ts`), the rail item + renderPanel
 * (`components/edit/edit-page.tsx`), and the confirm/reject/revoke routes.
 *
 * Mirror of `isCvEnabled()` (`lib/edit/cv-export.ts`). Staging-on / prod-off at
 * merge; injected per-env in `cdk/lib/app-stack.ts`.
 */
export function isReporterMatchV2Enabled(): boolean {
  return process.env.REPORTER_MATCH_V2 === "on";
}
