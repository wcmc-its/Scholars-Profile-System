/**
 * The "is this slug available?" checker for the slug registry (#497,
 * `/edit/slugs`). The one client island on the registry page: a small input +
 * button that calls `GET /api/edit/slugs?slug=…` and renders the live
 * `resolveSlugStatus` verdict, surfacing the holder's identity when taken.
 *
 * The verdict comes from the SAME format/reserved/collision checks the
 * `POST /api/edit/field` write path runs (server-side, reused — never
 * re-implemented), so what the checker says matches what an override write
 * would actually do.
 */
"use client";

import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SlugStatus } from "@/lib/api/slug-registry";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; status: SlugStatus }
  | { kind: "error" };

export function SlugAvailabilityChecker() {
  const [value, setValue] = React.useState("");
  const [state, setState] = React.useState<CheckState>({ kind: "idle" });

  async function check(e: React.FormEvent) {
    e.preventDefault();
    const slug = value.trim();
    if (slug.length === 0 || state.kind === "checking") return;
    setState({ kind: "checking" });
    try {
      const res = await fetch(`/api/edit/slugs?slug=${encodeURIComponent(slug)}`, {
        headers: { Accept: "application/json" },
      });
      const data = (await res.json()) as { ok: true; status: SlugStatus } | { ok: false };
      if (!res.ok || data.ok !== true) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "result", status: data.status });
    } catch {
      setState({ kind: "error" });
    }
  }

  return (
    <section
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="slug-availability-checker"
      aria-label="Check slug availability"
    >
      <form onSubmit={check} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="slug-check-input" className="text-sm font-medium">
            Is this slug available?
          </label>
          <Input
            id="slug-check-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. jane-q-smith"
            className="w-72"
            data-testid="slug-check-input"
            autoComplete="off"
          />
        </div>
        <Button
          type="submit"
          disabled={state.kind === "checking" || value.trim().length === 0}
          data-testid="slug-check-submit"
        >
          {state.kind === "checking" ? "Checking…" : "Check"}
        </Button>
      </form>

      {state.kind === "error" && (
        <Alert variant="destructive" className="mt-3" data-testid="slug-check-error">
          <AlertDescription>We couldn&apos;t check that slug. Please try again.</AlertDescription>
        </Alert>
      )}

      {state.kind === "result" && <Verdict status={state.status} />}
    </section>
  );
}

function Verdict({ status }: { status: SlugStatus }) {
  if (status.state === "available") {
    return (
      <Alert className="mt-3" data-testid="slug-check-result">
        <AlertDescription>
          <strong>{status.slug}</strong> is available.
        </AlertDescription>
      </Alert>
    );
  }

  let message: React.ReactNode;
  if (status.state === "invalid") {
    message =
      status.reason === "too_long"
        ? "Invalid: too long (max 64 characters)."
        : "Invalid shape: use lowercase letters, digits, and single hyphens.";
  } else if (status.state === "reserved") {
    message = (
      <>
        <strong>{status.slug}</strong> is unavailable — it&apos;s a reserved route word.
      </>
    );
  } else if (status.held === "live") {
    message = (
      <>
        <strong>{status.slug}</strong> is unavailable — held by{" "}
        {status.name ? `${status.name} (${status.cwid})` : status.cwid}.
      </>
    );
  } else if (status.held === "override") {
    message = (
      <>
        <strong>{status.slug}</strong> is unavailable — pinned by an override for {status.cwid}.
      </>
    );
  } else {
    message = (
      <>
        <strong>{status.slug}</strong> is unavailable — it&apos;s a former slug of{" "}
        {status.currentSlug ?? status.currentCwid}. Claiming it would break that redirect.
      </>
    );
  }

  return (
    <Alert variant="destructive" className="mt-3" data-testid="slug-check-result">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
