/**
 * METHOD_SERVICES — the "WCM services for this method" block on a method page:
 * every visible service attached to the family, in the order the loader gives
 * (most collaborations first). The same four parts for each: the heading, the
 * service's name as the link out, "Offered by the {unit}", and the sentence
 * "The {unit} collaborated on N and supported S of the M publications listed
 * here." (`serviceSentenceParts`: only the half that is not zero) with "Show
 * them", which turns on that service's filter in the publication list below
 * (`?service=<id>`, read by `FamilyPublicationFeed`).
 *
 * The sentence is left out when N and S are both 0. Server component, no hooks.
 */
import Link from "next/link";

import type { FamilyServiceEntry } from "@/lib/api/methods";
import {
  serviceFilterLabel,
  serviceSentenceParts,
  withArticle,
} from "@/lib/method-services/collaboration";

export function MethodServicesBlock({
  services,
  total,
  familyPath,
}: {
  services: ReadonlyArray<FamilyServiceEntry>;
  /** M: the publications the page lists (its default, research-article view). */
  total: number;
  /** The method page's own path, for the "Show them" link. */
  familyPath: string;
}) {
  if (services.length === 0) return null;
  return (
    <section
      aria-labelledby="method-services-heading"
      className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-notice-text mt-[22px] max-w-[760px] rounded-[10px] border px-[18px] pt-3.5 pb-4"
      data-testid="method-services-block"
    >
      <h2
        id="method-services-heading"
        className="text-apollo-slate text-[11px] font-semibold tracking-widest uppercase"
      >
        WCM services for this method
      </h2>
      <ul className="divide-apollo-slate-tint-border divide-y">
        {services.map((s) => {
          const unit = withArticle(s.unitName);
          const unitName = unit.slice("the ".length);
          // `total` falls back to 0 when its own read fails: no sentence
          // then, rather than "N of the 0".
          const sentence =
            total >= s.count
              ? serviceSentenceParts(unitName, s.collaborations, s.support, total)
              : null;
          return (
            <li key={s.id} className="py-3 first:pt-0 last:pb-0" data-testid={`method-service-${s.id}`}>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
                {/* Stored https-only (validateServiceUrl); checked again here so
                    a bad row can never become a link. */}
                {s.url.startsWith("https://") ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-apollo-slate focus-visible:outline-apollo-slate text-base font-semibold break-words underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {s.name} <span aria-hidden="true">↗</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="text-apollo-slate text-base font-semibold break-words">
                    {s.name}
                  </span>
                )}
                <span className="text-[13.5px]">
                  Offered by the{" "}
                  {s.unitHref ? (
                    <Link
                      href={s.unitHref}
                      prefetch={false}
                      className="focus-visible:outline-apollo-slate underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {unitName}
                    </Link>
                  ) : (
                    unitName
                  )}
                </span>
              </div>
              {sentence && (
                <p className="border-apollo-slate-tint-border mt-2.5 border-t pt-2.5 text-sm leading-[1.55]">
                  {sentence.map((part, i) =>
                    part.bold ? (
                      <b key={i} className="font-semibold">
                        {part.text}
                      </b>
                    ) : (
                      part.text
                    ),
                  )}{" "}
                  <Link
                    href={`${familyPath}?service=${s.id}#publications`}
                    prefetch={false}
                    aria-label={`Show them: the ${s.count.toLocaleString("en-US")} ${serviceFilterLabel(s.label, s.collaborations, s.support)}`}
                    className="text-apollo-slate focus-visible:outline-apollo-slate font-medium whitespace-nowrap underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    data-testid={`method-service-show-${s.id}`}
                  >
                    Show them <span aria-hidden="true">→</span>
                  </Link>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
