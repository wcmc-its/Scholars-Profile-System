/**
 * The read-only publication-summary card on the takedown surface
 * (#356 Phase 7 C7, UI-SPEC § `/edit/publication/[pmid]` Card 1).
 *
 * Server component. Renders title / journal / year / PMID / DOI plus the
 * author list with WCM markings — `Badge` "WCM" next to each WCM author,
 * a muted "Hidden" note next to any per-author-hidden WCM author. No
 * controls; the controls live on the takedown card (Card 2).
 */
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  PublicationTakedownContext,
  TakedownAuthor,
} from "@/lib/api/publication-takedown-context";

export type PublicationSummaryCardProps = {
  publication: PublicationTakedownContext["publication"];
  authors: ReadonlyArray<TakedownAuthor>;
};

export function PublicationSummaryCard({ publication, authors }: PublicationSummaryCardProps) {
  return (
    <Card data-slot="publication-summary-card">
      <CardHeader>
        <CardTitle>{publication.title}</CardTitle>
        <CardDescription>
          {publication.journal ?? "Unknown journal"}
          {publication.year !== null ? ` · ${publication.year}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">PMID</dt>
          <dd>
            <code>{publication.pmid}</code>
          </dd>
          {publication.doi && (
            <>
              <dt className="text-muted-foreground">DOI</dt>
              <dd>
                <code>{publication.doi}</code>
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Authors</h3>
          <ul className="flex flex-wrap gap-1.5 text-sm" data-slot="author-list">
            {authors.map((a) => (
              <li
                key={`${a.position}-${a.cwid ?? a.name}`}
                className="flex items-center gap-1"
                data-testid={`author-${a.position}`}
              >
                <span className={!a.isDisplayed ? "text-muted-foreground line-through" : ""}>
                  {a.name}
                </span>
                {a.isWcm && (
                  <Badge
                    variant="outline"
                    className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full text-[10px]"
                  >
                    WCM
                  </Badge>
                )}
                {a.isWcm && !a.isDisplayed && (
                  <span className="text-muted-foreground text-xs">(hidden)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
