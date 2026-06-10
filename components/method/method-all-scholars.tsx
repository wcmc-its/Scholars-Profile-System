/**
 * Enumerative "All scholars using this method · N" surface (the
 * `topic-all-scholars` analog), reached from the family page's
 * "+ N more scholars →" affordance. Browse-style list with role chips, name
 * search, alpha-letter dividers, and shareable URL state.
 *
 * Differs from TopicAllScholars: a `MethodScholarRow` carries no per-scholar
 * subtopic pills (the family taxonomy has no child level to surface here), so
 * each row is avatar + name + title only. The route is the nested
 * `/methods/[sc]/[fam]/scholars`.
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  methodScholarLastNameInitial,
  type MethodScholarRole,
  type MethodScholarRow,
  type MethodScholarsResult,
} from "@/lib/api/methods";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";

const ROLE_CHIPS: Array<{
  id: MethodScholarRole;
  label: string;
  countKey: keyof MethodScholarsResult["roleCounts"];
}> = [
  { id: "all", label: "All", countKey: "all" },
  { id: "faculty", label: "Faculty", countKey: "faculty" },
  { id: "postdocs", label: "Postdocs", countKey: "postdocs" },
  { id: "doctoral_students", label: "Doctoral students", countKey: "doctoralStudents" },
];

function buildHref(
  basePath: string,
  params: { role?: MethodScholarRole; q?: string; page?: number },
): string {
  const sp = new URLSearchParams();
  if (params.role && params.role !== "all") sp.set("role", params.role);
  if (params.q && params.q.length > 0) sp.set("q", params.q);
  if (params.page && params.page > 0) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Discrete page numbers with ellipsis when total > 7. */
function paginationPages(current: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const out: Array<number | "ellipsis"> = [0];
  const start = Math.max(1, current - 1);
  const end = Math.min(totalPages - 2, current + 1);
  if (start > 1) out.push("ellipsis");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < totalPages - 2) out.push("ellipsis");
  out.push(totalPages - 1);
  return out;
}

function ScholarRow({ scholar }: { scholar: MethodScholarRow }) {
  const displayName = scholar.postnominal
    ? `${scholar.preferredName}, ${scholar.postnominal}`
    : scholar.preferredName;
  // #536 — hidden identity class (doctoral student): keep the row + name but
  // render it as a non-link (the profile route 404s).
  const linkable = isPubliclyDisplayed(scholar.roleCategory);
  const rowClass = "flex items-start gap-3 rounded-md p-1.5 -mx-1.5";
  const inner = (
    <>
      <HeadshotAvatar
        size="sm"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
        className="size-7"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-tight">{displayName}</div>
        {scholar.primaryTitle ? (
          <div className="truncate text-[11.5px] leading-tight text-muted-foreground">
            {scholar.primaryTitle}
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <li className="break-inside-avoid py-2">
      {linkable ? (
        <a href={profilePath(scholar.slug)} className={`${rowClass} hover:bg-muted/50`}>
          {inner}
        </a>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
    </li>
  );
}

export function MethodAllScholars({
  basePath,
  result,
  selectedRole,
  query,
  page,
  familyLabel,
}: {
  /** `/methods/[sc]/[fam]/scholars` — the GET-form action + chip/pagination base. */
  basePath: string;
  result: MethodScholarsResult;
  selectedRole: MethodScholarRole;
  query: string;
  page: number;
  familyLabel: string;
}) {
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pages = paginationPages(page, totalPages);

  return (
    <section className="mt-12">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          All scholars using this method · {result.roleCounts.all.toLocaleString()}
        </h2>
        <p className="hidden text-xs italic text-muted-foreground sm:block">
          Anyone with at least one publication using {familyLabel}, sorted alphabetically.
        </p>
      </div>

      <form method="get" action={basePath} className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search by name"
          aria-label="Search scholars by name"
          className="h-9 w-full max-w-[320px] rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {selectedRole !== "all" && <input type="hidden" name="role" value={selectedRole} />}
        <button
          type="submit"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted"
        >
          Search
        </button>
        {query.length > 0 && (
          <a
            href={buildHref(basePath, { role: selectedRole, q: "", page: 0 })}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Clear
          </a>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {ROLE_CHIPS.map((chip) => {
            const active = selectedRole === chip.id;
            const count = result.roleCounts[chip.countKey];
            return (
              <a
                key={chip.id}
                href={buildHref(basePath, { role: chip.id, q: query, page: 0 })}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "inline-flex items-center rounded-full border border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] px-3 py-1 text-xs font-medium text-white"
                    : "inline-flex items-center rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground hover:border-[var(--color-accent-slate)]"
                }
              >
                {chip.label} {count.toLocaleString()}
              </a>
            );
          })}
        </div>
      </form>

      {result.hits.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {query.length > 0
            ? `No scholars using this method match "${query}".`
            : "No scholars match this filter."}
        </p>
      ) : (
        <ScholarColumns hits={result.hits} />
      )}

      {totalPages > 1 && (
        <Pagination className="mt-8">
          <PaginationContent>
            {page > 0 && (
              <PaginationItem>
                <PaginationPrevious
                  href={buildHref(basePath, { role: selectedRole, q: query, page: page - 1 })}
                />
              </PaginationItem>
            )}
            {pages.map((p, i) =>
              p === "ellipsis" ? (
                <PaginationItem key={`e-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink
                    href={buildHref(basePath, { role: selectedRole, q: query, page: p })}
                    isActive={p === page}
                  >
                    {p + 1}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            {page < totalPages - 1 && (
              <PaginationItem>
                <PaginationNext
                  href={buildHref(basePath, { role: selectedRole, q: query, page: page + 1 })}
                />
              </PaginationItem>
            )}
          </PaginationContent>
        </Pagination>
      )}
    </section>
  );
}

/**
 * Walks the alphabetically-sorted hit list once, emitting a serif divider each
 * time the last-name initial advances, inside a CSS `columns` layout.
 */
function ScholarColumns({ hits }: { hits: MethodScholarRow[] }) {
  const items: Array<
    { kind: "divider"; letter: string } | { kind: "row"; row: MethodScholarRow }
  > = [];
  let last = "";
  for (const row of hits) {
    const initial = methodScholarLastNameInitial(row.preferredName);
    if (initial !== last) {
      items.push({ kind: "divider", letter: initial });
      last = initial;
    }
    items.push({ kind: "row", row });
  }
  return (
    <ul className="mt-6 columns-1 gap-x-8 sm:columns-2 lg:columns-3">
      {items.map((item, i) =>
        item.kind === "divider" ? (
          <li
            key={`d-${item.letter}-${i}`}
            className="break-inside-avoid pt-3 pb-1 font-serif text-lg text-foreground first:pt-0"
          >
            {item.letter}
          </li>
        ) : (
          <ScholarRow key={item.row.cwid} scholar={item.row} />
        ),
      )}
    </ul>
  );
}
