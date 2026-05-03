import { notFound } from "next/navigation";
import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";
import { ChairCard } from "@/components/department/chair-card";
import { DivisionsRail } from "@/components/department/divisions-rail";
import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";

export async function DepartmentPage({
  deptSlug,
  initialDivision,
  page,
}: {
  deptSlug: string;
  initialDivision: string | null;
  page: number;
}) {
  const detail = await getDepartment(deptSlug);
  if (!detail) notFound();

  // Resolve division if initialDivision is set; 404 on unknown.
  let activeDivision: (typeof detail.divisions)[number] | null = null;
  if (initialDivision !== null) {
    activeDivision = detail.divisions.find((d) => d.slug === initialDivision) ?? null;
    if (!activeDivision) notFound();
  }

  const faculty = await getDepartmentFaculty(detail.dept.code, {
    divCode: activeDivision?.code,
    page: Math.max(0, page - 1), // URL is 1-indexed; service is 0-indexed
  });

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      {/* Breadcrumbs per UI-SPEC §7 */}
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse">Browse</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse#departments">Departments</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.dept.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Hero */}
      <section className="mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          DEPARTMENT
        </div>
        <h1 className="mt-2 font-serif text-4xl font-semibold leading-tight">
          {detail.dept.name}
        </h1>
        {detail.dept.description && (
          <p className="mt-4 max-w-prose text-base text-muted-foreground">
            {detail.dept.description}
          </p>
        )}
      </section>

      {/* Chair card per UI-SPEC §6.5 — absence-as-default */}
      {detail.chair && <ChairCard chair={detail.chair} />}

      {/* Top research areas pill row per UI-SPEC §6.6 — absence-as-default when empty */}
      {detail.topResearchAreas.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Research areas</h2>
          <div className="flex flex-wrap gap-2">
            {detail.topResearchAreas.map((t) => (
              <a key={t.topicId} href={`/topics/${t.topicSlug}`}>
                <Badge
                  variant="outline"
                  className="rounded-full hover:bg-accent"
                >
                  {t.topicLabel}{" "}
                  <span className="ml-1 text-muted-foreground">
                    · {t.pubCount.toLocaleString()}
                  </span>
                </Badge>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Stats line per UI-SPEC §6.7 */}
      <div className="mt-6 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
        {[
          detail.stats.scholars > 0
            ? `${detail.stats.scholars.toLocaleString()} scholars`
            : null,
          detail.stats.divisions > 0
            ? `${detail.stats.divisions.toLocaleString()} divisions`
            : null,
          detail.stats.publications > 0
            ? `${detail.stats.publications.toLocaleString()} publications`
            : null,
          detail.stats.activeGrants > 0
            ? `${detail.stats.activeGrants.toLocaleString()} active grants`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      {/* Layout B: divisions rail + main column (faculty list) */}
      <div className="mt-12 flex flex-col gap-6 lg:flex-row lg:gap-8">
        {detail.divisions.length > 0 && (
          <div className="lg:w-[280px] lg:shrink-0 lg:sticky lg:top-[84px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
            <DivisionsRail
              deptSlug={detail.dept.slug}
              divisions={detail.divisions}
              activeDivisionSlug={activeDivision?.slug ?? null}
              totalScholars={detail.stats.scholars}
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Section header — division-specific or "Faculty" */}
          {activeDivision ? (
            <section className="mb-6">
              <h2 className="text-lg font-semibold">{activeDivision.name}</h2>
              {activeDivision.chiefName && activeDivision.chiefSlug && (
                <div className="mt-1 text-sm text-muted-foreground">
                  Chief:{" "}
                  <a
                    href={`/scholars/${activeDivision.chiefSlug}`}
                    className="text-[var(--color-accent-slate)] hover:underline"
                  >
                    {activeDivision.chiefName}
                  </a>
                </div>
              )}
              {activeDivision.description && (
                <p className="mt-2 max-w-prose text-base text-muted-foreground">
                  {activeDivision.description}
                </p>
              )}
            </section>
          ) : (
            <h2 className="mb-6 text-lg font-semibold">Faculty</h2>
          )}

          {/* Role chip row + person rows — interactive client wrapper */}
          <DepartmentFacultyClient
            faculty={faculty.hits}
            total={faculty.total}
            page={faculty.page + 1}
            pageSize={faculty.pageSize}
            deptSlug={detail.dept.slug}
            divisionSlug={activeDivision?.slug ?? null}
          />
        </div>
      </div>
    </main>
  );
}
