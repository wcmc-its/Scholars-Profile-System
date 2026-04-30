export const dynamic = "force-static";
export const revalidate = false;

export const metadata = {
  title: "About — Scholars at WCM",
};

export default function AboutStubPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10 text-center">
      <h1 className="font-serif text-4xl font-semibold leading-tight">
        About Scholars at WCM
      </h1>
      <p className="mt-6 text-base">
        Methodology and algorithmic details are documented on the{" "}
        <a
          href="/about/methodology"
          className="text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
        >
          methodology page
        </a>
        .
      </p>
    </main>
  );
}
