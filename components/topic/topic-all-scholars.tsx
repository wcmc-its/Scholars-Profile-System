/**
 * Spec §13 "All scholars in this area" — comprehensive enumerative list
 * (mockup "Dedicated subarea - scholar list").
 *
 * Server Component; every filter is URL state so the view is shareable:
 *   - Sticky bar: name filter, Subarea picker, role chips, A–Z letter bar.
 *   - One letter at a time; a name search shows every match grouped by letter.
 *   - Borderless taxonomy scholar cards (hover = scope summary popover), the
 *     selected subarea bolded in each card's area bullets.
 */
import { Search } from "lucide-react";
import type { TopicAllScholarRole, TopicScholarsResult } from "@/lib/api/topics";
import { topicScholarLastNameInitial } from "@/lib/api/topics";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { ScholarCard } from "@/components/taxonomy/scholar-card";
import { SubareaPicker } from "@/components/topic/subarea-picker";

const ROLE_CHIPS: Array<{ id: TopicAllScholarRole; label: string }> = [
  { id: "all", label: "All" },
  { id: "faculty", label: "Faculty" },
  { id: "postdocs", label: "Postdocs" },
  // No "Doctoral students" chip (sibling of #2270): the loader carves the #536
  // hidden identity classes, so the facet could only ever offer an empty list.
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type ListParams = { role: TopicAllScholarRole; q: string; sub: string | null; letter?: string | null };

function buildScholarsHref(topicSlug: string, p: ListParams): string {
  const sp = new URLSearchParams();
  if (p.sub) sp.set("sub", p.sub);
  if (p.role !== "all") sp.set("role", p.role);
  if (p.q) sp.set("q", p.q);
  if (p.letter) sp.set("letter", p.letter);
  const qs = sp.toString();
  const base = `/topics/${encodeURIComponent(topicSlug)}/scholars`;
  return qs ? `${base}?${qs}` : base;
}

export function TopicAllScholars({
  topicSlug,
  topicLabel,
  result,
  subtopics,
  selectedRole,
  selectedSub,
  query,
}: {
  topicSlug: string;
  topicLabel: string;
  result: TopicScholarsResult;
  subtopics: Array<{ id: string; displayName: string; pubCount: number }>;
  selectedRole: TopicAllScholarRole;
  selectedSub: string | null;
  query: string;
}) {
  const here: ListParams = { role: selectedRole, q: query, sub: selectedSub };
  const activeArea = subtopics.find((s) => s.id === selectedSub)?.displayName;
  const available = new Set(result.letters);

  const groups = new Map<string, TopicScholarsResult["hits"]>();
  for (const h of result.hits) {
    const ch = topicScholarLastNameInitial(h.preferredName);
    groups.set(ch, [...(groups.get(ch) ?? []), h]);
  }

  return (
    <section>
      <div className="border-apollo-border z-10 md:sticky md:top-0 mt-7 flex flex-col gap-3.5 border-b bg-white pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <form
            method="get"
            action={`/topics/${encodeURIComponent(topicSlug)}/scholars`}
            className="border-apollo-border-strong bg-apollo-surface flex h-[38px] max-w-[360px] min-w-0 flex-[1_1_280px] items-center gap-2 rounded-lg border px-3"
          >
            <Search className="text-muted-foreground size-[15px] shrink-0" aria-hidden />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Filter by name"
              aria-label="Filter scholars by name"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {selectedSub ? <input type="hidden" name="sub" value={selectedSub} /> : null}
            {selectedRole !== "all" ? <input type="hidden" name="role" value={selectedRole} /> : null}
            {query ? (
              <a href={buildScholarsHref(topicSlug, { ...here, q: "" })} className="text-muted-foreground text-[13px]">
                Clear
              </a>
            ) : null}
          </form>

          {subtopics.length > 0 ? (
            <SubareaPicker
              selected={selectedSub}
              allHref={buildScholarsHref(topicSlug, { ...here, sub: null })}
              options={subtopics.map((s) => ({
                id: s.id,
                label: s.displayName,
                pubCount: s.pubCount,
                href: buildScholarsHref(topicSlug, { ...here, sub: s.id }),
              }))}
            />
          ) : null}

          <div className="ml-auto flex flex-wrap gap-1.5">
            {ROLE_CHIPS.filter((c) => c.id === "all" || result.roleCounts[c.id] > 0).map((chip) => {
              const active = selectedRole === chip.id;
              return (
                <a
                  key={chip.id}
                  href={buildScholarsHref(topicSlug, { ...here, role: chip.id })}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex h-8 items-center rounded-full border px-3.5 text-[13.5px] whitespace-nowrap tabular-nums ${
                    active
                      ? "border-apollo-bar bg-apollo-bar text-white"
                      : "border-apollo-border-strong bg-white hover:border-[var(--color-accent-slate)]"
                  }`}
                >
                  {chip.label} {result.roleCounts[chip.id].toLocaleString()}
                </a>
              );
            })}
          </div>
        </div>

        <nav aria-label="Jump to letter" className="-mx-1.5 flex flex-wrap">
          {ALPHABET.map((ch) => {
            const base = "flex h-[34px] min-w-[30px] items-center justify-center border-b-2 px-1.5 text-sm";
            if (!available.has(ch)) {
              return (
                <span key={ch} aria-disabled="true" className={`${base} text-apollo-border-strong border-transparent`}>
                  {ch}
                </span>
              );
            }
            const on = ch === result.letter;
            return (
              <a
                key={ch}
                href={buildScholarsHref(topicSlug, { ...here, q: "", letter: ch })}
                aria-current={on ? "page" : undefined}
                className={`${base} ${on ? "border-[var(--color-primary-cornell-red)] font-semibold" : "border-transparent hover:text-[var(--color-accent-slate)]"}`}
              >
                {ch}
              </a>
            );
          })}
        </nav>
      </div>

      {result.hits.length === 0 ? (
        <p className="text-muted-foreground py-12 text-[15px]">
          No scholars match.{" "}
          <a href={buildScholarsHref(topicSlug, { role: "all", q: "", sub: null })} className="text-[var(--color-accent-slate)] underline">
            Clear filters
          </a>
        </p>
      ) : (
        [...groups].map(([ch, hits]) => (
          <div key={ch} className="mt-7 flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2.5 pb-2">
              <h2 className="font-serif text-[26px] leading-none">{ch}</h2>
              <span className="text-muted-foreground text-[13px] tabular-nums">{hits.length}</span>
            </div>
            <ul className="-mx-3 grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-x-5 gap-y-1">
              {hits
                // #536 — the loader already carves hidden identity classes; this
                // belt-and-braces keeps a stray row from rendering a dead link.
                .filter((h) => isPubliclyDisplayed(h.roleCategory))
                .map((h) => (
                  <li key={h.cwid} className="min-w-0">
                    <ScholarCard
                      bare
                      activeArea={activeArea}
                      scholar={{
                        cwid: h.cwid,
                        slug: h.slug,
                        preferredName: h.postnominal ? `${h.preferredName}, ${h.postnominal}` : h.preferredName,
                        primaryTitle: h.primaryTitle,
                        identityImageEndpoint: h.identityImageEndpoint,
                        areas: h.subtopics.map((s) => s.displayName),
                      }}
                      popover={{ label: topicLabel, topicSlug }}
                    />
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
