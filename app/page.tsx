export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Scholars @ Weill Cornell Medicine
      </h1>
      <p className="text-muted-foreground max-w-prose text-lg">
        Phase 1 prototype. Search interface, profiles, and ETL pipelines under construction.
      </p>
      <p className="text-muted-foreground text-sm">
        See <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">README.md</code>{" "}
        for build instructions.
      </p>
    </main>
  );
}
