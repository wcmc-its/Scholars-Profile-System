/**
 * The "Scholars in this area" info-button text, shared by `ScholarCardGrid`
 * and `TopScholarsChipRow`. `areaSignals` (TOPIC_RANK_AREA_SIGNALS, read by
 * the page on the server) adds the grants-and-trials sentence.
 */
export function TopScholarsInfoText({ areaSignals = false }: { areaSignals?: boolean }) {
  return (
    <>
      Full-time faculty identified by ReCiterAI from their first- or senior-author publications in
      this research area.
      {areaSignals
        ? " For scholars who already publish in the area, PI grants and clinical trials they lead in the area also count toward their place."
        : null}{" "}
      Curators do not handpick this list; it updates nightly as new work appears.
    </>
  );
}
