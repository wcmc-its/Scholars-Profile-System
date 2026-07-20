import type { ProfilePayload } from "@/lib/api/profile";

type NewsMention = ProfilePayload["news"][number];

/** Most scholars have a handful of mentions; the rest collapse into a <details>. */
const ROW_CAP = 5;

/** ISO YYYY-MM-DD → "July 16, 2026", in UTC so the server render is deterministic. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** One news row: title (opens the article), date, excerpt. Zero client JS. */
function NewsRow({ item }: { item: NewsMention }) {
  const date = formatDate(item.publishedAt);
  return (
    <li className="border-border border-t first:border-t-0">
      <div className="py-3">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-base leading-snug font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          {item.title}
        </a>
        {date ? <div className="text-muted-foreground mt-0.5 text-xs">{date}</div> : null}
        {item.excerpt ? <p className="text-muted-foreground mt-1 text-sm">{item.excerpt}</p> : null}
      </div>
    </li>
  );
}

/**
 * News mentions of this scholar from the WCM Research news feed, attached by the
 * VIVO cwid link (or a comms-queue-confirmed prose name match).
 *
 * ponytail: title + date + excerpt only. The scraped `thumbnailUrl` is carried
 * on the payload but not rendered in v1 — a public external <img> would need
 * next/image domain config or a CSP img-src allowance for the WCM host, and the
 * row reads fine without it. Add the thumbnail when a design asks for it. The
 * "show more" expander is a native <details>, so the section stays server-only.
 */
export function NewsSection({ news }: { news: NewsMention[] }) {
  const head = news.slice(0, ROW_CAP);
  const rest = news.slice(ROW_CAP);

  return (
    <>
      <ul>
        {head.map((item) => (
          <NewsRow key={item.url} item={item} />
        ))}
      </ul>

      {rest.length > 0 ? (
        <details className="border-border border-t">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer py-3 text-sm">
            Show {rest.length} more {rest.length === 1 ? "mention" : "mentions"}
          </summary>
          <ul>
            {rest.map((item) => (
              <NewsRow key={item.url} item={item} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
