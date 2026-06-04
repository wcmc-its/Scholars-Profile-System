/**
 * The self-edit landing board (vision-round T3.4 / Direction B headline). The
 * editor used to open on a nine-item data dictionary; this opens on the actual
 * job — write a bio, control visibility, tidy publications, request corrections
 * to sourced fields — with live status read from the already-loaded context.
 * Server component: links to the same `?attr=` panels, no client state.
 */
import Link from "next/link";
import { ExternalLink, Eye, FileText, ListChecks, MessageSquareWarning } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Badge } from "@/components/ui/badge";

export type HomePanelProps = {
  basePath: string;
  hasBio: boolean;
  isHidden: boolean;
  totalPublications: number;
  hiddenPublications: number;
  previewHref: string;
};

export function HomePanel({
  basePath,
  hasBio,
  isHidden,
  totalPublications,
  hiddenPublications,
  previewHref,
}: HomePanelProps) {
  const cards = [
    {
      key: "overview",
      icon: FileText,
      title: "Write your overview",
      body: "A short bio at the top of your public profile — the one thing only you can write.",
      status: hasBio ? "Bio set" : "No bio yet",
      statusVariant: hasBio ? ("secondary" as const) : ("outline" as const),
    },
    {
      key: "visibility",
      icon: Eye,
      title: "Control your visibility",
      body: "Hide your whole profile from the public site and search, or make it visible again.",
      status: isHidden ? "Hidden" : "Public",
      statusVariant: isHidden ? ("destructive" as const) : ("secondary" as const),
    },
    {
      key: "publications",
      icon: ListChecks,
      title: "Tidy your publications",
      body: "Hide a paper from your profile, or flag one that isn't yours.",
      status:
        hiddenPublications > 0
          ? `${totalPublications} shown · ${hiddenPublications} hidden`
          : `${totalPublications} shown`,
      statusVariant: "outline" as const,
    },
    {
      key: "name-title",
      icon: MessageSquareWarning,
      title: "Request a correction",
      body: "Name, title, funding, and appointments come from WCM systems — request a fix at the source.",
      status: "Sourced",
      statusVariant: "outline" as const,
    },
  ];

  return (
    <EditPanel
      slot="home-panel"
      heading="Your profile"
      description="Changes here appear on your public profile. Here's what you can do."
      headerAction={
        <Link
          href={previewHref}
          className="text-apollo-maroon inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          View my profile
          <ExternalLink className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <li key={c.key}>
              <Link
                href={`${basePath}?attr=${c.key}`}
                data-testid={`home-card-${c.key}`}
                className="border-border hover:border-apollo-maroon focus-visible:ring-apollo-ring flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="bg-apollo-maroon/10 text-apollo-maroon flex size-8 items-center justify-center rounded-md">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <Badge variant={c.statusVariant}>{c.status}</Badge>
                </div>
                <span className="font-medium">{c.title}</span>
                <span className="text-muted-foreground text-sm">{c.body}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </EditPanel>
  );
}
