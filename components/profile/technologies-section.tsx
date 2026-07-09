import type { ProfilePayload } from "@/lib/api/profile";

type Technology = ProfilePayload["technologies"][number];

/**
 * Licensable inventions from the WCM Center for Technology Licensing portfolio.
 *
 * ponytail: no client state — every row is a link out to CTL's detail page, so
 * this stays a server component. Add "use client" only if a row ever expands.
 */
export function TechnologiesSection({ technologies }: { technologies: Technology[] }) {
  return (
    <>
      <ul>
        {technologies.map((tech) => (
          <li key={tech.url} className="border-border border-t first:border-t-0">
            <div className="grid grid-cols-[1fr_auto] items-baseline gap-3 py-3">
              <a
                href={tech.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base leading-snug font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
              >
                {tech.title}
              </a>
              {tech.reference ? (
                <span
                  title="Cornell Reference number"
                  className="text-muted-foreground font-mono text-xs whitespace-nowrap"
                >
                  {tech.reference}
                </span>
              ) : (
                <span />
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-sm">
        Technologies available for licensing, listed by the{" "}
        <a
          href="https://innovation.weill.cornell.edu/technology-portfolio"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent-slate)] underline underline-offset-4"
        >
          Center for Technology Licensing
        </a>
        . Contact the Center to discuss licensing or sponsored research.
      </p>
    </>
  );
}
