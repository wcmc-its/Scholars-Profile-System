import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-border bg-zinc-50 dark:bg-zinc-950 mt-24 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div>Scholars @ Weill Cornell Medicine</div>
        <div className="flex items-center gap-4">
          <Link href="/support" className="hover:underline">
            Support
          </Link>
          <span className="text-xs">Phase 1 prototype</span>
        </div>
      </div>
    </footer>
  );
}
