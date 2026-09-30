/**
 * "Methods & definitions" for `/edit/data-sharing` — the last section of the
 * page (2026-09 page revision: moved inline from the Methods dialog, reached
 * from the rail's "Methods & definitions" link).
 *
 * History: originally (08-16 follow-up pass) three hardcoded prose blocks in a
 * dialog; v3 (2026-08-16 stakeholder pass) replaced the prose with
 * `buildMethodsDoc`'s sections — ONE source of methods text shared with the
 * `?section=methods` markdown download, so the page and the file a
 * stakeholder forwards can't drift. The dashboard builds the doc server-side
 * and passes it down whole. This module must NEVER import the report lib or
 * anything that constructs prisma (the manageable-units trap in CLAUDE.md);
 * the one `MethodsDoc` import is type-only against a pure module. The
 * Glossary section's body is `\n`-delimited "Term — definition" lines,
 * rendered as a list (the dotted `DefinedTerm` hovers are the on-page
 * affordance; this is where someone reads it all).
 */
import { CopyButton } from "@/components/publication/copy-button";
import type { MethodsDoc } from "@/lib/edit/data-sharing-methods-doc";

export function DataSharingMethodsSection({ doc }: { doc: MethodsDoc }) {
  const glossary = doc.sections.find((s) => s.heading === "Glossary");
  const prose = doc.sections.filter((s) => s !== glossary);
  return (
    <section id="methods" className="flex scroll-mt-32 flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">Methods &amp; definitions</h2>
        {/* Plain <a>, not <Link>: the target is a download route handler, and
            <Link>'s client nav + prefetch would fetch the file itself. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/edit/data-sharing/export?section=methods"
          className="text-apollo-slate ml-auto text-[13px] hover:underline"
        >
          Download methods
        </a>
      </div>
      <div className="border-apollo-border-strong bg-apollo-surface grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-4 rounded-[13px] border px-4 py-[18px] sm:px-[22px]">
        {prose.map((section) => (
          <div key={section.heading} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{section.heading}</h3>
            {section.body.split("\n").map((line, i) => (
              <p key={i} className="text-apollo-ink-2 text-[13.5px] leading-relaxed">
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
      {glossary ? (
        <div className="border-apollo-border-strong bg-apollo-surface rounded-[13px] border px-4 py-[18px] sm:px-[22px]">
          <h3 className="text-sm font-semibold">Glossary</h3>
          <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-2">
            {glossary.body.split("\n").map((line) => {
              const [term, ...rest] = line.split(" — ");
              return (
                <div key={line} className="text-[13.5px] leading-relaxed">
                  <dt className="inline font-medium">{term}</dt>
                  {rest.length > 0 ? (
                    <dd className="text-apollo-ink-2 inline"> — {rest.join(" — ")}</dd>
                  ) : null}
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}
      <div className="border-apollo-border-strong bg-apollo-surface rounded-[13px] border px-4 py-[18px] sm:px-[22px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">One paragraph for reporting</h3>
          <span className="text-apollo-slate inline-flex items-center gap-1 text-[13px]">
            <CopyButton value={doc.paragraph} label="Copy paragraph text" />
            Copy paragraph
          </span>
        </div>
        <p className="text-apollo-ink-2 mt-2 text-[13.5px] leading-relaxed">{doc.paragraph}</p>
      </div>
    </section>
  );
}
