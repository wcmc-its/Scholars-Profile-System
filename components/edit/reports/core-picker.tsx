/**
 * "Viewing <core>" (mockup `Core pub review/Core Reports.dc.html`) — the one
 * core picker the reports index's Cores group (#2857) and the core report
 * pages' shared header both render. Controlled: the caller decides what a pick
 * does (the index swaps its group in place; a report page navigates). Without
 * JS the form GETs `action?center=<coreId>&kind=core`, which both pages read.
 * Its own line on a phone, the select shrinking to fit.
 */
"use client";

import * as React from "react";

export type CorePickerOption = { code: string; name: string };

export function CorePicker({
  options,
  value,
  onChange,
  action = "/edit/reports",
  id = "reports-index-core",
  testId = "reports-index-core-select",
}: {
  options: ReadonlyArray<CorePickerOption>;
  value: string;
  onChange: (code: string) => void;
  /** Where the no-JS form GETs to. */
  action?: string;
  id?: string;
  testId?: string;
}) {
  return (
    <form
      method="get"
      action={action}
      onSubmit={(e) => e.preventDefault()}
      className="text-muted-foreground flex w-full min-w-0 items-center gap-2 text-[13px] sm:w-auto"
    >
      <label htmlFor={id}>Viewing</label>
      <select
        id={id}
        name="center"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-apollo-border-strong bg-apollo-surface text-foreground h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-sm sm:max-w-[300px] sm:flex-none"
        data-testid={testId}
      >
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.name}
          </option>
        ))}
      </select>
      <input type="hidden" name="kind" value="core" />
      <noscript>
        <button type="submit" className="text-apollo-slate hover:underline">
          Go
        </button>
      </noscript>
    </form>
  );
}
