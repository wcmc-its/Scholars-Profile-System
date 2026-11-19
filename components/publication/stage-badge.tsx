import { Badge } from "@/components/ui/badge";
import {
  translationalStageLabel,
  type TranslationalStage,
} from "@/lib/translational-stage";

/**
 * A paper's translational stage as a small neutral outline badge: the code in
 * semibold, then the stage name ("T2 Clinical trials and efficacy"). It sits at
 * the end of the journal/year line on search, topic and unit publication rows.
 * Neutral on purpose: no per-stage colour, so no stage reads as better than
 * another. Not a link; the publication modal links the definition.
 */
export function StageBadge({ stage, className }: { stage: TranslationalStage; className?: string }) {
  return (
    <Badge
      variant="outline"
      data-testid="pub-row-stage"
      className={`text-muted-foreground px-1.5 py-0 text-[11px] font-normal not-italic ${className ?? ""}`}
    >
      <span className="text-foreground font-semibold">{stage.replace("-", "\u2013")}</span>{" "}
      {translationalStageLabel(stage)}
    </Badge>
  );
}
