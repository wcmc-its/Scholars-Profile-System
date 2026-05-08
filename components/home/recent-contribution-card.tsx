/**
 * Single scholar+paper card on the home page Recent contributions grid.
 *
 * Server Component (no client-side state). Displays HeadshotAvatar,
 * scholar name + primary title, paper title with PubMed/DOI deeplink, and
 * journal · year · authorship-role line. NO citation count — locked by
 * design spec v1.7.1 (algorithmic-surface guideline: citation counts NOT
 * displayed on "recent" surfaces).
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Card, CardContent } from "@/components/ui/card";
import { sanitizePubmedHtml } from "@/lib/utils";
import type { RecentContribution } from "@/lib/api/home";

export function RecentContributionCard({ item }: { item: RecentContribution }) {
  const paperHref = item.paper.pubmedUrl ?? item.paper.doi ?? "#";
  return (
    <Card>
      <CardContent className="px-4 py-4">
        <div className="flex items-start gap-3">
          <HeadshotAvatar
            size="md"
            cwid={item.cwid}
            preferredName={item.preferredName}
            identityImageEndpoint={item.identityImageEndpoint}
          />
          <div className="min-w-0 flex-1">
            <a
              href={`/scholars/${item.slug}`}
              className="text-base font-semibold hover:underline"
            >
              {item.preferredName}
            </a>
            {item.primaryTitle ? (
              <div className="text-muted-foreground truncate text-sm">
                {item.primaryTitle}
              </div>
            ) : null}
          </div>
        </div>
        <a
          href={paperHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 line-clamp-2 block text-base font-semibold leading-snug hover:underline"
          dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(item.paper.title) }}
        />
        <div className="text-muted-foreground mt-1 text-sm">
          {item.paper.journal ? (
            <span
              dangerouslySetInnerHTML={{
                __html: sanitizePubmedHtml(item.paper.journal),
              }}
            />
          ) : null}
          {item.paper.journal && (item.paper.year || item.authorshipRole) ? " · " : null}
          {item.paper.year ? <span>{item.paper.year}</span> : null}
          {item.paper.year && item.authorshipRole ? " · " : null}
          {item.authorshipRole ? <span>{item.authorshipRole}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
