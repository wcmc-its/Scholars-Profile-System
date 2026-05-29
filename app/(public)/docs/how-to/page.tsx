import type { Metadata } from "next";
import Link from "next/link";

/**
 * /docs/how-to index (v0 stub). Lists the procedural guides. Where a how-to
 * already has a corresponding answer in the question corpus, it links there;
 * full step-by-step pages are a post-launch build.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "How-to guides — Scholars docs",
  description:
    "Step-by-step guides: edit your overview, hide or restore a publication, request a personalized URL, and request a correction.",
  alternates: { canonical: "/docs/how-to" },
};

const LINK = "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

const GUIDES: { label: string; href?: string; note?: string }[] = [
  { label: "Request a correction", href: "/docs/q/request-a-correction" },
  {
    label: "Why a publication is (or isn't) on your profile, and how to hide it",
    href: "/docs/q/why-is-this-publication-on-my-profile",
  },
  { label: "Edit your overview text", note: "coming" },
  { label: "Hide or restore a publication", note: "coming" },
  { label: "Request a personalized profile URL", note: "coming" },
];

export default function HowToIndexPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">How-to guides</h1>
      <p className="mt-6 text-base text-muted-foreground">
        The things you can do yourself in Scholars, step by step. Most of your profile is assembled
        from source systems &mdash; see{" "}
        <Link href="/docs/data/sources" className={LINK}>
          where your data comes from
        </Link>{" "}
        for what&apos;s editable here versus at the source.
      </p>

      <ul className="mt-8 space-y-3">
        {GUIDES.map((guide) => (
          <li key={guide.label} className="text-base">
            {guide.href ? (
              <Link href={guide.href} className={LINK}>
                {guide.label}
              </Link>
            ) : (
              <span className="text-muted-foreground">
                {guide.label} <span className="text-sm">&mdash; {guide.note}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
