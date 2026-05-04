/**
 * Centers & Institutes section — UI-SPEC §6.4 + §7 empty state.
 * Server Component: ALWAYS renders the empty-state body because no Center
 * model exists in the schema (RESEARCH.md Pitfall 4 + STATE.md PHASE2-08).
 * The section heading and the anchor target id="centers" must remain so
 * the anchor strip link resolves.
 */
export function CentersGrid() {
  return (
    <section id="centers" className="mt-16">
      <h2 className="text-lg font-semibold">Centers &amp; Institutes</h2>
      <p className="mt-4 text-sm text-muted-foreground">
        Center and institute information is being loaded. Check back soon.
      </p>
    </section>
  );
}
