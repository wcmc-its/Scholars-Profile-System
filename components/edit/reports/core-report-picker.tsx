/**
 * The core report pages' "Viewing" picker: the shared `CorePicker`, where a
 * pick navigates to the SAME report for the chosen core
 * (`<basePath>?center=<coreId>&kind=core`). A push, so Back returns to the
 * previous core. The report's own filters are dropped — they were chosen
 * against the previous core's data. Without JS the picker's form GETs the
 * same address.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { CorePicker, type CorePickerOption } from "@/components/edit/reports/core-picker";

export function CoreReportPicker({
  options,
  value,
  basePath,
}: {
  options: ReadonlyArray<CorePickerOption>;
  value: string;
  basePath: string;
}) {
  const router = useRouter();
  const [picked, setPicked] = React.useState(value);
  return (
    <CorePicker
      options={options}
      value={picked}
      action={basePath}
      id="core-reports-core"
      testId="core-reports-core-select"
      onChange={(code) => {
        setPicked(code);
        router.push(
          `${basePath}?${new URLSearchParams({ center: code, kind: "core" }).toString()}`,
        );
      }}
    />
  );
}
