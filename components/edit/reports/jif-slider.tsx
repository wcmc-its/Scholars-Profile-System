"use client";

/**
 * The "Minimum Journal Impact Factor" range input for report 8. Inside
 * `AutoSubmitForm` a range would submit on every drag tick (React's `onChange`
 * fires on `input`), so this stops that bubble and submits on the native
 * `change` (release) instead, showing the live value meanwhile.
 */
import { useEffect, useRef, useState } from "react";

export function JifSlider({ name, defaultValue, max }: { name: string; defaultValue: number; max: number }) {
  const [value, setValue] = useState(defaultValue);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const submit = () => el.form?.requestSubmit();
    el.addEventListener("change", submit);
    return () => el.removeEventListener("change", submit);
  }, []);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        type="range"
        name={name}
        min={0}
        max={max}
        step={1}
        value={value}
        aria-label="Minimum Journal Impact Factor"
        onChange={(e) => {
          e.stopPropagation();
          setValue(Number(e.currentTarget.value));
        }}
        className="w-full accent-[var(--color-primary-cornell-red)]"
      />
      <output className="w-16 shrink-0 text-[13px] tabular-nums" data-testid="jif-value">
        {value === 0 ? "None" : `≥ ${value}`}
      </output>
    </div>
  );
}
