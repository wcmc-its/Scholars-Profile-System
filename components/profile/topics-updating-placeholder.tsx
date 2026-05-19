import { RefreshCw } from "lucide-react";
import { TopicsHeading } from "@/components/profile/topics-heading";

/**
 * Replaces the Topics pills while the reciter → dynamodb rebuild window is
 * open (#118 / B19). During the window the publication set is mid-rewrite, so
 * the pills would be transiently incomplete — show an honest placeholder
 * instead. Only this section changes; no other profile UI is affected.
 */
export function TopicsUpdatingPlaceholder() {
  return (
    <section className="mb-6">
      <TopicsHeading />
      <div className="text-muted-foreground mt-3 flex items-start gap-2.5 text-sm">
        <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="leading-relaxed">
          <span className="text-foreground font-medium">Topics are updating.</span>{" "}
          This scholar&apos;s publications were just refreshed; updated topics
          appear shortly.
        </p>
      </div>
    </section>
  );
}
